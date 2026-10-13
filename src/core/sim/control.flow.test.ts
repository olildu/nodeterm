import { describe, expect, it } from 'vitest'
import type { SimReply, SimStatus } from '../../shared/sim'
import { createSimControl } from './control'
import type { AgentDevice, AgentRunOptions } from './service'

const UDID = 'android:nt_smoke_30'
const OTHER = 'AE342EEF-B624-4060-B9E6-AE6E9EAAC24A'
const status: SimStatus = {
  phase: 'live',
  device: { udid: UDID, name: 'Pixel', pixelWidth: 1080, pixelHeight: 2400, pointWidth: 400, pointHeight: 900, scale: 2.7, ready: true }
}
type Spec = { label: string; role?: string; y: number; value?: string }
const el = (s: Spec): Record<string, unknown> => ({
  label: s.label,
  value: s.value ?? null,
  identifier: null,
  role: s.role ?? 'AXButton',
  enabled: true,
  offscreen: false,
  clipped: false,
  frame: { x: 0, y: s.y - 10, width: 200, height: 20 },
  center: { x: 100, y: s.y }
})

function rig(files: Record<string, string> = {}) {
  const screens: Record<string, Spec[]> = {
    welcome: [{ label: 'Log in', y: 100 }],
    form: [
      { label: 'Email', role: 'AXTextField', y: 200 },
      { label: 'Password', role: 'AXSecureTextField', y: 260 },
      { label: 'Submit', y: 400 }
    ],
    home: [{ label: 'Home', role: 'AXStaticText', y: 50 }]
  }
  const st = { screen: 'welcome', focus: '' as string, typed: [] as string[], values: {} as Record<string, string>, dupSubmit: false }
  const current = (): Spec[] => {
    const base = screens[st.screen].map((s) => (st.values[s.label] ? { ...s, value: st.values[s.label] } : s))
    return st.dupSubmit && st.screen === 'form' ? [...base, { label: 'Submit', y: 600 }] : base
  }
  const clock = { t: 0 }
  const written: Array<{ abs: string; text: string }> = []
  const store = { ...files }
  const runs: unknown[] = []
  const device: AgentDevice = {
    status: () => status,
    command: async (cmd): Promise<SimReply> => {
      if (cmd.cmd === 'describe') return { ok: true, screen: { width: 400, height: 900 }, elements: current().map(el) } as SimReply
      if (cmd.cmd === 'tap') {
        const hit = current().find((s) => Math.abs(s.y - (cmd.y as number)) < 5)
        if (hit?.label === 'Log in') st.screen = 'form'
        if (hit?.label === 'Submit') st.screen = 'home'
        st.focus = hit?.label ?? ''
      }
      if (cmd.cmd === 'text') {
        st.typed.push(cmd.text as string)
        if (st.focus) st.values[st.focus] = cmd.text as string
        return { ok: true, typed: (cmd.text as string).length } as SimReply
      }
      return { ok: true }
    },
    screenshot: async () => ({ ok: true, format: 'png', width: 10, height: 10, data: new Uint8Array(8) }),
    waitIdle: async () => ({ idle: true, waitedMs: 10, changed: true })
  }
  const control = createSimControl({
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms
    },
    service: {
      availability: () => ({ ok: true }),
      devices: async () => ({ devices: [] }),
      boot: async () => ({ ok: true }),
      agentRun: (async (udid: unknown, _o: AgentRunOptions, fn: (d: AgentDevice) => Promise<unknown>) => {
        runs.push(udid)
        return { ok: true, value: await fn(device) }
      }) as never
    },
    projectIdOfNode: (id) => (id === 'agent' ? 'p1' : undefined),
    simulatorNodes: () => [],
    projectCwd: () => '/work/app',
    resolvePath: async (cwd, raw) => (raw.includes('..') ? { ok: false, message: 'sim: --screenshot path must be inside the project directory' } : { ok: true, abs: raw.startsWith('/') ? raw : `${cwd}/${raw}` }),
    tempDir: () => '/tmp',
    writeFile: async (abs, d) => {
      written.push({ abs, text: Buffer.from(d).toString() })
      store[abs] = Buffer.from(d).toString()
    },
    readFile: async (abs) => {
      if (!(abs in store)) throw new Error('ENOENT')
      return store[abs]
    },
    env: () => ({})
  })
  return { run: (args: Record<string, string>) => control({ nodeId: 'agent', args, verified: true }), st, screens, written, store, runs }
}

const LOGIN = `name: login
device: ${UDID}
steps:
  - tap: "Log in"
  - type: { into: "Email", text: "\${EMAIL}" }
  - type: { into: "Password", text: "\${PASSWORD}" }
  - tap: "Submit"
  - wait-for: "Home"
  - assert-not-visible: "Error"
  - screenshot: home
`
const FILE = '/work/app/.nodeterm/flows/login.yaml'
const P = '.nodeterm/flows/login.yaml'

describe('sim --run', () => {
  it('replays a flow under ONE lease, never prints a secret, and takes the flow\'s device', async () => {
    const r = rig({ [FILE]: LOGIN })
    const out = await r.run({ run: P, var: 'EMAIL=me@x.io', 'var-PASSWORD': 'hunter2' })
    expect(out.ok).toBe(true)
    expect(out.message).toMatch(/passed 7\/7 in/)
    expect(out.message).toMatch(/screenshots: \/tmp\/nodeterm-flow-login-/)
    expect(r.runs).toEqual([UDID])
    expect(r.st.typed).toEqual(['me@x.io', 'hunter2'])
    expect(JSON.stringify(out)).not.toContain('hunter2')
    expect(JSON.stringify(out)).not.toContain('me@x.io')
    expect(r.written[0].abs).toMatch(/^\/tmp\/nodeterm-flow-login-.*\/07-home\.png$/)
  })

  it('--udid beats the flow\'s device', async () => {
    const r = rig({ [FILE]: LOGIN })
    await r.run({ run: P, udid: OTHER, var: 'EMAIL=a\nPASSWORD=b' })
    expect(r.runs).toEqual([OTHER])
  })

  it('a missing variable fails before any lease', async () => {
    const r = rig({ [FILE]: LOGIN })
    const out = await r.run({ run: P, var: 'EMAIL=a' })
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/needs variable PASSWORD.*Nothing was run/) })
    expect(r.runs).toHaveLength(0)
  })

  it('an unreadable or invalid file is a named error', async () => {
    const r = rig({ '/work/app/bad.yaml': 'steps:\n  - press: sideways\n' })
    expect(await r.run({ run: 'nope.yaml', udid: UDID })).toMatchObject({ ok: false, error: expect.stringMatching(/sim-flow-invalid: .*could not read/) })
    expect(await r.run({ run: 'bad.yaml', udid: UDID })).toMatchObject({ ok: false, error: expect.stringMatching(/step 1.*--press takes/) })
    expect(r.runs).toHaveLength(0)
  })

  it('fails on an ambiguous step with a small, actionable report, then resumes with --from-step', async () => {
    const r = rig({ [FILE]: LOGIN })
    r.st.dupSubmit = true
    const args = { run: P, var: 'EMAIL=me@x.io', 'var-PASSWORD': 'hunter2' }
    const out = await r.run(args)
    expect(out.ok).toBe(false)
    const text = out.error as string
    expect(text).toMatch(/FAILED step 4\/7 \(login\.yaml step 4\): tap "Submit"/)
    expect(text).toMatch(/2 elements match the label "Submit"/)
    expect(text).toMatch(/screenshot: \/tmp\/nodeterm-flow-login-.*failed-step-04\.png/)
    expect(text).toMatch(/screen now:\nscreen [0-9a-f]{8}/)
    expect(text).toContain(`sim --run ${P} --udid ${UDID} --from-step 4 --var EMAIL=… --var PASSWORD=…`)
    expect(text).not.toContain('hunter2') // the Password field's value is on that screen, masked
    expect(out.result).toMatchObject({ failedStep: 4, resume: '--from-step 4' })
    // the agent fixes the step (index), then resumes: steps 1-3 are not repeated
    const typedBefore = r.st.typed.length
    const fixed = rig({ [FILE]: LOGIN.replace('tap: "Submit"', 'tap: { label: "Submit", index: 1 }') })
    fixed.st.dupSubmit = true
    fixed.st.screen = 'form'
    const again = await fixed.run({ ...args, 'from-step': '4' })
    expect(again.message).toMatch(/passed 7\/7 .*resumed from step 4; 4 run/)
    expect(fixed.st.typed).toHaveLength(0)
    expect(typedBefore).toBe(2)
  })

  it('a wait-for that never succeeds times out with the closest labels', async () => {
    const r = rig({ [FILE]: 'steps:\n  - wait-for: { label: "Homme", timeout: 1000 }\n' })
    const out = await r.run({ run: P, udid: UDID })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/FAILED step 1\/1.*wait-for "Homme"/)
    expect(out.error).toMatch(/did not appear within \d+ ms/)
    expect(out.error).toMatch(/Closest labels on screen: "Log in"/)
  })

  it('assert-not-visible fails while the element stays', async () => {
    const r = rig({ [FILE]: 'steps:\n  - assert-not-visible: { label: "Log in", timeout: 500 }\n' })
    const out = await r.run({ run: P, udid: UDID })
    expect(out.error).toMatch(/still on screen/)
  })
})

describe('sim --record / --record-stop', () => {
  it('logs label actions, writes a flow, and that flow replays', async () => {
    const r = rig()
    expect((await r.run({ record: 'login', udid: UDID })).ok).toBe(true)
    expect(await r.run({ record: 'again', udid: UDID })).toMatchObject({ ok: false, error: expect.stringMatching(/sim-recording-active/) })
    await r.run({ 'tap-label': 'Log in', udid: UDID })
    await r.run({ 'type-label': 'Email', text: 'me@x.io', udid: UDID })
    await r.run({ 'type-label': 'Password', text: 'hunter2', udid: UDID })
    await r.run({ describe: '', udid: UDID })
    await r.run({ tap: '100,400', udid: UDID })
    await r.run({ 'tap-label': 'Nonexistent', 'wait-for-ms': '0', udid: UDID }) // fails: not recorded
    const stop = await r.run({ 'record-stop': '', udid: UDID })
    expect(stop.ok).toBe(true)
    expect(stop.message).toMatch(/wrote \/work\/app\/\.nodeterm\/flows\/login\.yaml \(4 steps\)/)
    expect(stop.message).toMatch(/1 step taps a coordinate/)
    const yaml = r.store[FILE]
    expect(yaml).not.toContain('hunter2')
    expect(yaml).toContain('${PASSWORD}')
    expect(yaml).toContain('# TODO: use a label')
    expect(await r.run({ 'record-stop': '', udid: UDID })).toMatchObject({ ok: false, error: expect.stringMatching(/sim-no-recording/) })
    // replay from a fresh welcome screen
    r.st.screen = 'welcome'
    r.st.typed = []
    const replay = await r.run({ run: P, udid: UDID, 'var-PASSWORD': 'hunter2' })
    expect(replay.message).toMatch(/passed 4\/4/)
    expect(r.st.typed).toEqual(['me@x.io', 'hunter2'])
  })

  it('refuses to overwrite a flow and to stop an empty recording', async () => {
    const r = rig({ [FILE]: 'steps:\n  - press: home\n' })
    await r.run({ record: 'login', udid: UDID })
    expect(await r.run({ 'record-stop': '', udid: UDID })).toMatchObject({ ok: false, error: expect.stringMatching(/sim-recording-empty/) })
    await r.run({ press: 'home', udid: UDID })
    expect(await r.run({ 'record-stop': '', udid: UDID })).toMatchObject({ ok: false, error: expect.stringMatching(/sim-flow-exists/) })
    const out = await r.run({ 'record-stop': '', out: 'other.yaml', udid: UDID })
    expect(out.ok).toBe(true)
  })
})

describe('sim --wait-for', () => {
  it('waits for a label and reports', async () => {
    const r = rig()
    expect(await r.run({ 'wait-for': 'Log in', udid: UDID })).toMatchObject({ ok: true })
    expect(await r.run({ 'wait-for': 'Nope', 'wait-for-ms': '300', udid: UDID })).toMatchObject({ ok: false, error: expect.stringMatching(/sim-wait-for-none/) })
  })
})

describe('flags', () => {
  it('flow-only flags are refused elsewhere', async () => {
    const r = rig()
    expect(await r.run({ describe: '', 'from-step': '2', udid: UDID })).toMatchObject({ ok: false, error: expect.stringMatching(/apply to --run only/) })
    expect(await r.run({ run: 'x.txt' })).toMatchObject({ ok: false, error: expect.stringMatching(/\.yaml/) })
    expect(await r.run({ record: 'bad name', udid: UDID })).toMatchObject({ ok: false })
  })
})
