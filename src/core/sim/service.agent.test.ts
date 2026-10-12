import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import { AGENT_LINGER_MS, SIM_GRACE_MS, createSimService, type SimServiceDeps } from './service'
import type { HelperChild } from './helper-process'

// The agent lease (the `sim` canvas-control verb's way onto a device): same helper process as the
// node, one call at a time, a stream only while it needs to see changes. The child is a fake.

const UDID = 'AE342EEF-B624-4060-B9E6-AE6E9EAAC24A'

const framed = (type: number, payload: Buffer): Buffer => {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(payload.length + 1, 0)
  head[4] = type
  return Buffer.concat([head, payload])
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  written: string[] = []
  ended = false
  autoFrame = true
  pid = 99
  replies = new Map<string, Record<string, unknown>>()
  stdin = {
    write: (chunk: string): boolean => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        this.written.push(line)
        const req = JSON.parse(line) as { id?: number; cmd: string; quiet?: boolean }
        if (req.cmd === 'quit') queueMicrotask(() => this.emit('exit', 0, null))
        // The real helper sends a first frame at once when its stream is switched on.
        if (this.autoFrame && req.cmd === 'stream' && (req as { on?: boolean }).on !== false) queueMicrotask(() => this.frame())
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
  kill(): boolean {
    return true
  }
  json(o: unknown): void {
    this.stdout.emit('data', framed(2, Buffer.from(JSON.stringify(o))))
  }
  frame(): void {
    const p = Buffer.alloc(15, 9)
    p.writeUInt16BE(4, 8)
    p.writeUInt16BE(8, 10)
    this.stdout.emit('data', framed(1, p))
  }
  cmds(): Array<Record<string, unknown>> {
    return this.written.map((l) => JSON.parse(l))
  }
  last(cmd: string): Record<string, unknown> | undefined {
    return this.cmds().filter((c) => c.cmd === cmd).pop()
  }
}

const DEVICE = { udid: UDID, name: 'iPhone 15', runtime: 'iOS 26.5', state: 'Booted', pixelWidth: 1179, pixelHeight: 2556, pointWidth: 393, pointHeight: 852, scale: 3, ready: true }

function rig(over: Partial<SimServiceDeps> = {}, deviceState = 'Booted', autoFrame = true) {
  const children: FakeChild[] = []
  const sent: Array<{ to: number; channel: string }> = []
  const clients = [1]
  const svc = createSimService({
    isDarwin: true,
    helperPath: () => '/fake/sim-helper',
    spawn: () => {
      const c = new FakeChild()
      c.autoFrame = autoFrame
      c.replies.set('info', { device: { ...DEVICE, state: deviceState, ready: false } })
      c.replies.set('tap', { ms: 5 })
      c.replies.set('swipe', { ms: 300 })
      c.replies.set('describe', { elements: [], screen: { width: 393, height: 852 } })
      children.push(c)
      return c as unknown as HelperChild
    },
    listDevices: async () => ({ devices: [] }),
    boot: async () => ({ ok: true }),
    send: (to, channel) => void sent.push({ to, channel }),
    clientIds: () => clients,
    log: () => undefined,
    ...over
  })
  return { svc, children, sent, clients }
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}
const ready = (c: FakeChild): void => c.json({ event: 'ready', device: DEVICE })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('agentRun — joining the device', () => {
  it('starts the helper, waits for ready, runs the call and hands back its value', async () => {
    const r = rig()
    let ran = false
    const p = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async (d) => {
      ran = true
      return d.status().device?.name
    })
    await flush()
    expect(r.children).toHaveLength(1)
    expect(ran).toBe(false) // the device is not ready yet
    ready(r.children[0])
    expect(await p).toEqual({ ok: true, value: 'iPhone 15' })
    expect(ran).toBe(true)
  })

  it('shares the ONE helper with a node viewing the device (never a second process)', async () => {
    const r = rig()
    r.svc.attach(1, UDID, 'node', { level: 'active', scale: 0.5 })
    await flush()
    ready(r.children[0])
    const out = await r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async (d) => (await d.command({ cmd: 'tap', x: 1, y: 2 })).ok)
    expect(out).toEqual({ ok: true, value: true })
    expect(r.children).toHaveLength(1)
    expect(r.children[0].last('tap')).toMatchObject({ x: 1, y: 2 })
  })

  it('refuses a bad id and an unavailable host before spawning anything', async () => {
    const r = rig()
    expect(await r.svc.agentRun('nope', { connectTimeoutMs: 1 }, async () => 1)).toMatchObject({ ok: false, code: 'device-not-found' })
    const off = rig({ isDarwin: false })
    expect(await off.svc.agentRun(UDID, { connectTimeoutMs: 1 }, async () => 1)).toMatchObject({ ok: false, code: 'unsupported' })
    expect(r.children).toHaveLength(0)
    expect(off.children).toHaveLength(0)
  })

  it('validates what it forwards: a bad command never reaches the helper', async () => {
    const r = rig()
    const p = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async (d) => d.command({ cmd: 'tap', x: Number.NaN, y: 1 }))
    await flush()
    ready(r.children[0])
    expect(await p).toMatchObject({ ok: true, value: { ok: false, code: 'bad-request' } })
    expect(r.children[0].last('tap')).toBeUndefined()
  })

  it('a shut-down device fails fast with device-shutdown instead of waiting out the timeout', async () => {
    const r = rig({}, 'Shutdown')
    const p = r.svc.agentRun(UDID, { connectTimeoutMs: 30_000 }, async () => 1)
    await flush()
    expect(await p).toMatchObject({ ok: false, code: 'device-shutdown' })
  })

  it('--boot waits through a shutdown reading and succeeds once the device is ready', async () => {
    const r = rig({}, 'Shutdown')
    const p = r.svc.agentRun(UDID, { connectTimeoutMs: 30_000, tolerateShutdown: true }, async (d) => d.status().device?.state)
    await flush()
    r.children[0].json({ event: 'device-state', state: 'Booting', booted: false })
    ready(r.children[0])
    expect(await p).toEqual({ ok: true, value: 'Booted' })
  })

  it('times out with a named code when the device never becomes ready', async () => {
    const r = rig()
    const p = r.svc.agentRun(UDID, { connectTimeoutMs: 2_000 }, async () => 1)
    await vi.advanceTimersByTimeAsync(2_001)
    expect(await p).toMatchObject({ ok: false, code: 'timeout' })
  })

  it('reports a fatal helper error as its code', async () => {
    const r = rig()
    const p = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async () => 1)
    await flush()
    r.children[0].json({ event: 'error', code: 'already-attached', message: 'another controller holds this device', fatal: true })
    expect(await p).toMatchObject({ ok: false, code: 'already-attached', error: 'another controller holds this device' })
  })
})

describe('agentRun — the stream\'s first frame', () => {
  it('lets it land before the first command (it must not read as a reaction), and fails open without one', async () => {
    const r = rig({}, 'Booted', false) // a helper that sends no first frame
    let startedAt = -1
    const t0 = Date.now()
    const p = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async () => {
      startedAt = Date.now() - t0
    })
    await flush()
    ready(r.children[0])
    await vi.advanceTimersByTimeAsync(350)
    expect(startedAt).toBe(-1) // still waiting for the frame
    await vi.advanceTimersByTimeAsync(100)
    await p
    expect(startedAt).toBeGreaterThanOrEqual(400)
    expect(startedAt).toBeLessThan(450)
  })

  it('does not wait when a node is already streaming the device (no burst is coming)', async () => {
    const r = rig({}, 'Booted', false)
    r.svc.attach(1, UDID, 'node', { level: 'active', scale: 0.5 })
    await flush()
    ready(r.children[0])
    let started = false
    const p = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async () => {
      started = true
    })
    await vi.advanceTimersByTimeAsync(0)
    await p
    expect(started).toBe(true)
  })
})

describe('agentRun — one driver at a time', () => {
  it('serializes calls on a device and runs them in order', async () => {
    const r = rig()
    const log: string[] = []
    const first = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async () => {
      log.push('a:start')
      await new Promise((res) => setTimeout(res, 100))
      log.push('a:end')
    })
    const second = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async () => {
      log.push('b:start')
    })
    await flush()
    ready(r.children[0])
    await vi.advanceTimersByTimeAsync(150)
    await Promise.all([first, second])
    expect(log).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('a throwing call releases the lease and does not wedge the queue', async () => {
    const r = rig()
    const bad = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async () => {
      throw new Error('boom')
    })
    const bad2 = bad.catch((e: Error) => e.message)
    await flush()
    ready(r.children[0])
    expect(await bad2).toBe('boom')
    expect(await r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async () => 'fine')).toEqual({ ok: true, value: 'fine' })
  })
})

describe('agentRun — the settle wait after an input (measured: first frame 110–480 ms after a tap/Home)', () => {
  type Idle = { idle: boolean; waitedMs: number; changed: boolean }
  const waitAfterTap = async (
    r: ReturnType<typeof rig>,
    script: (c: FakeChild) => Promise<void>,
    opts = { quietMs: 300, timeoutMs: 5_000, reactionMs: 800 }
  ): Promise<Idle> => {
    let out: Idle | null = null
    const p = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async (d) => {
      await d.command({ cmd: 'tap', x: 1, y: 2 })
      const w = d.waitIdle(opts).then((v) => (out = v))
      await script(r.children[0])
      await w
    })
    await flush()
    ready(r.children[0])
    await p
    return out!
  }

  it('does not call a screen settled before it has had time to START changing', async () => {
    const r = rig()
    const got = await waitAfterTap(r, async (c) => {
      await vi.advanceTimersByTimeAsync(480) // a Home press: nothing for ~480 ms...
      c.frame() // ...then the animation begins
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(got).toMatchObject({ idle: true, changed: true })
    // The frame at 480 + the 300 ms quiet window (the wait polls every 25 ms).
    expect(got.waitedMs).toBeGreaterThanOrEqual(780)
    expect(got.waitedMs).toBeLessThan(810)
  })

  it('a tap that changes nothing settles after the reaction grace, reporting no change', async () => {
    const r = rig()
    const got = await waitAfterTap(r, async () => {
      await vi.advanceTimersByTimeAsync(900)
    })
    expect(got).toEqual({ idle: true, waitedMs: 800, changed: false })
  })

  it('counts frames from when the input was SENT, so a long gesture\'s own frames are a change', async () => {
    const r = rig()
    let out: Idle | null = null
    const p = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async (d) => {
      const swipe = d.command({ cmd: 'swipe', x1: 1, y1: 1, x2: 2, y2: 2 })
      r.children[0].frame() // the screen scrolls WHILE the swipe is still being delivered
      await swipe
      out = await d.waitIdle({ quietMs: 300, timeoutMs: 5_000, reactionMs: 800 })
    })
    await flush()
    ready(r.children[0])
    await vi.advanceTimersByTimeAsync(1_000)
    await p
    expect(out).toMatchObject({ idle: true, changed: true })
    expect(out!.waitedMs).toBeLessThan(400) // no reaction wait: the screen had already moved
  })

  it('a pause inside an animation shorter than the quiet window does not end the wait', async () => {
    const r = rig()
    const got = await waitAfterTap(r, async (c) => {
      c.frame()
      await vi.advanceTimersByTimeAsync(250)
      c.frame() // the screen was still going after a 250 ms gap
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(got).toMatchObject({ idle: true, changed: true })
    expect(got.waitedMs).toBeGreaterThanOrEqual(550) // 250 + 300 after the LAST frame
    expect(got.waitedMs).toBeLessThan(580)
  })

  it('a bare wait counts only frames from now (a screen that was moving before is not "changed")', async () => {
    const r = rig()
    let out: Idle | null = null
    const p = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async (d) => {
      r.children[0].frame() // before the wait
      out = await d.waitIdle({ quietMs: 300, timeoutMs: 5_000 })
    })
    await flush()
    ready(r.children[0])
    await vi.advanceTimersByTimeAsync(400)
    await p
    expect(out).toEqual({ idle: true, waitedMs: 300, changed: false })
  })
})

describe('agentRun — the stream and the settle wait', () => {
  it('asks the helper for a stream while it holds the lease and switches it off after', async () => {
    const r = rig()
    const p = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async () => 1)
    await flush()
    ready(r.children[0])
    await p
    const streams = r.children[0].cmds().filter((c) => c.cmd === 'stream')
    expect(streams[0]).toMatchObject({ on: true })
    expect(streams[streams.length - 1]).toMatchObject({ on: false })
  })

  it('waitIdle resolves once no frame has arrived for the quiet window', async () => {
    const r = rig()
    let result: { idle: boolean; waitedMs: number } | null = null
    const p = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async (d) => {
      const w = d.waitIdle({ quietMs: 300, timeoutMs: 5_000 })
      void w.then((v) => (result = v))
      await w
    })
    await flush()
    ready(r.children[0])
    await vi.advanceTimersByTimeAsync(200)
    r.children[0].frame() // activity at +200 ms restarts the quiet window
    await vi.advanceTimersByTimeAsync(299)
    expect(result).toBeNull()
    await vi.advanceTimersByTimeAsync(2)
    await p
    expect(result).toMatchObject({ idle: true })
    expect(result!.waitedMs).toBeGreaterThanOrEqual(500)
  })

  it('waitIdle gives up at the timeout while the screen keeps changing, and says so', async () => {
    const r = rig()
    let result: { idle: boolean } | null = null
    const p = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async (d) => {
      const w = d.waitIdle({ quietMs: 300, timeoutMs: 1_000 })
      const pump = setInterval(() => r.children[0].frame(), 100)
      result = await w
      clearInterval(pump)
    })
    await flush()
    ready(r.children[0])
    await vi.advanceTimersByTimeAsync(1_200)
    await p
    expect(result).toMatchObject({ idle: false })
  })

  it('the lease takes no frames of its own: it is not a window', async () => {
    const r = rig()
    const p = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async () => {
      r.children[0].frame()
      r.children[0].frame()
    })
    await flush()
    ready(r.children[0])
    await p
    expect(r.sent.filter((s) => s.channel === IPC.simFrame(UDID))).toHaveLength(0)
  })

  it('does not stand on a window that closed: the lease is not pruned with clientIds', async () => {
    const r = rig()
    r.clients.length = 0 // no window at all (a headless run)
    const p = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async (d) => d.status().phase)
    await flush()
    ready(r.children[0])
    expect(await p).toEqual({ ok: true, value: 'live' })
  })
})

describe('agentRun — the helper outlives one call, not the session', () => {
  it('keeps the helper through the linger, so a script of calls pays one start', async () => {
    const r = rig()
    const a = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async () => 1)
    await flush()
    ready(r.children[0])
    await a
    await vi.advanceTimersByTimeAsync(AGENT_LINGER_MS - 1_000)
    expect(r.children[0].last('quit')).toBeUndefined()
    await r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async () => 2)
    expect(r.children).toHaveLength(1)
  })

  it('quits the helper after the linger plus the grace when nobody else is watching', async () => {
    const r = rig()
    const a = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async () => 1)
    await flush()
    ready(r.children[0])
    await a
    await vi.advanceTimersByTimeAsync(AGENT_LINGER_MS + SIM_GRACE_MS + 10)
    expect(r.children[0].last('quit')).toBeDefined()
  })

  it('never stops a helper a node is still watching', async () => {
    const r = rig()
    r.svc.attach(1, UDID, 'node', { level: 'active', scale: 0.5 })
    await flush()
    ready(r.children[0])
    await r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async () => 1)
    await vi.advanceTimersByTimeAsync(AGENT_LINGER_MS + SIM_GRACE_MS * 3)
    expect(r.children[0].last('quit')).toBeUndefined()
  })

  it('dispose quits the helper and drops the linger timer', async () => {
    const r = rig()
    const a = r.svc.agentRun(UDID, { connectTimeoutMs: 5_000 }, async () => 1)
    await flush()
    ready(r.children[0])
    await a
    const d = r.svc.dispose()
    await vi.advanceTimersByTimeAsync(10)
    await d
    expect(r.children[0].last('quit')).toBeDefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})
