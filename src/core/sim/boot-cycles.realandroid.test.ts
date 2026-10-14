// Cold-boot cycles against the REAL android-helper and a REAL emulator, with timestamps. This is the
// repro harness for "sim --boot says still starting, then the device looks shut down".
// Skipped unless an AVD is named (never Nexus_7). Scenarios: NODETERM_TEST_BOOT_SCENARIOS=plain,double,
// immediate,grace (comma list; default plain). Cycles per scenario: NODETERM_TEST_BOOT_CYCLES (default 1).
//
//   NODETERM_TEST_ANDROID_AVD=nt_smoke_30 npx vitest run src/core/sim/boot-cycles.realandroid.test.ts
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createSimControl } from './control'
import { createSimService, parseAndroidList } from './service'
import type { HelperChild } from './helper-process'

const AVD = process.env.NODETERM_TEST_ANDROID_AVD
const ID = `android:${AVD}`
const SCRIPT = path.resolve(__dirname, '../../../resources/bin/android-helper.cjs')
const SDK = process.env.ANDROID_HOME ?? path.join(os.homedir(), 'Library/Android/sdk')
const ADB = path.join(SDK, 'platform-tools/adb')
const run = AVD && AVD !== 'Nexus_7' && fs.existsSync(SCRIPT) ? describe : describe.skip
const T0 = Date.now()
const log = (s: string): void => void process.stderr.write(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s] ${s}\n`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const exec = (bin: string, a: string[], env?: Record<string, string>): Promise<string> =>
  new Promise((r) => execFile(bin, a, { env: env ?? process.env, timeout: 20_000 }, (_e, out) => r(String(out))))
const scenarios = (process.env.NODETERM_TEST_BOOT_SCENARIOS ?? 'plain').split(',')
const cycles = Number(process.env.NODETERM_TEST_BOOT_CYCLES ?? '1')
const launchEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  env.ELECTRON_RUN_AS_NODE = '1'
  return env
}
/** The same lister the app wires: `android-helper list`. */
const realList = async () => parseAndroidList(await exec(process.execPath, [SCRIPT, 'list'], launchEnv()))
const emulatorProcs = async (): Promise<string> =>
  (
    await exec('/bin/sh', [
      '-c',
      `ps -axo pid,etime,command | grep -E 'qemu-system|emulator' | grep -E -- '-avd ${AVD}' | grep -v grep | awk '{print $1"("$2")"}' | tr '\\n' ' '`
    ])
  ).trim()

function makeEnv(grace?: number) {
  const svc = createSimService({
    isDarwin: process.platform === 'darwin',
    helperPath: () => null,
    spawn: (bin, args, env) => {
      const c = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) })
      log(`helper spawn pid=${c.pid} ${args.slice(-2).join(' ')}`)
      c.stderr?.on('data', (d: Buffer) => String(d).split('\n').filter(Boolean).forEach((l) => log(`  helper> ${l.slice(0, 200)}`)))
      c.on('exit', (code, sig) => log(`helper pid=${c.pid} EXIT code=${code} sig=${sig}`))
      return c as unknown as HelperChild
    },
    listDevices: async () => ({ devices: [] }),
    boot: async () => ({ ok: false }),
    android: {
      launch: () => ({ bin: process.execPath, args: [SCRIPT], env: launchEnv() }),
      listDevices: realList,
      ...(grace !== undefined ? { graceMs: grace } : {})
    },
    send: () => {},
    clientIds: () => []
  })
  const control = createSimControl({
    service: svc,
    projectIdOfNode: () => 'p1',
    simulatorNodes: () => [],
    projectCwd: () => os.tmpdir(),
    tempDir: () => os.tmpdir(),
    resolvePath: async (cwd, raw) => ({ ok: true as const, abs: path.isAbsolute(raw) ? raw : path.join(cwd!, raw) }),
    writeFile: async () => {},
    readFile: async () => '',
    env: () => ({})
  })
  const call = async (label: string, args: Record<string, string>) => {
    const t = Date.now()
    const r = await control({ nodeId: 'agent', args: { udid: ID, ...args }, verified: true })
    log(`${label}: ok=${r.ok} ${Date.now() - t}ms — ${String(r.message ?? r.error).slice(0, 160).replace(/\n/g, ' | ')}`)
    return r
  }
  return { svc, control, call }
}

/** Stop only OUR AVD's emulator (other sessions may run other devices; Nexus_7 is device_app's). */
async function killEmulator(): Promise<void> {
  const serials = (await exec(ADB, ['devices'])).match(/emulator-\d+/g) ?? []
  for (const serial of serials) {
    const name = (await exec(ADB, ['-s', serial, 'emu', 'avd', 'name'])).split('\n')[0].trim()
    if (name === AVD) await exec(ADB, ['-s', serial, 'emu', 'kill'])
  }
  for (let i = 0; i < 30 && (await emulatorProcs()) !== ''; i++) await sleep(1000)
}

/** Poll the way an agent would: describe (which fails fast on a shut-down device) and the lister. */
async function pollUntilUp(call: ReturnType<typeof makeEnv>['call'], maxMs = 90_000): Promise<{ up: boolean; sawShutdownAfterLive: boolean }> {
  const end = Date.now() + maxMs
  let up = false
  while (Date.now() < end && !up) {
    const l = await realList()
    const mine = l.devices.find((d) => d.udid === ID)
    log(`  list: ${mine ? (mine.booted ? 'Booted' : 'Shutdown') : 'absent'} procs=[${await emulatorProcs()}]`)
    const d = await call('  describe', { describe: '' })
    up = d.ok
    if (!up) await sleep(2000)
  }
  return { up, sawShutdownAfterLive: false }
}

run('android cold boot cycles', () => {
  // The helper and the emulator write their lock/log/scratch files to TMPDIR (the run's sandbox).
  afterAll(() => {
    for (const n of fs.readdirSync(os.tmpdir())) if (/^(nodeterm-android|android-|hostapd_)/.test(n)) fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true })
  })
  for (const scenario of scenarios) {
    it(`scenario ${scenario} x${cycles}`, async () => {
      let pass = 0
      const shared = scenario === 'grace' ? makeEnv() : null
      for (let i = 1; i <= cycles; i++) {
        log(`===== ${scenario} cycle ${i}/${cycles} =====`)
        await killEmulator()
        const env = shared ?? makeEnv()
        const { call, svc } = env
        const t = Date.now()
        if (scenario === 'double') {
          await Promise.all([call('boot#1', { boot: '', timeout: '60000' }), call('boot#2', { boot: '', timeout: '60000' })])
        } else if (scenario === 'immediate') {
          await svc.boot(ID)
          await call('immediate describe', { describe: '' })
          await call('boot', { boot: '', timeout: '60000' })
        } else {
          await call('boot', { boot: '', timeout: '60000' })
        }
        const r = await pollUntilUp(call)
        log(`cycle ${i} ${scenario}: ${r.up ? 'UP' : 'FAILED'} after ${Date.now() - t}ms`)
        if (r.up) pass++
        if (!shared) await svc.dispose()
      }
      if (shared) await shared.svc.dispose()
      await killEmulator()
      log(`RESULT ${scenario}: ${pass}/${cycles}`)
      expect(pass).toBe(cycles)
    }, 30 * 60_000)
  }
})
