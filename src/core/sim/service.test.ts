import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import type { SimStatus } from '../../shared/sim'
import { ACK_STALL_MS, SIM_GRACE_MS, createSimService, toDeviceInfo, type SimServiceDeps } from './service'
import type { HelperChild } from './helper-process'

const UDID = 'AE342EEF-B624-4060-B9E6-AE6E9EAAC24A'
const OTHER = '11111111-2222-3333-4444-555555555555'

const framed = (type: number, payload: Buffer): Buffer => {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(payload.length + 1, 0)
  head[4] = type
  return Buffer.concat([head, payload])
}

/** A stand-in for the `sim-helper attach` process: records what is written to stdin, speaks the framing. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  written: string[] = []
  killed: string[] = []
  ended = false
  pid = 4242
  /** Auto-reply to these commands (by `cmd`), the way the real helper does. */
  replies = new Map<string, Record<string, unknown>>()
  stdin = {
    write: (chunk: string): boolean => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        this.written.push(line)
        const req = JSON.parse(line) as { id?: number; cmd: string; quiet?: boolean }
        if (req.cmd === 'quit') queueMicrotask(() => this.exit(0))
        const reply = this.replies.get(req.cmd)
        if (reply && req.id !== undefined && !req.quiet) this.json({ id: req.id, ok: true, ...reply })
      }
      return true
    },
    end: (): void => {
      this.ended = true
    },
    on: (): void => undefined
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? 'SIGTERM')
    return true
  }
  json(o: unknown): void {
    this.stdout.emit('data', framed(2, Buffer.from(JSON.stringify(o))))
  }
  event(o: Record<string, unknown>): void {
    this.json(o)
  }
  frame(n = 3, w = 4, h = 8): void {
    const p = Buffer.alloc(12 + n, 9)
    p.writeUInt16BE(w, 8)
    p.writeUInt16BE(h, 10)
    this.stdout.emit('data', framed(1, p))
  }
  image(imageId: number): void {
    const body = Buffer.alloc(9 + 2)
    body.writeUInt32BE(imageId, 0)
    body[4] = 2
    body.writeUInt16BE(10, 5)
    body.writeUInt16BE(20, 7)
    this.stdout.emit('data', framed(3, body))
  }
  exit(code: number | null, signal: string | null = null): void {
    this.emit('exit', code, signal)
  }
  /** The commands written so far, parsed. */
  cmds(): Array<Record<string, unknown>> {
    return this.written.map((l) => JSON.parse(l))
  }
  last(cmd: string): Record<string, unknown> | undefined {
    return this.cmds().filter((c) => c.cmd === cmd).pop()
  }
}

const DEVICE = { udid: UDID, name: 'iPhone 15', runtime: 'iOS 26.5', state: 'Booted', pixelWidth: 1179, pixelHeight: 2556, pointWidth: 393, pointHeight: 852, scale: 3, ready: true }

interface Rig {
  svc: ReturnType<typeof createSimService>
  children: FakeChild[]
  sent: Array<{ to: number; channel: string; args: unknown[] }>
  deps: SimServiceDeps
  clients: number[]
  frames: (to?: number) => number
  statuses: (to?: number) => SimStatus[]
}

function rig(over: Partial<SimServiceDeps> = {}): Rig {
  const children: FakeChild[] = []
  const sent: Rig['sent'] = []
  const clients = [1]
  const deps: SimServiceDeps = {
    isDarwin: true,
    helperPath: () => '/fake/sim-helper',
    spawn: () => {
      const c = new FakeChild()
      c.replies.set('info', { device: { ...DEVICE, state: 'Shutdown', ready: false } })
      children.push(c)
      return c as unknown as HelperChild
    },
    listDevices: async () => ({ devices: [] }),
    boot: async () => ({ ok: true }),
    send: (to, channel, ...args) => void sent.push({ to, channel, args }),
    clientIds: () => clients,
    log: () => undefined,
    ...over
  }
  const svc = createSimService(deps)
  return {
    svc,
    children,
    sent,
    deps,
    clients,
    frames: (to) => sent.filter((s) => s.channel === IPC.simFrame(UDID) && (to === undefined || s.to === to)).length,
    statuses: (to) =>
      sent.filter((s) => s.channel === IPC.simStatus(UDID) && (to === undefined || s.to === to)).map((s) => s.args[0] as SimStatus)
  }
}

const ACTIVE = { level: 'active', scale: 0.5 }
/** Let the async start (`await entry.gone`) and the info round trip settle. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('availability', () => {
  it('is unsupported off macOS and spawns nothing', async () => {
    const r = rig({ isDarwin: false })
    expect(r.svc.availability()).toMatchObject({ ok: false, code: 'unsupported' })
    expect(r.svc.attach(1, UDID, 'n1', ACTIVE)).toMatchObject({ phase: 'error', error: { code: 'unsupported' } })
    await settle()
    expect(r.children).toHaveLength(0)
    expect(await r.svc.devices()).toEqual({ devices: [] })
  })
  it('names a missing helper binary, and never spawns', async () => {
    const r = rig({ helperPath: () => null })
    expect(r.svc.availability()).toMatchObject({ ok: false, code: 'no-helper' })
    expect(r.svc.attach(1, UDID, 'n1', ACTIVE)).toMatchObject({ error: { code: 'no-helper' } })
    await settle()
    expect(r.children).toHaveLength(0)
  })
  it('refuses a malformed device or viewer id before touching anything', async () => {
    const r = rig()
    expect(r.svc.attach(1, 'not-a-udid', 'n1', ACTIVE)).toMatchObject({ error: { code: 'device-not-found' } })
    expect(r.svc.attach(1, UDID, '../escape', ACTIVE)).toMatchObject({ phase: 'error' })
    await settle()
    expect(r.children).toHaveLength(0)
    expect(r.svc.activeDevices()).toEqual([])
  })
})

describe('refcounted lifecycle', () => {
  it('starts ONE helper for any number of viewers of a device, in any window', async () => {
    const r = rig()
    r.clients.push(2)
    expect(r.svc.attach(1, UDID, 'a', ACTIVE).phase).toBe('connecting')
    r.svc.attach(1, UDID, 'b', ACTIVE)
    r.svc.attach(2, UDID, 'a', ACTIVE)
    await settle()
    expect(r.children).toHaveLength(1)
    expect(r.children[0].written[0]).toBeDefined()
    expect(r.svc.activeDevices()).toEqual([UDID])
  })
  it('dropSender releases every viewer of a page that went away, then stops the helper after the grace', async () => {
    const r = rig()
    r.clients.push(2)
    r.svc.attach(1, UDID, 'a', ACTIVE)
    r.svc.attach(1, UDID, 'b', ACTIVE)
    r.svc.attach(2, UDID, 'a', ACTIVE)
    await settle()
    const child = r.children[0]
    r.svc.dropSender(1)
    await vi.advanceTimersByTimeAsync(SIM_GRACE_MS * 3)
    expect(child.last('quit')).toBeUndefined() // window 2 still watches
    r.svc.dropSender(2)
    await vi.advanceTimersByTimeAsync(SIM_GRACE_MS + 1)
    expect(child.last('quit')).toBeDefined()
  })
  it('runs a separate helper per device', async () => {
    const r = rig()
    r.svc.attach(1, UDID, 'a', ACTIVE)
    r.svc.attach(1, OTHER, 'b', ACTIVE)
    await settle()
    expect(r.children).toHaveLength(2)
  })
  it('keeps the helper while any viewer remains, and quits it only after the last leaves + the grace', async () => {
    const r = rig()
    r.svc.attach(1, UDID, 'a', ACTIVE)
    r.svc.attach(1, UDID, 'b', ACTIVE)
    await settle()
    const child = r.children[0]
    r.svc.detach(1, UDID, 'a')
    await vi.advanceTimersByTimeAsync(SIM_GRACE_MS * 3)
    expect(child.last('quit')).toBeUndefined()
    r.svc.detach(1, UDID, 'b')
    await vi.advanceTimersByTimeAsync(SIM_GRACE_MS - 1)
    expect(child.last('quit')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2)
    expect(child.last('quit')).toBeDefined()
    expect(child.ended).toBe(true)
    await settle()
    expect(r.svc.activeDevices()).toEqual([])
  })
  it('a re-attach inside the grace keeps the same helper (a project switch is not a restart)', async () => {
    const r = rig()
    r.svc.attach(1, UDID, 'a', ACTIVE)
    await settle()
    r.svc.detach(1, UDID, 'a')
    await vi.advanceTimersByTimeAsync(SIM_GRACE_MS - 500)
    r.svc.attach(1, UDID, 'a', ACTIVE)
    await vi.advanceTimersByTimeAsync(SIM_GRACE_MS * 2)
    expect(r.children).toHaveLength(1)
    expect(r.children[0].last('quit')).toBeUndefined()
  })
  it('waits for a stopping helper to be GONE before starting the next (the per-device lock)', async () => {
    const r = rig()
    r.svc.attach(1, UDID, 'a', ACTIVE)
    await settle()
    const first = r.children[0]
    // Make the old helper slow to die: it ignores `quit`.
    first.stdin.write = (chunk: string): boolean => {
      first.written.push(chunk.trim())
      return true
    }
    r.svc.detach(1, UDID, 'a')
    await vi.advanceTimersByTimeAsync(SIM_GRACE_MS + 1)
    r.svc.attach(1, UDID, 'a', ACTIVE)
    await settle()
    expect(r.children).toHaveLength(1) // not yet: the old process still holds the device lock
    first.exit(0)
    await settle()
    expect(r.children).toHaveLength(2)
  })
  it('escalates quit → SIGTERM → SIGKILL for a helper that will not leave', async () => {
    const r = rig()
    r.svc.attach(1, UDID, 'a', ACTIVE)
    await settle()
    const child = r.children[0]
    child.stdin.write = (): boolean => true
    r.svc.detach(1, UDID, 'a')
    await vi.advanceTimersByTimeAsync(SIM_GRACE_MS + 1)
    expect(child.killed).toEqual([])
    await vi.advanceTimersByTimeAsync(1_600)
    expect(child.killed).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(1_600)
    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL'])
  })
  it('drops the viewers of a window that is gone, and idles the helper', async () => {
    const r = rig()
    r.clients.push(2)
    r.svc.attach(2, UDID, 'a', ACTIVE)
    await settle()
    r.clients.splice(r.clients.indexOf(2), 1) // window 2 closed without detaching
    r.children[0].event({ event: 'ready', device: DEVICE })
    await vi.advanceTimersByTimeAsync(SIM_GRACE_MS + 1)
    expect(r.children[0].last('quit')).toBeDefined()
  })
  it('dispose quits every helper at once', async () => {
    const r = rig()
    r.svc.attach(1, UDID, 'a', ACTIVE)
    r.svc.attach(1, OTHER, 'b', ACTIVE)
    await settle()
    const done = r.svc.dispose()
    await settle()
    await done
    expect(r.children.every((c) => c.last('quit'))).toBe(true)
    expect(r.svc.activeDevices()).toEqual([])
  })
})

describe('status', () => {
  it('goes connecting → shutdown (from device-state) → live (from ready), pushed to the window', async () => {
    const r = rig()
    r.svc.attach(1, UDID, 'a', ACTIVE)
    await settle()
    const c = r.children[0]
    c.event({ event: 'device-state', state: 'Shutdown', booted: false })
    expect(r.statuses().at(-1)).toMatchObject({ phase: 'shutdown' })
    c.event({ event: 'device-state', state: 'Booting', booted: false })
    expect(r.statuses().at(-1)?.phase).toBe('connecting')
    c.event({ event: 'ready', device: DEVICE })
    expect(r.statuses().at(-1)).toMatchObject({ phase: 'live', device: { name: 'iPhone 15', pointWidth: 393, ready: true } })
    c.event({ event: 'device-state', state: 'Shutting Down', booted: false })
    expect(r.statuses().at(-1)?.phase).toBe('shutdown')
  })
  it('fills in the device name before the device is ready, from `info`', async () => {
    const r = rig()
    r.svc.attach(1, UDID, 'a', ACTIVE)
    await settle()
    r.children[0].event({ event: 'device-state', state: 'Shutdown', booted: false })
    await settle()
    expect(r.statuses().at(-1)).toMatchObject({ phase: 'shutdown', device: { name: 'iPhone 15', ready: false } })
  })
  it('keeps a fatal helper error through the exit that follows it', async () => {
    const r = rig()
    r.svc.attach(1, UDID, 'a', ACTIVE)
    await settle()
    const c = r.children[0]
    c.event({ event: 'error', code: 'already-attached', message: 'held by pid 99', fatal: true })
    c.exit(3)
    expect(r.statuses().at(-1)).toMatchObject({ phase: 'error', error: { code: 'already-attached', message: 'held by pid 99' } })
  })
  it('reports an unexplained exit as helper-exited, with the log tail; Reconnect (attach again) respawns', async () => {
    const r = rig()
    r.svc.attach(1, UDID, 'a', ACTIVE)
    await settle()
    r.children[0].stderr.emit('data', Buffer.from('boom: something broke\n'))
    r.children[0].exit(139)
    const status = r.statuses().at(-1)
    expect(status).toMatchObject({ phase: 'error', error: { code: 'helper-exited' } })
    expect(status?.error?.message).toContain('boom: something broke')
    expect(r.svc.attach(1, UDID, 'a', ACTIVE).phase).toBe('connecting')
    await settle()
    expect(r.children).toHaveLength(2)
  })
  it('maps the helper exit codes it documents when no error event came first', async () => {
    for (const [code, expected] of [[4, 'device-not-found'], [5, 'no-xcode'], [3, 'already-attached']] as const) {
      const r = rig()
      r.svc.attach(1, UDID, 'a', ACTIVE)
      await settle()
      r.children[0].exit(code)
      expect(r.statuses().at(-1)?.error?.code).toBe(expected)
    }
  })
  it('reports a spawn failure', async () => {
    const r = rig({
      spawn: () => {
        throw new Error('spawn EACCES')
      }
    })
    r.svc.attach(1, UDID, 'a', ACTIVE)
    await settle()
    expect(r.statuses().at(-1)).toMatchObject({ phase: 'error', error: { code: 'spawn-failed', message: 'spawn EACCES' } })
  })
  it('treats setup-failed as a notice over the current phase, cleared by ready', async () => {
    const r = rig()
    r.svc.attach(1, UDID, 'a', ACTIVE)
    await settle()
    const c = r.children[0]
    c.event({ event: 'error', code: 'setup-failed', message: 'no display port yet' })
    expect(r.statuses().at(-1)).toMatchObject({ phase: 'connecting', error: { code: 'setup-failed' } })
    c.event({ event: 'ready', device: DEVICE })
    expect(r.statuses().at(-1)?.error).toBeUndefined()
  })
})

describe('frames: newest wins, never a backlog', () => {
  async function live(): Promise<{ r: Rig; c: FakeChild }> {
    const r = rig()
    r.svc.attach(1, UDID, 'a', ACTIVE)
    await settle()
    const c = r.children[0]
    c.event({ event: 'ready', device: DEVICE })
    return { r, c }
  }
  it('sends two, holds only the newest of the rest, and releases it on the next ack', async () => {
    const { r, c } = await live()
    for (let i = 0; i < 6; i++) c.frame(3 + i)
    expect(r.frames(1)).toBe(2)
    r.svc.ackFrame(1, UDID)
    expect(r.frames(1)).toBe(3)
    const lastSent = r.sent.filter((s) => s.channel === IPC.simFrame(UDID)).at(-1)!.args[0] as Buffer
    expect(lastSent.length).toBe(12 + 8) // the NEWEST (6th, 3+5 bytes), not the 3rd
    r.svc.ackFrame(1, UDID)
    expect(r.frames(1)).toBe(3) // nothing was waiting any more
  })
  it('two nodes in one window: a second attach keeps the credit, and credit returns once per frame', async () => {
    const { r, c } = await live()
    c.frame()
    c.frame()
    expect(r.frames(1)).toBe(2) // both frames in flight
    r.svc.attach(1, UDID, 'b', ACTIVE) // a second node, same window: must not wipe the in-flight count
    c.frame()
    expect(r.frames(1)).toBe(2) // still no spare credit (a reset would have let a fresh pair through)
    r.svc.ackFrame(1, UDID) // node a answers frame 1: node b has not, so no credit yet
    expect(r.frames(1)).toBe(2)
    r.svc.ackFrame(1, UDID) // node b answers frame 1: credit returns once, releasing the held frame
    expect(r.frames(1)).toBe(3)
  })
  it('lets frames through again when an ack was lost', async () => {
    const { r, c } = await live()
    c.frame()
    c.frame()
    c.frame()
    expect(r.frames(1)).toBe(2)
    await vi.advanceTimersByTimeAsync(ACK_STALL_MS + 1)
    c.frame()
    expect(r.frames(1)).toBe(3)
  })
  it('gives each window its own credit', async () => {
    const r = rig()
    r.clients.push(2)
    r.svc.attach(1, UDID, 'a', ACTIVE)
    r.svc.attach(2, UDID, 'a', ACTIVE)
    await settle()
    r.children[0].event({ event: 'ready', device: DEVICE })
    for (let i = 0; i < 4; i++) r.children[0].frame()
    expect(r.frames(1)).toBe(2)
    expect(r.frames(2)).toBe(2)
    r.svc.ackFrame(2, UDID)
    expect(r.frames(1)).toBe(2)
    expect(r.frames(2)).toBe(3)
  })
  it('shows a viewer that joins a static screen the last frame at once', async () => {
    const { r, c } = await live()
    c.frame()
    r.clients.push(2)
    r.svc.attach(2, UDID, 'late', ACTIVE)
    expect(r.frames(2)).toBe(1)
  })
  it('forgets the last frame when the device shuts down', async () => {
    const { r, c } = await live()
    c.frame()
    c.event({ event: 'device-state', state: 'Shutdown', booted: false })
    r.clients.push(2)
    r.svc.attach(2, UDID, 'late', ACTIVE)
    expect(r.frames(2)).toBe(0)
  })
  it('ignores an ack from a window that holds nothing', async () => {
    const { r } = await live()
    expect(() => r.svc.ackFrame(77, UDID)).not.toThrow()
    expect(() => r.svc.ackFrame(1, 'nonsense')).not.toThrow()
  })
})

describe('stream policy', () => {
  it('streams at 60 fps when watched, a trickle in the background, and stops when nobody watches', async () => {
    const r = rig()
    r.svc.attach(1, UDID, 'a', { level: 'active', scale: 0.5 })
    await settle()
    const c = r.children[0]
    expect(c.last('stream')).toMatchObject({ on: true, maxFps: 60, scale: 0.5, quality: 0.7, quiet: true })
    r.svc.setView(1, UDID, 'a', { level: 'background', scale: 0.5 })
    expect(c.last('stream')).toMatchObject({ on: true, maxFps: 8 })
    r.svc.setView(1, UDID, 'a', { level: 'off' })
    expect(c.last('stream')).toMatchObject({ on: false })
    const streams = c.cmds().filter((x) => x.cmd === 'stream').length
    r.svc.setView(1, UDID, 'a', { level: 'off' })
    expect(c.cmds().filter((x) => x.cmd === 'stream').length).toBe(streams) // unchanged → not re-sent
  })
  it('lets the busiest viewer decide', async () => {
    const r = rig()
    r.svc.attach(1, UDID, 'hidden', { level: 'off' })
    r.svc.attach(1, UDID, 'watching', { level: 'active', scale: 0.8 })
    await settle()
    expect(r.children[0].last('stream')).toMatchObject({ on: true, maxFps: 60, scale: 0.8 })
    r.svc.detach(1, UDID, 'watching')
    expect(r.children[0].last('stream')).toMatchObject({ on: false })
  })
  it('re-asserts the stream when the helper reports ready (it re-registers after a recovery)', async () => {
    const r = rig()
    r.svc.attach(1, UDID, 'a', ACTIVE)
    await settle()
    const before = r.children[0].cmds().filter((x) => x.cmd === 'stream').length
    r.children[0].event({ event: 'ready', device: DEVICE })
    expect(r.children[0].cmds().filter((x) => x.cmd === 'stream').length).toBe(before + 1)
  })
})

describe('commands', () => {
  async function live(): Promise<{ r: Rig; c: FakeChild }> {
    const r = rig()
    r.svc.attach(1, UDID, 'a', ACTIVE)
    await settle()
    const c = r.children[0]
    c.event({ event: 'ready', device: DEVICE })
    return { r, c }
  }
  it('forwards a validated command and returns the helper reply', async () => {
    const { r, c } = await live()
    c.replies.set('tap', { ms: 12 })
    const reply = await r.svc.command(1, UDID, { cmd: 'tap', x: 5, y: 6, evil: 'x' })
    expect(reply).toMatchObject({ ok: true, ms: 12 })
    const sent = c.last('tap')!
    expect(sent).toMatchObject({ cmd: 'tap', x: 5, y: 6 })
    expect(sent).not.toHaveProperty('evil')
    expect(typeof sent.id).toBe('number')
  })
  it('refuses an invalid command without writing anything to the helper', async () => {
    const { r, c } = await live()
    const before = c.written.length
    expect(await r.svc.command(1, UDID, { cmd: 'button', name: 'rm -rf' })).toMatchObject({ ok: false, code: 'bad-request' })
    expect(await r.svc.command(1, UDID, { cmd: 'quit' })).toMatchObject({ ok: false, code: 'bad-request' })
    expect(c.written.length).toBe(before)
  })
  it('only drives a device the sender is itself viewing', async () => {
    const { r } = await live()
    r.clients.push(2)
    expect(await r.svc.command(2, UDID, { cmd: 'info' })).toMatchObject({ ok: false, code: 'not-running' })
    expect(await r.svc.command(1, OTHER, { cmd: 'info' })).toMatchObject({ ok: false, code: 'not-running' })
  })
  it('sends fire-and-forget input with quiet:true, and ignores non-input commands on that channel', async () => {
    const { r, c } = await live()
    r.svc.input(1, UDID, { cmd: 'touch', phase: 'down', x: 1, y: 2, edge: 'bottom' })
    r.svc.input(1, UDID, { cmd: 'describe' })
    r.svc.input(1, UDID, { cmd: 'touch', phase: 'down', x: NaN, y: 2 })
    const touches = c.cmds().filter((x) => x.cmd === 'touch')
    expect(touches).toHaveLength(1)
    expect(touches[0]).toMatchObject({ phase: 'down', x: 1, y: 2, edge: 'bottom', quiet: true })
    expect(c.last('describe')).toBeUndefined()
  })
  it('returns a screenshot: the image arrives (type 3) just before the reply that names it', async () => {
    const { r, c } = await live()
    const original = c.stdin.write
    c.stdin.write = (chunk: string): boolean => {
      original(chunk)
      const req = JSON.parse(chunk.trim()) as { id: number; cmd: string }
      if (req.cmd === 'screenshot') {
        c.image(5)
        c.json({ id: req.id, ok: true, imageId: 5, format: 'png', width: 10, height: 20, bytes: 2 })
      }
      return true
    }
    const shot = await r.svc.screenshot(1, UDID)
    expect(shot).toMatchObject({ ok: true, format: 'png', width: 10, height: 20 })
    expect(shot.ok && shot.data.byteLength).toBe(2)
    expect(c.last('screenshot')).toMatchObject({ format: 'png', scale: 1 })
  })
  it('drops fire-and-forget input once the helper stdin backlog is past the cap', async () => {
    const { r, c } = await live()
    ;(c.stdin as { writableLength?: number }).writableLength = 10 * 1024 * 1024
    r.svc.input(1, UDID, { cmd: 'touch', phase: 'move', x: 1, y: 2 })
    expect(c.cmds().filter((x) => x.cmd === 'touch')).toHaveLength(0)
    ;(c.stdin as { writableLength?: number }).writableLength = 0
    r.svc.input(1, UDID, { cmd: 'touch', phase: 'move', x: 1, y: 2 })
    expect(c.cmds().filter((x) => x.cmd === 'touch')).toHaveLength(1)
  })
  it('answers a command whose helper died with not-running, not a hang', async () => {
    const { r, c } = await live()
    const pending = r.svc.command(1, UDID, { cmd: 'describe' })
    c.exit(1)
    expect(await pending).toMatchObject({ ok: false, code: 'not-running' })
  })
  it('times a reply out rather than hanging a caller forever', async () => {
    const { r } = await live()
    const pending = r.svc.command(1, UDID, { cmd: 'text', text: 'hi' })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await pending).toMatchObject({ ok: false, code: 'timeout' })
  })
})

describe('boot', () => {
  it('boots through the injected headless boot, only for a valid id, only on macOS', async () => {
    const boot = vi.fn(async () => ({ ok: true }))
    const r = rig({ boot })
    expect(await r.svc.boot(UDID)).toEqual({ ok: true })
    expect(boot).toHaveBeenCalledWith(UDID)
    expect(await r.svc.boot('nope')).toMatchObject({ ok: false })
    expect(boot).toHaveBeenCalledTimes(1)
    const off = rig({ isDarwin: false, boot })
    expect(await off.svc.boot(UDID)).toMatchObject({ ok: false })
    expect(boot).toHaveBeenCalledTimes(1)
  })
})

describe('toDeviceInfo', () => {
  it('reads the helper body and zeroes anything that is not a positive number', () => {
    expect(toDeviceInfo({ ...DEVICE, pixelWidth: -3, scale: 'x' })).toMatchObject({ pixelWidth: 0, scale: 1, pointWidth: 393, ready: true })
  })
  it('is undefined without a valid udid', () => {
    expect(toDeviceInfo({ name: 'x' })).toBeUndefined()
    expect(toDeviceInfo(null)).toBeUndefined()
  })
})
