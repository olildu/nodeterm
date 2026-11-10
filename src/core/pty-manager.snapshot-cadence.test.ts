// `PtyManager.snapshotTick` — the periodic cold-restore scrollback snapshot (Task 8).
//
// The cadence rule itself is the pure `scrollback-cadence.ts`; this file pins the WIRING: a
// continuously dirty session is captured on the cadence, not on every tick; captures run one at a
// time instead of all in the same instant; a capture still in flight is never queued twice; a
// failed capture OR a failed disk write re-marks the session dirty; and an identical capture is
// not rewritten to disk.
// Sessions are registered directly (no spawn harness) — the tick reads only the fields set below.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { BUSY_AFTER_TICKS, BUSY_EVERY_TICKS } from './scrollback-cadence'

type Cb = (err: Error | null, res?: { stdout: string; stderr: string }) => void

/** Every `capture-pane` lands here; `hold` parks its callback until the test releases it. */
const tmux = vi.hoisted(() => ({
  captures: [] as string[],
  held: [] as Array<{ target: string; cb: Cb }>,
  hold: false,
  fail: false,
  text: 'PANE SNAPSHOT'
}))

vi.mock('child_process', () => {
  const execFile = (file: string, args: string[], a?: unknown, b?: unknown): unknown => {
    const cb = (typeof a === 'function' ? a : b) as Cb | undefined
    if (args.includes('capture-pane')) {
      // Recorded as the session NAME; production passes the exact form (`=name:`).
      const raw = args[args.indexOf('-t') + 1]
      if (!/^=nt-.*:$/.test(raw)) throw new Error(`capture without an exact target: ${raw}`)
      const target = raw.slice(1, -1)
      tmux.captures.push(target)
      if (tmux.hold) tmux.held.push({ target, cb: cb! })
      else if (tmux.fail) cb?.(new Error('tmux busy'))
      else cb?.(null, { stdout: tmux.text, stderr: '' })
    } else cb?.(null, { stdout: '', stderr: '' })
    return {}
  }
  return { execFile, execFileSync: (): string => '' }
})

/** Every write ATTEMPT is recorded; `failNext` makes the next one report failure (the store never
 *  throws — it resolves false, see scrollback-store.ts). */
const store = vi.hoisted(() => ({
  writes: [] as Array<{ key: string; text: string }>,
  failNext: false
}))
vi.mock('./scrollback-store', () => ({
  writeScrollback: async (key: string, text: string) => {
    store.writes.push({ key, text })
    if (store.failNext) {
      store.failNext = false
      return false
    }
    return true
  },
  readScrollback: async () => '',
  deleteScrollback: async () => {}
}))

vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)

vi.mock('node-pty', () => ({ spawn: () => ({}) }))

interface Internals {
  tmuxPath: string | null
  sessions: Map<string, Record<string, unknown>>
  snapshotChain: Promise<unknown>
  snapshotTick(): void
  snapshotScrollback(k: string): Promise<boolean>
  destroySession(clientId: null, persistKey: string): Promise<void>
  killAll(): Promise<void>
}

async function manager(keys: string[]): Promise<Internals> {
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager() as unknown as Internals
  mgr.tmuxPath = '/usr/bin/tmux'
  for (const key of keys)
    mgr.sessions.set(`sess-${key}`, {
      persistKey: key,
      outputSinceSnapshot: true,
      snapshotDirtyTicks: 0,
      snapshotQueued: false
    })
  return mgr
}

/** Let the serialized chain drain (each link is a few microtask hops). */
async function settle(mgr: Internals): Promise<void> {
  await mgr.snapshotChain
  await new Promise((r) => setImmediate(r))
}

beforeEach(() => {
  initPlatform(fakePlatform())
  tmux.captures.length = 0
  tmux.held.length = 0
  tmux.hold = false
  tmux.fail = false
  tmux.text = 'PANE SNAPSHOT'
  store.writes.length = 0
  store.failNext = false
})
afterEach(() => resetPlatformForTests())

describe('snapshotTick cadence', () => {
  it('captures a continuously dirty session on ticks 1-4, then every 4th tick', async () => {
    const mgr = await manager(['n1'])
    const session = mgr.sessions.get('sess-n1')!
    const capturedOn: number[] = []
    for (let tick = 1; tick <= 16; tick++) {
      session.outputSinceSnapshot = true // the spinner redrew since the last tick
      const before = tmux.captures.length
      mgr.snapshotTick()
      await settle(mgr)
      if (tmux.captures.length > before) capturedOn.push(tick)
    }
    expect(BUSY_AFTER_TICKS).toBe(4)
    expect(BUSY_EVERY_TICKS).toBe(4)
    expect(capturedOn).toEqual([1, 2, 3, 4, 8, 12, 16])
  })

  it('an idle tick resets the busy count, so the next output is captured at once', async () => {
    const mgr = await manager(['n1'])
    const session = mgr.sessions.get('sess-n1')!
    for (let tick = 1; tick <= 5; tick++) {
      session.outputSinceSnapshot = true
      mgr.snapshotTick()
      await settle(mgr)
    }
    expect(tmux.captures).toHaveLength(4) // tick 5 is off-cadence
    // Tick 5 kept the dirty bit, so clear it by hand to model a genuinely quiet interval.
    session.outputSinceSnapshot = false
    mgr.snapshotTick()
    await settle(mgr)
    expect(session.snapshotDirtyTicks).toBe(0)
    session.outputSinceSnapshot = true
    mgr.snapshotTick()
    await settle(mgr)
    expect(tmux.captures).toHaveLength(5)
  })

  it('an off-cadence tick keeps the dirty bit, so detach/quit still take a final capture', async () => {
    const mgr = await manager(['n1'])
    const session = mgr.sessions.get('sess-n1')!
    for (let tick = 1; tick <= 5; tick++) {
      session.outputSinceSnapshot = true
      mgr.snapshotTick()
      await settle(mgr)
    }
    expect(session.outputSinceSnapshot).toBe(true)
  })
})

describe('snapshotTick serialization', () => {
  it('runs captures one at a time, never all in the same instant', async () => {
    const mgr = await manager(['a', 'b', 'c'])
    tmux.hold = true
    mgr.snapshotTick()
    await new Promise((r) => setImmediate(r))
    expect(tmux.captures).toEqual(['nt-a'])
    tmux.held.shift()!.cb(null, { stdout: 'A', stderr: '' })
    await new Promise((r) => setImmediate(r))
    expect(tmux.captures).toEqual(['nt-a', 'nt-b'])
    tmux.held.shift()!.cb(null, { stdout: 'B', stderr: '' })
    await new Promise((r) => setImmediate(r))
    expect(tmux.captures).toEqual(['nt-a', 'nt-b', 'nt-c'])
    tmux.held.shift()!.cb(null, { stdout: 'C', stderr: '' })
    await settle(mgr)
  })

  it('never queues a session whose capture is still pending', async () => {
    const mgr = await manager(['a'])
    const session = mgr.sessions.get('sess-a')!
    tmux.hold = true
    mgr.snapshotTick()
    await new Promise((r) => setImmediate(r))
    session.outputSinceSnapshot = true
    mgr.snapshotTick() // tick 2 is on-cadence, but the first capture has not returned
    await new Promise((r) => setImmediate(r))
    expect(tmux.captures).toEqual(['nt-a'])
    expect(tmux.held).toHaveLength(1)
    tmux.held.shift()!.cb(null, { stdout: 'A', stderr: '' })
    await settle(mgr)
    expect(tmux.captures).toEqual(['nt-a'])
    expect(session.snapshotQueued).toBe(false)
    // The skipped tick left the dirty bit set, so the next tick captures it.
    tmux.hold = false
    mgr.snapshotTick()
    await settle(mgr)
    expect(tmux.captures).toEqual(['nt-a', 'nt-a'])
  })

  it('a failed capture puts the dirty bit back for the next tick', async () => {
    const mgr = await manager(['a'])
    const session = mgr.sessions.get('sess-a')!
    tmux.fail = true
    mgr.snapshotTick()
    await settle(mgr)
    expect(session.outputSinceSnapshot).toBe(true)
    expect(session.snapshotQueued).toBe(false)
  })

  it('a failed disk WRITE puts the dirty bit back too (the capture succeeding is not enough)', async () => {
    const mgr = await manager(['a'])
    const session = mgr.sessions.get('sess-a')!
    store.failNext = true
    mgr.snapshotTick()
    await settle(mgr)
    expect(store.writes).toHaveLength(1) // the capture ran and the write was attempted…
    expect(session.outputSinceSnapshot).toBe(true) // …and failed, so the next tick retries
    expect(session.snapshotQueued).toBe(false)
  })

  it('an unchanged capture (skipped write) counts as done and stays clean', async () => {
    const mgr = await manager(['a'])
    const session = mgr.sessions.get('sess-a')!
    mgr.snapshotTick()
    await settle(mgr)
    session.outputSinceSnapshot = true // a cursor-only redraw: same captured text
    mgr.snapshotTick()
    await settle(mgr)
    expect(store.writes).toHaveLength(1)
    expect(session.outputSinceSnapshot).toBe(false)
  })
})

describe('snapshot digest skip', () => {
  it('does not rewrite an identical capture, but writes a changed one', async () => {
    const mgr = await manager(['a'])
    await mgr.snapshotScrollback('a')
    await mgr.snapshotScrollback('a')
    expect(store.writes).toHaveLength(1)
    tmux.text = 'NEW OUTPUT'
    await mgr.snapshotScrollback('a')
    expect(store.writes.map((w) => w.text)).toEqual(['PANE SNAPSHOT', 'NEW OUTPUT'])
  })

  it('keys the digest per node', async () => {
    const mgr = await manager(['a', 'b'])
    await mgr.snapshotScrollback('a')
    await mgr.snapshotScrollback('b')
    expect(store.writes.map((w) => w.key)).toEqual(['a', 'b'])
  })

  it('forgets the digest when the node is destroyed, so a recreated node writes again', async () => {
    const mgr = await manager([])
    await mgr.snapshotScrollback('gone')
    await mgr.destroySession(null, 'gone')
    await mgr.snapshotScrollback('gone')
    expect(store.writes.map((w) => w.key)).toEqual(['gone', 'gone'])
  })

  it('a failed write is not remembered, so an identical capture writes again', async () => {
    const mgr = await manager(['a'])
    store.failNext = true
    await mgr.snapshotScrollback('a')
    await mgr.snapshotScrollback('a')
    await mgr.snapshotScrollback('a')
    // attempt 1 failed, attempt 2 landed, attempt 3 is the identical capture that is skipped
    expect(store.writes.map((w) => w.text)).toEqual(['PANE SNAPSHOT', 'PANE SNAPSHOT'])
  })
})

describe('quit while a periodic capture is queued', () => {
  it('killAll still captures a session whose periodic capture has not run yet', async () => {
    const mgr = await manager(['a', 'b'])
    for (const s of mgr.sessions.values()) s.proc = { resume: () => {}, kill: () => {} }
    tmux.hold = true
    mgr.snapshotTick() // queues a, then b behind it; both dirty bits are now cleared
    await new Promise((r) => setImmediate(r))
    expect(tmux.captures).toEqual(['nt-a']) // b is queued, not yet run
    tmux.hold = false
    await mgr.killAll()
    // Both get their final quit capture — b's queued periodic one may never run before exit.
    expect(tmux.captures.filter((t) => t === 'nt-b')).toHaveLength(1)
    expect(tmux.captures.filter((t) => t === 'nt-a')).toHaveLength(2)
    tmux.held.shift()!.cb(null, { stdout: 'A', stderr: '' })
    await settle(mgr)
  })
})
