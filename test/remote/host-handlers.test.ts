import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  createHostHandlers,
  type HostPtyManager,
  type HostRelaySocket
} from '../../src/main/remote/host-service'
import { OP } from '../../src/main/remote/framing'
import { RESUME_REPAINT_PREFIX } from '../../src/shared/capture-paint'
import type { DetachedSinks } from '../../src/main/pty-manager'
import type { PtyCreateOptions } from '../../src/shared/types'

// A fake pty-manager that records calls and lets the test fire the captured sinks.
function fakePty() {
  const calls: { method: string; args: unknown[] }[] = []
  let lastSinks: DetachedSinks | null = null
  let lastOptions: PtyCreateOptions | null = null
  let counter = 0
  let snapshot = ''
  let sessionLive = true
  // The relay attach is decided in core (`prepareRelayAttach`); this fake composes it from its own
  // probe/snapshot/attach so the sequence the host runs them in stays observable in `calls`.
  const mgr: HostPtyManager & {
    attachDetached(persistKey: string, sinks: DetachedSinks, options?: Omit<PtyCreateOptions, 'persistKey'>): string
    captureSnapshot(persistKey: string): Promise<string>
  } = {
    prepareRelayAttach: async (nodeId, size) => ({
      kind: 'ready',
      remote: false,
      sessionExists: () => mgr.sessionExists(nodeId),
      snapshot: () => mgr.captureSnapshot(nodeId),
      attach: async (sinks) => mgr.attachDetached(nodeId, sinks, size)
    }),
    createDetached(options, sinks) {
      lastOptions = options
      lastSinks = sinks
      const id = `pty-${++counter}`
      calls.push({ method: 'createDetached', args: [options, id] })
      return id
    },
    attachDetached(persistKey, sinks, options) {
      lastSinks = sinks
      const id = `pty-${++counter}`
      calls.push({ method: 'attachDetached', args: [persistKey, id, options] })
      return id
    },
    captureSnapshot: async (persistKey) => {
      calls.push({ method: 'captureSnapshot', args: [persistKey] })
      return snapshot
    },
    sessionExists: async (persistKey) => {
      calls.push({ method: 'sessionExists', args: [persistKey] })
      return sessionLive
    },
    write: (clientId, sessionId, data) =>
      calls.push({ method: 'write', args: [clientId, sessionId, data] }),
    resize: (clientId, sessionId, cols, rows) =>
      calls.push({ method: 'resize', args: [clientId, sessionId, cols, rows] }),
    // A relay-served (detached) pty has no ClientId: its pause is owed by the host's sink (null).
    setFlow: (clientId, sessionId, resume) =>
      calls.push({ method: 'setFlow', args: [clientId, sessionId, resume] }),
    // Relay-served ptys are killed with clientId null (they have no UI subscribers).
    kill: (clientId, sessionId) => calls.push({ method: 'kill', args: [clientId, sessionId] })
  }
  return {
    mgr,
    calls,
    sinks: () => lastSinks!,
    options: () => lastOptions!,
    setSnapshot: (s: string) => {
      snapshot = s
    },
    setSessionLive: (live: boolean) => {
      sessionLive = live
    }
  }
}

function fakeSocket(sendOk = true) {
  const responses: { id: string; ok: boolean; body: unknown }[] = []
  const frames: { op: number; streamId: number; seq: number; payload: Uint8Array }[] = []
  // `ok` / `buffered` are mutable so a test can stall the socket and then let it drain.
  const state = { ok: sendOk, buffered: 0 }
  const socket: HostRelaySocket = {
    respond: (id, ok, body) => responses.push({ id, ok, body }),
    sendFrame: (op, streamId, seq, payload) => {
      frames.push({ op, streamId, seq, payload })
      return state.ok
    },
    bufferedAmount: () => state.buffered
  }
  return { socket, responses, frames, state }
}

const resizePayload = (cols: number, rows: number) => {
  const buf = new Uint8Array(4)
  const view = new DataView(buf.buffer)
  view.setUint16(0, cols, true)
  view.setUint16(2, rows, true)
  return buf
}

// Open a stream the only way a remote client can: pty.attach to an existing session. Resolves
// once the async snapshot+attach has bound the sinks (sessionId 'pty-1'). Returns streamId 1.
async function openViaAttach(
  h: ReturnType<typeof createHostHandlers>,
  nodeId = 'node-1'
): Promise<void> {
  h.onRpc({ id: `open-${nodeId}`, method: 'pty.attach', params: { nodeId, cols: 80, rows: 24 } })
  await new Promise((r) => setTimeout(r, 0))
}

describe('createHostHandlers', () => {
  it('rejects pty.create — remote clients may only attach to existing sessions', () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)

    h.onRpc({ id: 'r1', method: 'pty.create', params: { cols: 100, rows: 30, cwd: '/', shell: '/bin/sh' } })

    expect(sock.responses[0]).toMatchObject({ id: 'r1', ok: false })
    expect(pty.calls.some((c) => c.method === 'createDetached')).toBe(false)
  })

  it('maps pty.attach to a snapshot sequence then attachDetached on the existing session', async () => {
    const pty = fakePty()
    pty.setSnapshot('CURRENT SCREEN')
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)

    h.onRpc({ id: 'r1', method: 'pty.attach', params: { nodeId: 'node-9', cols: 100, rows: 30 } })
    // The stream is reserved SYNCHRONOUSLY — that, not the timing of the response, is what lets
    // the host route this streamId's inbound frames right away. The response itself now waits on
    // the `fresh` probe (a tmux side-call), because whether the attach CREATED the session has to
    // be asked before `attachDetached` does it.
    h.onFrame({ op: OP.Input, streamId: 1, seq: 0, payload: new TextEncoder().encode('x') })
    expect(pty.calls.some((c) => c.method === 'write')).toBe(true)
    // Capture + attach are async (a tmux side-call).
    await new Promise((r) => setTimeout(r, 0))
    expect(sock.responses).toEqual([{ id: 'r1', ok: true, body: { streamId: 1, fresh: false } }])

    expect(pty.calls).toContainEqual({ method: 'captureSnapshot', args: ['node-9'] })
    expect(pty.calls).toContainEqual({
      method: 'attachDetached',
      args: ['node-9', 'pty-1', { cols: 100, rows: 30 }]
    })

    // Snapshot frames precede any live output: Start, one Chunk (the screen text), End.
    expect(sock.frames[0]).toMatchObject({ op: OP.SnapshotStart, streamId: 1 })
    expect(sock.frames[1]).toMatchObject({ op: OP.SnapshotChunk, streamId: 1 })
    expect(Buffer.from(sock.frames[1].payload).toString('utf8')).toBe('CURRENT SCREEN')
    expect(sock.frames[2]).toMatchObject({ op: OP.SnapshotEnd, streamId: 1 })

    // Live output then drives the same stream.
    pty.sinks().onData('live')
    const out = sock.frames.find((f) => f.op === OP.Output)
    expect(out).toBeDefined()
    expect(Buffer.from(out!.payload).toString('utf8')).toBe('live')
  })

  // A node whose tmux session died (host reboot, tmux server gone) still ATTACHES — the client
  // needs a live pane to type its cold restore (`cd <cwd>; claude --resume <id>`) into, exactly as
  // the SSH path gets one from `tmux new-session -A`. What changed is that the reply now SAYS it
  // was a cold start, so the client runs that restore instead of presenting the bare login shell
  // under the node's title, which is what a phone saw as `~ %` on a Claude session.
  it('still creates on a cold node, but reports fresh=true so the client can restore', async () => {
    const pty = fakePty()
    pty.setSessionLive(false)
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)

    h.onRpc({ id: 'r1', method: 'pty.attach', params: { nodeId: 'cold-1', cols: 80, rows: 24 } })
    await new Promise((r) => setTimeout(r, 0))

    expect(sock.responses).toEqual([{ id: 'r1', ok: true, body: { streamId: 1, fresh: true } }])
    // Deliberately NOT a refusal: refusing would leave the client with nowhere to resume.
    expect(pty.calls).toContainEqual({
      method: 'attachDetached',
      args: ['cold-1', 'pty-1', { cols: 80, rows: 24 }]
    })
  })

  it('attach sends an empty snapshot when the session has no current screen', async () => {
    const pty = fakePty() // snapshot defaults to ''
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)

    h.onRpc({ id: 'r1', method: 'pty.attach', params: { nodeId: 'node-1', cols: 80, rows: 24 } })
    await new Promise((r) => setTimeout(r, 0))

    // Empty snapshot: Start, End, no Chunk.
    expect(sock.frames.map((f) => f.op)).toContain(OP.SnapshotStart)
    expect(sock.frames.map((f) => f.op)).toContain(OP.SnapshotEnd)
    expect(sock.frames.some((f) => f.op === OP.SnapshotChunk)).toBe(false)
    expect(pty.calls).toContainEqual({
      method: 'attachDetached',
      args: ['node-1', 'pty-1', { cols: 80, rows: 24 }]
    })
  })

  it('rejects pty.attach without a nodeId', () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    h.onRpc({ id: 'r1', method: 'pty.attach', params: { cols: 80, rows: 24 } })
    expect(sock.responses[0]).toMatchObject({ id: 'r1', ok: false })
  })

  it('pipes PTY output into OP.Output frames with an incrementing seq', async () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    await openViaAttach(h)

    pty.sinks().onData('hello')
    pty.sinks().onData('world')

    const outs = sock.frames.filter((f) => f.op === OP.Output)
    expect(outs).toHaveLength(2)
    expect(outs[0]).toMatchObject({ op: OP.Output, streamId: 1 })
    expect(Buffer.from(outs[0].payload).toString('utf8')).toBe('hello')
    expect(outs[1].seq).toBe(outs[0].seq + 1) // monotonic
  })

  it('routes OP.Input frames to write and OP.Resize frames to resize', async () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    await openViaAttach(h)

    h.onFrame({ op: OP.Input, streamId: 1, seq: 0, payload: new TextEncoder().encode('ls\n') })
    h.onFrame({ op: OP.Resize, streamId: 1, seq: 0, payload: resizePayload(120, 40) })

    // No presence slot wired (getClientId defaults to null) → the input still reaches the pty, it
    // is simply not attributed to a typing peer.
    expect(pty.calls).toContainEqual({ method: 'write', args: [null, 'pty-1', 'ls\n'] })
    // clientId null: the relay-served pty's size is recorded against its sink, not a UI client.
    expect(pty.calls).toContainEqual({ method: 'resize', args: [null, 'pty-1', 120, 40] })
  })

  it('attributes an OP.Input frame to the bridged phone (typing badge, no iOS change needed)', async () => {
    const pty = fakePty()
    const sock = fakeSocket()
    // The phone's presence ClientId, read per frame from its PhonePresence slot (joined on bridge).
    const h = createHostHandlers(pty.mgr, sock.socket, undefined, undefined, undefined, () => 1_000_001)
    await openViaAttach(h)

    h.onFrame({ op: OP.Input, streamId: 1, seq: 0, payload: new TextEncoder().encode('ls\n') })

    expect(pty.calls).toContainEqual({ method: 'write', args: [1_000_001, 'pty-1', 'ls\n'] })
  })

  it('ignores frames for unknown streams', () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    h.onFrame({ op: OP.Input, streamId: 99, seq: 0, payload: new TextEncoder().encode('x') })
    expect(pty.calls).toHaveLength(0)
  })

  // A paused node-pty emits NO further onData, so a resume that waits for
  // "the next successful send" never comes and the phone's terminal froze for good after one >8 MB
  // burst. These tests deliver nothing after the pause — the drain sweep alone must resume it.
  describe('relay backpressure: the drain sweep resumes a paused stream', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    const resumes = (pty: ReturnType<typeof fakePty>) =>
      pty.calls.filter((c) => c.method === 'setFlow' && c.args[2] === true)

    async function pausedStream(screen = 'SCREEN') {
      const pty = fakePty()
      pty.setSnapshot(screen)
      const sock = fakeSocket()
      const h = createHostHandlers(pty.mgr, sock.socket)
      await openViaAttach(h)
      vi.useFakeTimers()
      sock.state.ok = false // the relay buffer is over 8 MB: sendFrame refuses (and drops)
      sock.state.buffered = 9_000_000
      pty.sinks().onData('a')
      expect(pty.calls).toContainEqual({ method: 'setFlow', args: [null, 'pty-1', false] })
      return { pty, sock, h }
    }

    it('resumes once drained, with no further pty output, and repaints BEFORE resuming', async () => {
      const { pty, sock } = await pausedStream()
      const order: string[] = []
      sock.socket.sendFrame = (op) => {
        order.push(`frame:${op}`)
        return true
      }
      const realSetFlow = pty.mgr.setFlow
      pty.mgr.setFlow = (...args) => {
        order.push(`setFlow:${String(args[2])}`)
        realSetFlow(...args)
      }
      sock.state.ok = true
      sock.state.buffered = 0 // drained — and the paused pty delivers NOTHING

      await vi.advanceTimersByTimeAsync(300)

      expect(resumes(pty)).toEqual([{ method: 'setFlow', args: [null, 'pty-1', true] }])
      // A fresh screen (the frame that crossed the line was dropped), and only then live output.
      expect(order).toEqual([
        `frame:${OP.SnapshotStart}`,
        `frame:${OP.SnapshotChunk}`,
        `frame:${OP.SnapshotEnd}`,
        'setFlow:true'
      ])
      expect(vi.getTimerCount()).toBe(0) // the sweep disarms once nothing is paused
    })

    const resumePayload = (sock: ReturnType<typeof fakeSocket>, from: number): string => {
      const start = sock.frames.findIndex((f, i) => i >= from && f.op === OP.SnapshotStart)
      expect(start).toBeGreaterThanOrEqual(0)
      const chunks: string[] = []
      for (let i = start + 1; i < sock.frames.length && sock.frames[i].op === OP.SnapshotChunk; i++) {
        chunks.push(Buffer.from(sock.frames[i].payload).toString('utf8'))
      }
      return chunks.join('')
    }

    it('the resume repaint clears and homes first and paints with CRLF line endings', async () => {
      // The phone feeds a snapshot into its emulator as-is, with no reset, and the frame that
      // crossed the 8 MB line was dropped: written raw, the capture lands at the phone's current
      // cursor over the old screen, and its bare LFs staircase (SwiftTerm runs convertEol off).
      const { sock } = await pausedStream('row one\nrow two\n')
      sock.state.ok = true
      sock.state.buffered = 0
      const from = sock.frames.length
      await vi.advanceTimersByTimeAsync(300)
      const payload = resumePayload(sock, from)
      expect(payload.startsWith(RESUME_REPAINT_PREFIX)).toBe(true)
      expect(RESUME_REPAINT_PREFIX).toContain('\x1b[H\x1b[2J')
      // One trailing newline dropped (it would scroll the top row away), every LF made CRLF.
      expect(payload).toBe(RESUME_REPAINT_PREFIX + 'row one\r\nrow two')
    })

    it('the resume repaint puts the cursor where the pane has it when the capture says', async () => {
      const pty = fakePty()
      pty.setSnapshot('ATTACH SCREEN\n')
      const visible: string[] = []
      ;(pty.mgr as HostPtyManager).captureVisible = async (sessionId) => {
        visible.push(sessionId)
        return { screen: 'prompt $ \nstatus\n', cursor: { x: 9, y: 0 } }
      }
      const sock = fakeSocket()
      const h = createHostHandlers(pty.mgr, sock.socket)
      await openViaAttach(h)
      // The attach snapshot is byte-identical to before: the raw capture, no prefix, no cursor.
      expect(Buffer.from(sock.frames[1].payload).toString('utf8')).toBe('ATTACH SCREEN\n')
      vi.useFakeTimers()
      sock.state.ok = false
      sock.state.buffered = 9_000_000
      pty.sinks().onData('a')
      sock.state.ok = true
      sock.state.buffered = 0
      const from = sock.frames.length
      await vi.advanceTimersByTimeAsync(300)
      expect(visible).toEqual(['pty-1'])
      expect(resumePayload(sock, from)).toBe(RESUME_REPAINT_PREFIX + 'prompt $ \r\nstatus' + '\x1b[1;10H')
    })

    it('an unavailable visible capture falls back to the attach capture, with no cursor', async () => {
      const pty = fakePty()
      pty.setSnapshot('FALLBACK\n')
      ;(pty.mgr as HostPtyManager).captureVisible = async () => ({ screen: '', cursor: null, unavailable: true })
      const sock = fakeSocket()
      const h = createHostHandlers(pty.mgr, sock.socket)
      await openViaAttach(h)
      vi.useFakeTimers()
      sock.state.ok = false
      sock.state.buffered = 9_000_000
      pty.sinks().onData('a')
      sock.state.ok = true
      sock.state.buffered = 0
      const from = sock.frames.length
      await vi.advanceTimersByTimeAsync(300)
      expect(resumePayload(sock, from)).toBe(RESUME_REPAINT_PREFIX + 'FALLBACK')
    })

    it('stays paused while the socket is above the low-water mark', async () => {
      const { pty, sock } = await pausedStream()
      sock.state.ok = true
      sock.state.buffered = 1_000_000 // draining, but not below 256 KB yet

      await vi.advanceTimersByTimeAsync(2_000)
      expect(resumes(pty)).toEqual([])

      sock.state.buffered = 100_000
      await vi.advanceTimersByTimeAsync(300)
      expect(resumes(pty)).toHaveLength(1)
    })

    it('drops output still queued after the pause instead of streaming a desynced screen', async () => {
      const { pty, sock } = await pausedStream()
      const outputs = () => sock.frames.filter((f) => f.op === OP.Output).length
      const before = outputs()
      pty.sinks().onData('late batch') // the one queueData batch already in flight
      expect(outputs()).toBe(before)
    })

    it('an empty capture still resumes (no repaint) rather than staying frozen', async () => {
      const { pty, sock } = await pausedStream('')
      sock.state.ok = true
      sock.state.buffered = 0
      const framesBefore = sock.frames.length

      await vi.advanceTimersByTimeAsync(300)

      expect(resumes(pty)).toHaveLength(1)
      expect(sock.frames.slice(framesBefore).some((f) => f.op === OP.SnapshotStart)).toBe(false)
    })

    it('a snapshot the socket refuses keeps the stream paused and retries with backoff', async () => {
      const { pty, sock } = await pausedStream()
      const captures = () => pty.calls.filter((c) => c.method === 'captureSnapshot').length
      const capturesAtPause = captures()
      // Reports drained, but every send fails — what a relay between transports looks like
      // (bufferedAmount 0, state not ready). Must not become a capture per tick.
      sock.state.buffered = 0
      await vi.advanceTimersByTimeAsync(5_000)
      expect(resumes(pty)).toEqual([])
      // 250 ms ticks for 5 s would be 20 captures; the backoff (250, 500, 1 s, 2 s …) allows ~5.
      expect(captures() - capturesAtPause).toBeLessThanOrEqual(6)

      sock.state.ok = true
      await vi.advanceTimersByTimeAsync(10_500)
      expect(resumes(pty)).toHaveLength(1)
    })

    it('closeAll while paused disarms the sweep and never resumes the released pty', async () => {
      const { pty, sock, h } = await pausedStream()
      h.closeAll()
      expect(vi.getTimerCount()).toBe(0)
      sock.state.ok = true
      sock.state.buffered = 0
      await vi.advanceTimersByTimeAsync(1_000)
      expect(resumes(pty)).toEqual([])
    })

    it('pty.kill while paused disarms the sweep', async () => {
      const { h } = await pausedStream()
      h.onRpc({ id: 'k', method: 'pty.kill', params: { streamId: 1 } })
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('rejects unknown RPC methods', () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    h.onRpc({ id: 'r9', method: 'pty.bogus', params: {} })
    expect(sock.responses[0]).toMatchObject({ id: 'r9', ok: false })
  })

  it('pty.kill kills the session and forgets the stream', async () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    await openViaAttach(h)
    h.onRpc({ id: 'r2', method: 'pty.kill', params: { streamId: 1 } })

    expect(pty.calls).toContainEqual({ method: 'kill', args: [null, 'pty-1'] })
    // After kill, input for the dropped stream is ignored.
    pty.calls.length = 0
    h.onFrame({ op: OP.Input, streamId: 1, seq: 0, payload: new TextEncoder().encode('x') })
    expect(pty.calls).toHaveLength(0)
  })

  it('emits an OP.Error frame on PTY exit and drops the stream', async () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    await openViaAttach(h)

    pty.sinks().onExit(0)
    const errFrame = sock.frames.find((f) => f.op === OP.Error)
    expect(errFrame).toBeDefined()
    expect(JSON.parse(Buffer.from(errFrame!.payload).toString('utf8'))).toEqual({ exitCode: 0 })
  })

  it('closeAll kills every live session', async () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    await openViaAttach(h, 'node-1')
    await openViaAttach(h, 'node-2')
    h.closeAll()
    expect(pty.calls.filter((c) => c.method === 'kill')).toHaveLength(2)
  })
})
