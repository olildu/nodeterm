import { describe, expect, it } from 'vitest'
import type { SimReply, SimScreenshotReply, SimStatus } from '../../shared/sim'
import { createSimControl, type SimControlDeps } from './control'
import type { AgentDevice, AgentFailure, AgentRunOptions } from './service'

const UDID = 'AE342EEF-B624-4060-B9E6-AE6E9EAAC24A'
const OTHER = '11111111-2222-3333-4444-555555555555'

const live: SimStatus = {
  phase: 'live',
  device: { udid: UDID, name: 'iPhone 15', pixelWidth: 1179, pixelHeight: 2556, pointWidth: 393, pointHeight: 852, scale: 3, ready: true }
}

const el = (over: Record<string, unknown>): Record<string, unknown> => ({
  label: null,
  value: null,
  identifier: null,
  role: 'AXButton',
  enabled: true,
  offscreen: false,
  clipped: false,
  frame: { x: 0, y: 0, width: 10, height: 10 },
  center: { x: 5, y: 5 },
  ...over
})

interface Rig {
  run: (args: Record<string, string>, over?: { nodeId?: string; verified?: boolean }) => ReturnType<ReturnType<typeof createSimControl>>
  sent: Array<Record<string, unknown>>
  waits: Array<[number, number, number | undefined]>
  runs: Array<{ udid: unknown; opts: AgentRunOptions }>
  written: Array<{ abs: string; bytes: number }>
  booted: string[]
  /** Replies by helper command; a function may inspect the command. */
  replies: Map<string, SimReply | ((cmd: Record<string, unknown>) => SimReply)>
  failure: { value: AgentFailure | null }
  idle: { value: boolean }
  /** Did any frame arrive while waiting (false = "no visible change"). */
  changed: { value: boolean }
  status: { value: SimStatus }
}

function rig(over: Partial<SimControlDeps> = {}): Rig {
  const sent: Array<Record<string, unknown>> = []
  const waits: Rig['waits'] = []
  const runs: Rig['runs'] = []
  const written: Rig['written'] = []
  const booted: string[] = []
  const replies: Rig['replies'] = new Map()
  const failure: Rig['failure'] = { value: null }
  const idle = { value: true }
  const changed = { value: true }
  const status = { value: live }
  const device: AgentDevice = {
    status: () => status.value,
    command: async (cmd) => {
      sent.push(cmd)
      const r = replies.get(String(cmd.cmd))
      if (!r) return { ok: true }
      return typeof r === 'function' ? r(cmd) : r
    },
    screenshot: async (): Promise<SimScreenshotReply> => ({ ok: true, format: 'png', width: 1179, height: 2556, data: new Uint8Array(2048) }),
    waitIdle: async (o) => {
      waits.push([o.quietMs, o.timeoutMs, o.reactionMs])
      return { idle: idle.value, waitedMs: idle.value ? 312 : o.timeoutMs, changed: changed.value }
    }
  }
  const control = createSimControl({
    service: {
      availability: () => ({ ok: true }),
      devices: async () => ({
        devices: [
          { udid: UDID, name: 'iPhone 15', runtime: 'iOS 26.5', booted: true },
          { udid: OTHER, name: 'iPhone SE', runtime: 'iOS 26.5', booted: false }
        ]
      }),
      boot: async (udid) => {
        booted.push(String(udid))
        return { ok: true }
      },
      agentRun: (async (udid: unknown, opts: AgentRunOptions, fn: (d: AgentDevice) => Promise<unknown>) => {
        runs.push({ udid, opts })
        if (failure.value) return failure.value
        return { ok: true, value: await fn(device) }
      }) as never
    },
    projectIdOfNode: (id) => (id === 'agent' ? 'p1' : undefined),
    simulatorNodes: (pid) => (pid === 'p1' ? [{ id: 'sim1', title: 'Phone', udid: UDID }, { id: 'sim2', title: 'Blank' }] : []),
    projectCwd: (pid) => (pid === 'p1' ? '/work/app' : undefined),
    resolvePath: async (cwd, raw) =>
      cwd && !raw.includes('..') ? { ok: true, abs: `${cwd}/${raw}` } : { ok: false, message: 'sim: --screenshot path must be inside the project directory' },
    tempDir: () => '/tmp',
    writeFile: async (abs, d) => void written.push({ abs, bytes: d.byteLength }),
    ...over
  })
  return {
    run: (args, o = {}) => control({ nodeId: o.nodeId ?? 'agent', args, verified: o.verified ?? true }),
    sent,
    waits,
    runs,
    written,
    booted,
    replies,
    failure,
    idle,
    changed,
    status
  }
}

describe('who may call it', () => {
  it('refuses an unverified caller with the flat sentence, before parsing or touching a device', async () => {
    const r = rig()
    const out = await r.run({ udid: UDID, describe: '' }, { verified: false })
    expect(out).toMatchObject({ ok: false, error: 'Simulator control refused.' })
    expect(r.runs).toHaveLength(0)
  })

  it('names a bad call, not a guess', async () => {
    const r = rig()
    expect(await r.run({})).toMatchObject({ ok: false, error: expect.stringMatching(/exactly one action/) })
    expect(await r.run({ udid: UDID, tap: '1' })).toMatchObject({ ok: false, error: expect.stringMatching(/--tap takes x,y/) })
    expect(r.runs).toHaveLength(0)
  })

  it('says so when the simulator is not available on this machine', async () => {
    const r = rig({
      service: {
        availability: () => ({ ok: false, code: 'unsupported', message: 'The iOS Simulator needs macOS with Xcode installed.' }),
        devices: async () => ({ devices: [] }),
        boot: async () => ({ ok: false }),
        agentRun: (async () => ({ ok: false })) as never
      }
    })
    expect(await r.run({ list: '' })).toMatchObject({ ok: false, error: expect.stringMatching(/^sim-unavailable: .*needs macOS/) })
  })
})

describe('--list', () => {
  it('lists devices with state and the Simulator nodes of the CALLER\'s project that show them', async () => {
    const out = await rig().run({ list: '' })
    expect(out.ok).toBe(true)
    expect(out.message).toContain(`${UDID}  "iPhone 15"  iOS 26.5  Booted  shown by node sim1 "Phone"`)
    expect(out.message).toContain(`${OTHER}  "iPhone SE"  iOS 26.5  Shutdown`)
    expect(out.message).toMatch(/2 devices, 1 booted/)
    expect(out.message).toContain('Simulator nodes with no device chosen yet: sim2')
    expect(out.result).toMatchObject({ devices: [{ udid: UDID, nodes: ['sim1'] }, { udid: OTHER, nodes: [] }] })
  })

  it('tells the agent nothing is booted, and when no node shows a booted device', async () => {
    const none = rig({
      service: {
        availability: () => ({ ok: true }),
        devices: async () => ({ devices: [{ udid: OTHER, name: 'iPhone SE', runtime: 'iOS 26.5', booted: false }] }),
        boot: async () => ({ ok: true }),
        agentRun: (async () => ({ ok: false })) as never
      }
    })
    expect((await none.run({ list: '' })).message).toMatch(/Nothing is booted\. Boot one with: sim --udid <id> --boot/)
    const unwatched = rig({ simulatorNodes: () => [] })
    expect((await unwatched.run({ list: '' })).message).toMatch(/ask the user to add one so they can watch/)
  })

  it('does not reveal other projects\' nodes (a caller with no project sees none)', async () => {
    const out = await rig().run({ list: '' }, { nodeId: 'stranger' })
    expect(out.message).not.toContain('shown by node')
  })
})

describe('resolving the target', () => {
  it('--node must be a Simulator node in the caller\'s own project, with a device chosen', async () => {
    const r = rig()
    expect(await r.run({ describe: '', node: 'sim1' })).toMatchObject({ ok: true })
    expect(r.runs[0].udid).toBe(UDID)
    expect(await r.run({ describe: '', node: 'term9' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^sim-bad-node: term9 is not a Simulator node in this project\. Simulator nodes here: sim1, sim2/)
    })
    expect(await r.run({ describe: '', node: 'sim2' })).toMatchObject({ ok: false, error: expect.stringMatching(/^sim-node-no-device/) })
    expect(await r.run({ describe: '', node: 'sim1' }, { nodeId: 'stranger' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^sim-no-project/)
    })
    expect(r.runs).toHaveLength(1) // only the first call reached a device
  })

  it('--udid works for any device and is normalised', async () => {
    const r = rig()
    await r.run({ describe: '', udid: OTHER.toLowerCase() })
    expect(r.runs[0].udid).toBe(OTHER)
  })

  it('maps lease failures to codes an agent can branch on', async () => {
    const r = rig()
    r.failure.value = { ok: false, code: 'device-shutdown', error: 'iPhone SE is shut down.' }
    expect(await r.run({ describe: '', udid: OTHER })).toMatchObject({
      ok: false,
      error: `sim-device-shutdown: iPhone SE is shut down. Boot it with: sim --udid ${OTHER} --boot`
    })
    r.failure.value = { ok: false, code: 'already-attached', error: 'x' }
    expect(await r.run({ describe: '', udid: UDID })).toMatchObject({ error: expect.stringMatching(/^sim-busy:/) })
    r.failure.value = { ok: false, code: 'timeout', error: 'The simulator did not become ready in time.' }
    expect(await r.run({ describe: '', udid: UDID })).toMatchObject({ error: expect.stringMatching(/^sim-timeout:.*Retry/) })
    r.failure.value = { ok: false, code: 'device-not-found', error: 'x' }
    expect(await r.run({ describe: '', udid: UDID })).toMatchObject({ error: expect.stringMatching(/^sim-device-not-found/) })
  })
})

describe('looking', () => {
  it('--describe returns text plus structured elements', async () => {
    const r = rig()
    r.replies.set('describe', {
      ok: true,
      screen: { width: 393, height: 852 },
      elements: [el({ label: 'General', center: { x: 196, y: 430 } })]
    })
    const out = await r.run({ describe: '', node: 'sim1' })
    expect(out.message).toContain('Button "General" (196,430)')
    expect(out.result).toMatchObject({ elements: [{ label: 'General', center: { x: 196, y: 430 } }] })
    expect(r.waits).toHaveLength(0) // a read does not wait for idle
  })

  it('--describe on a device that is not ready reports the helper\'s code', async () => {
    const r = rig()
    r.replies.set('describe', { ok: false, code: 'not-ready', error: 'device is not booted' })
    expect(await r.run({ describe: '', node: 'sim1' })).toMatchObject({ ok: false, error: 'sim-not-ready: describe: device is not booted' })
  })

  it('--point describes one spot, and says when there is nothing', async () => {
    const r = rig()
    r.replies.set('describe-point', { ok: true, element: el({ label: 'Search', role: 'AXSearchField', center: { x: 196, y: 120 } }) })
    expect((await r.run({ point: '196,120', node: 'sim1' })).message).toContain('At (196,120): SearchField "Search" (196,120)')
    r.replies.set('describe-point', { ok: true, element: null })
    expect((await r.run({ point: '1,1', node: 'sim1' })).message).toMatch(/Nothing exposes an accessibility element at \(1,1\)/)
    expect(await r.run({ point: '999,1', node: 'sim1' })).toMatchObject({ error: expect.stringMatching(/^sim-out-of-bounds: \(999,1\) is outside the 393×852 pt screen/) })
  })

  it('--screenshot writes inside the project jail and says where', async () => {
    const r = rig()
    const out = await r.run({ screenshot: '.maestro/home.png', node: 'sim1' })
    expect(out).toMatchObject({ ok: true })
    expect(out.message).toContain('wrote /work/app/.maestro/home.png (1179×2556 px, 2 KB')
    expect(out.message).toContain('the device is 393×852 pt, so this image is 3.00 px per point')
    expect(out.message).toContain('show-image /work/app/.maestro/home.png')
    expect(r.written).toEqual([{ abs: '/work/app/.maestro/home.png', bytes: 2048 }])
  })

  it('--screenshot with no path writes a fresh temp file and prints it', async () => {
    const r = rig()
    const out = await r.run({ screenshot: '', node: 'sim1' })
    expect(out).toMatchObject({ ok: true })
    expect(r.written[0].abs).toMatch(/^\/work\/app\/?.*nodeterm-sim-.*\.png$|\/tmp\/nodeterm-sim-.*\.png$/)
  })

  it('--screenshot outside the project, or from a folder-less project, writes nothing', async () => {
    const r = rig()
    expect(await r.run({ screenshot: '../../etc/x.png', node: 'sim1' })).toMatchObject({ ok: false, error: expect.stringMatching(/inside the project directory/) })
    expect(await r.run({ screenshot: 'a.png', udid: UDID }, { nodeId: 'stranger' })).toMatchObject({ ok: false })
    expect(r.written).toEqual([])
  })
})

describe('acting', () => {
  it('--tap taps, then waits for the screen to settle by default', async () => {
    const r = rig()
    const out = await r.run({ tap: '196,430', node: 'sim1' })
    expect(r.sent).toContainEqual({ cmd: 'tap', x: 196, y: 430 })
    expect(out.message).toBe('tapped (196,430) — screen settled after 312 ms')
    expect(r.waits).toEqual([[300, 5000, 800]]) // an input gets the reaction grace
  })

  it('--no-wait true skips the wait; --quiet and --timeout reach it', async () => {
    const r = rig()
    expect((await r.run({ tap: '1,2', node: 'sim1', 'no-wait': 'true' })).message).toMatch(/not waited for/)
    expect(r.waits).toHaveLength(0)
    await r.run({ tap: '1,2', node: 'sim1', quiet: '800', timeout: '2000' })
    expect(r.waits).toEqual([[800, 2000, 800]])
  })

  it('says so when nothing on screen changed (a tap that did nothing is not a settled screen)', async () => {
    const r = rig()
    r.changed.value = false
    expect((await r.run({ tap: '1,2', node: 'sim1' })).message).toBe('tapped (1,2) — no visible change within 312 ms')
  })

  it('says when the screen did not settle', async () => {
    const r = rig()
    r.idle.value = false
    const out = await r.run({ tap: '1,2', node: 'sim1' })
    expect(out.ok).toBe(true)
    expect(out.message).toMatch(/still changing after 5000 ms/)
  })

  it('refuses a point off the screen without touching the device', async () => {
    const r = rig()
    expect(await r.run({ tap: '393.5,10', node: 'sim1' })).toMatchObject({ ok: false, error: expect.stringMatching(/^sim-out-of-bounds/) })
    expect(await r.run({ tap: '10,-1', node: 'sim1' })).toMatchObject({ ok: false })
    expect(await r.run({ swipe: '10,10,10,900', node: 'sim1' })).toMatchObject({ ok: false, error: expect.stringMatching(/out-of-bounds/) })
    expect(r.sent).toEqual([])
  })

  it('--swipe sends the duration', async () => {
    const r = rig()
    await r.run({ swipe: '196,700,196,200', ms: '600', node: 'sim1' })
    expect(r.sent).toContainEqual({ cmd: 'swipe', x1: 196, y1: 700, x2: 196, y2: 200, ms: 600 })
  })

  it('--type reports typed vs pasted (the pasteboard is overwritten, and it says so)', async () => {
    const r = rig()
    r.replies.set('text', { ok: true, typed: 5, pasted: 0 })
    expect((await r.run({ type: 'hello', node: 'sim1' })).message).toMatch(/^typed 5 characters — screen settled/)
    r.replies.set('text', { ok: true, typed: 1, pasted: 4 })
    expect((await r.run({ type: 'a héllo', node: 'sim1' })).message).toMatch(/typed 1 character and pasted 4 characters through the device pasteboard.*now holds that text/)
  })

  it('--key and --press translate to the helper commands', async () => {
    const r = rig()
    await r.run({ key: 'Enter', node: 'sim1' })
    await r.run({ key: 'a', mods: 'cmd', node: 'sim1' })
    await r.run({ press: 'home', node: 'sim1' })
    expect(r.sent).toEqual([
      { cmd: 'key', usage: 0x28 },
      { cmd: 'key', usage: 0x04, mods: ['cmd'] },
      { cmd: 'button', name: 'home' }
    ])
  })

  it('--wait-idle just waits and reports idle or not', async () => {
    const r = rig()
    expect(await r.run({ 'wait-idle': '', node: 'sim1' })).toMatchObject({ ok: true, result: { idle: true, waitedMs: 312 } })
    expect(r.waits).toEqual([[300, 5000, undefined]]) // a bare wait has no reaction grace
    r.idle.value = false
    expect((await r.run({ 'wait-idle': '', node: 'sim1' })).message).toMatch(/still changing/)
    expect(r.sent).toEqual([])
  })

  it('surfaces a helper refusal with its code', async () => {
    const r = rig()
    r.replies.set('tap', { ok: false, code: 'hid-failed', error: 'device did not accept the input' })
    expect(await r.run({ tap: '1,2', node: 'sim1' })).toMatchObject({ ok: false, error: 'sim-hid-failed: tap: device did not accept the input' })
  })
})

describe('--tap-label', () => {
  const tree: SimReply = {
    ok: true,
    screen: { width: 393, height: 852 },
    elements: [
      el({ label: 'General', role: 'AXStaticText', center: { x: 120, y: 430 } }),
      el({ label: 'General', role: 'AXCell', center: { x: 196, y: 430 } }),
      el({ label: 'Done', center: { x: 40, y: 60 } }),
      el({ label: 'Done', center: { x: 340, y: 800 } })
    ]
  }

  it('describes, resolves, taps the centre, and names what it tapped', async () => {
    const r = rig()
    r.replies.set('describe', tree)
    const out = await r.run({ 'tap-label': 'General', node: 'sim1' })
    expect(out.message).toBe('tapped Cell "General" (196,430) — screen settled after 312 ms')
    expect(r.sent.map((c) => c.cmd)).toEqual(['describe', 'tap'])
    expect(r.sent[1]).toEqual({ cmd: 'tap', x: 196, y: 430 })
  })

  it('refuses ambiguity and taps nothing', async () => {
    const r = rig()
    r.replies.set('describe', tree)
    const out = await r.run({ 'tap-label': 'Done', node: 'sim1' })
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/^sim-tap-label-ambiguous: 2 elements are labelled "Done"/) })
    expect(r.sent.map((c) => c.cmd)).toEqual(['describe'])
  })

  it('refuses a label that is not there, and mentions a partial tree', async () => {
    const r = rig()
    r.replies.set('describe', { ...tree, partial: true })
    const out = await r.run({ 'tap-label': 'Nope', node: 'sim1' })
    expect(out.error).toMatch(/^sim-tap-label-none: no element is labelled "Nope"/)
    expect(out.error).toMatch(/PARTIAL/)
  })
})

describe('--boot', () => {
  it('boots headless, waits for the device and reports it', async () => {
    const r = rig()
    const out = await r.run({ boot: '', udid: OTHER })
    expect(r.booted).toEqual([OTHER])
    expect(r.runs[0].opts).toEqual({ connectTimeoutMs: 60_000, tolerateShutdown: true })
    expect(out.message).toMatch(/^booted iPhone 15, screen 393×852 pt\. No Simulator window was opened\./)
  })

  it('a boot that is slow is a success with a next step, not a failure', async () => {
    const r = rig()
    r.failure.value = { ok: false, code: 'timeout', error: 'x' }
    const out = await r.run({ boot: '', udid: OTHER })
    expect(out.ok).toBe(true)
    expect(out.message).toMatch(/still starting/)
  })

  it('a boot simctl refuses is reported', async () => {
    const r = rig({
      service: {
        availability: () => ({ ok: true }),
        devices: async () => ({ devices: [] }),
        boot: async () => ({ ok: false, error: 'Unable to boot device because it cannot be located' }),
        agentRun: (async () => ({ ok: false })) as never
      }
    })
    expect(await r.run({ boot: '', udid: OTHER })).toMatchObject({ ok: false, error: 'sim-boot-failed: Unable to boot device because it cannot be located' })
  })
})

describe('the watch hint', () => {
  it('tells the agent once that the user cannot see a device no node shows', async () => {
    const r = rig()
    const first = await r.run({ 'wait-idle': '', udid: OTHER })
    expect(first.message).toMatch(/no Simulator node in this project shows this device/)
    const second = await r.run({ 'wait-idle': '', udid: OTHER })
    expect(second.message).not.toMatch(/no Simulator node/)
  })

  it('stays quiet for a device a node of the project shows', async () => {
    const out = await rig().run({ 'wait-idle': '', udid: UDID })
    expect(out.message).not.toMatch(/no Simulator node/)
  })
})

import { createOpenSimulatorPrep } from './control'
describe('open-simulator prep', () => {
  const mk = (devices: Array<{ udid: string; name: string; runtime: string; booted: boolean }>, ok = true) =>
    createOpenSimulatorPrep({
      service: { availability: () => (ok ? { ok: true } : { ok: false, code: 'unsupported', message: 'no' }), devices: async () => ({ devices }) } as never
    })
  const A = 'AE342EEF-B624-4060-B9E6-AE6E9EAAC24A'
  it('binds the single booted device, keeps an explicit udid, refuses unverified/malformed', async () => {
    const one = mk([{ udid: A, name: 'iPhone 15', runtime: 'iOS 26.5', booted: true }])
    expect(await one({ args: {}, verified: true })).toEqual({ args: { udid: A, 'device-name': 'iPhone 15' } })
    expect(await one({ args: {}, verified: false })).toMatchObject({ ok: false })
    expect(await one({ args: { udid: 'x' }, verified: true })).toMatchObject({ ok: false })
    const two = mk([
      { udid: A, name: 'a', runtime: 'r', booted: true },
      { udid: 'BE342EEF-B624-4060-B9E6-AE6E9EAAC24A', name: 'b', runtime: 'r', booted: true }
    ])
    expect(await two({ args: {}, verified: true })).toEqual({ args: {} })
    expect(await mk([], false)({ args: {}, verified: true })).toMatchObject({ ok: false })
  })
})
