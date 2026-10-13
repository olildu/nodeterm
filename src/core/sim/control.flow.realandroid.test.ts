// `sim --run` / `--record` / `--wait-for` against the REAL android-helper and a REAL emulator.
// Skipped unless an AVD is named. The test BOOTS it through the service (so the helper owns it and
// stops it on dispose) — never name Nexus_7 here (device_app's), use a phone AVD:
//
//   npm run build:android-helper
//   NODETERM_TEST_ANDROID_AVD=nt_smoke_30 npx vitest run src/core/sim/control.flow.realandroid.test.ts
//
// Timings are printed to stderr.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { testTmpDir } from '../test-tmp'
import { createSimControl } from './control'
import { FLOW_YAML_MAX_BYTES } from './flow-yaml'
import { createSimService } from './service'
import type { HelperChild } from './helper-process'

const AVD = process.env.NODETERM_TEST_ANDROID_AVD
const ID = `android:${AVD}`
const SCRIPT = path.resolve(__dirname, '../../../resources/bin/android-helper.cjs')
const SDK = process.env.ANDROID_HOME ?? path.join(os.homedir(), 'Library/Android/sdk')
const ADB = path.join(SDK, 'platform-tools/adb')
const run = AVD && AVD !== 'Nexus_7' && fs.existsSync(SCRIPT) ? describe : describe.skip
const log = (s: string): void => void process.stderr.write(`${s}\n`)
const adb = (...a: string[]): Promise<string> =>
  new Promise((r) => execFile(ADB, a, (_e, out) => r(String(out))))

run('flows on a real Android emulator', () => {
  it('records, replays, fails usefully, resumes, waits, reads FLOW_ env', async () => {
    const proj = fs.realpathSync(testTmpDir('simflow-'))
    const svc = createSimService({
      isDarwin: process.platform === 'darwin',
      helperPath: () => null,
      spawn: (bin, args, env) => spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) }) as unknown as HelperChild,
      listDevices: async () => ({ devices: [] }),
      boot: async () => ({ ok: false }),
      android: {
        launch: () => ({ bin: process.execPath, args: [SCRIPT] }),
        listDevices: async () => ({ devices: [{ udid: ID, name: AVD!, runtime: 'Android', booted: true, platform: 'android' }] })
      },
      send: () => {},
      clientIds: () => []
    })
    const env: Record<string, string> = { FLOW_QUERY: 'wifi' }
    const control = createSimControl({
      service: svc,
      projectIdOfNode: () => 'p1',
      simulatorNodes: () => [],
      projectCwd: () => proj,
      tempDir: () => os.tmpdir(),
      resolvePath: async (cwd, raw) => {
        const abs = path.isAbsolute(raw) ? raw : path.join(cwd!, raw)
        await fsp.mkdir(path.dirname(abs), { recursive: true })
        return { ok: true as const, abs }
      },
      writeFile: (p, d) => fsp.writeFile(p, d),
      // The same read main/index.ts wires.
      readFile: async (abs) => {
        const fh = await fsp.open(abs, 'r')
        try {
          const buf = Buffer.alloc(FLOW_YAML_MAX_BYTES + 1)
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
          return buf.toString('utf8', 0, bytesRead)
        } finally {
          await fh.close()
        }
      },
      env: () => env
    })
    const call = async (args: Record<string, string>) => {
      const t0 = Date.now()
      const r = await control({ nodeId: 'agent', args: { udid: ID, ...args }, verified: true })
      return { r, ms: Date.now() - t0 }
    }
    try {
      // Boot headless (the helper owns the emulator and stops it on dispose).
      const tb = Date.now()
      const booted = await call({ boot: '', timeout: '60000' })
      log(`boot: ${booted.r.ok} in ${Date.now() - tb} ms — ${booted.r.message ?? booted.r.error}`)
      expect(booted.r.ok).toBe(true)
      // The boot call returns once the emulator is LAUNCHED; wait until the verb can see it.
      let up = false
      for (let i = 0; i < 40 && !up; i++) {
        const d = await call({ describe: '' })
        up = d.r.ok
        if (!up) {
          log(`  waiting for the device (${i}): ${String(d.r.error).slice(0, 120)}`)
          await new Promise((r) => setTimeout(r, 3000))
        }
      }
      expect(up).toBe(true)
      const serial = (/emulator-\d+/.exec(await adb('devices')) ?? [])[0]!
      for (let i = 0; i < 60 && !(await adb('-s', serial, 'shell', 'getprop', 'sys.boot_completed')).startsWith('1'); i++) await new Promise((r) => setTimeout(r, 1000))
      const settings = async (): Promise<void> => {
        await adb('-s', serial, 'shell', 'am', 'force-stop', 'com.android.settings')
        await adb('-s', serial, 'shell', 'am', 'start', '-a', 'android.settings.SETTINGS')
        await call({ 'wait-for': 'Search settings', 'wait-for-ms': '20000' })
      }
      await settings()

      // 1. record a flow by doing it, one verb at a time
      expect((await call({ record: 'smoke' })).r.ok).toBe(true)
      const t1 = Date.now()
      const steps: Array<Record<string, string>> = [
        { 'tap-label': 'Search settings', 'wait-for-ms': '5000' },
        { 'type-label': 'Search…', text: '${QUERY}'.replace('${QUERY}', 'wifi'), 'wait-for-ms': '3000' },
        { 'wait-for': 'Wi‑Fi', 'wait-for-ms': '8000' },
        { press: 'back' }
      ]
      for (const s of steps) {
        const { r, ms } = await call(s)
        log(`  verb ${Object.keys(s)[0]}: ${r.ok} ${ms} ms${r.ok ? '' : ` — ${r.error}`}`)
      }
      const verbMs = Date.now() - t1
      const stop = await call({ 'record-stop': '' })
      log(`record-stop: ${stop.r.message ?? stop.r.error}`)
      expect(stop.r.ok).toBe(true)
      const file = path.join(proj, '.nodeterm/flows/smoke.yaml')
      log(fs.readFileSync(file, 'utf8'))

      // 2. replay it, end to end, with a variable from the FLOW_ environment
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"wifi"', '"${QUERY}"'))
      await call({ press: 'back' })
      await settings()
      const ran = await call({ run: '.nodeterm/flows/smoke.yaml' })
      log(`RUN:\n${ran.r.message ?? ran.r.error}`)
      log(`timings: one-at-a-time ${verbMs} ms (${steps.length} steps) vs --run ${ran.ms} ms`)
      expect(ran.r.ok).toBe(true)
      expect((await call({ run: '.nodeterm/flows/smoke.yaml', 'var': 'QUERY=bluetooth' })).r.ok).toBe(false) // wrong query: Wi‑Fi never listed

      // 3. a deliberately broken step: failure report, fix, --from-step
      await settings()
      const broken = path.join(proj, '.nodeterm/flows/broken.yaml')
      fs.writeFileSync(
        broken,
        `name: broken\nsteps:\n  - tap: "Search settings"\n  - type: { into: "Search…", text: "\${QUERY}" }\n  - tap: "Wi-Fi Typo"\n  - press: back\n`
      )
      const bad = await call({ run: '.nodeterm/flows/broken.yaml' })
      log(`BROKEN:\n${bad.r.error}`)
      expect(bad.r.ok).toBe(false)
      expect(bad.r.error).toMatch(/FAILED step 3\/4/)
      expect(bad.r.error).toMatch(/--from-step 3/)
      fs.writeFileSync(broken, fs.readFileSync(broken, 'utf8').replace('Wi-Fi Typo', 'Wi‑Fi'))
      const fixed = await call({ run: '.nodeterm/flows/broken.yaml', 'from-step': '3' })
      log(`RESUMED:\n${fixed.r.message ?? fixed.r.error}`)
      expect(fixed.r.message ?? '').toMatch(/resumed from step 3/)
    } finally {
      await svc.dispose() // stops the emulator the helper booted
    }
  }, 600_000)
})
