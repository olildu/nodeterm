// The sim service and the `sim` verb end to end against the REAL android-helper and a RUNNING
// Android emulator. Skipped unless an AVD is named (CI has no Android SDK):
//
//   npm run build:android-helper
//   NODETERM_TEST_ANDROID_AVD=<running avd> npx vitest run src/core/sim/control.realandroid.test.ts
//
// The emulator must already be running (the test never boots one, and the helper never stops an
// emulator it did not start). It presses Home/Back, reads the UI tree and takes screenshots.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { IPC } from '../../shared/ipc'
import type { SimStatus } from '../../shared/sim'
import { testTmpDir } from '../test-tmp'
import { createSimControl } from './control'
import { createSimService } from './service'
import type { HelperChild } from './helper-process'

const AVD = process.env.NODETERM_TEST_ANDROID_AVD
const ID = `android:${AVD}`
const SCRIPT = path.resolve(__dirname, '../../../resources/bin/android-helper.cjs')
const run = AVD && fs.existsSync(SCRIPT) ? describe : describe.skip

const until = async <T>(what: string, get: () => T | undefined, ms = 30_000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

run('an Android emulator through the sim service and verb', () => {
  it('attaches, streams JPEG frames, drives it from a node and an agent through ONE helper', async () => {
    const proj = fs.realpathSync(testTmpDir('simandroid-'))
    const statuses: SimStatus[] = []
    const frames: Buffer[] = []
    const pids: number[] = []
    const svc = createSimService({
      isDarwin: process.platform === 'darwin',
      helperPath: () => null,
      spawn: (bin, args, env) => {
        const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) })
        if (child.pid) pids.push(child.pid)
        return child as unknown as HelperChild
      },
      listDevices: async () => ({ devices: [] }),
      boot: async () => ({ ok: false }),
      android: {
        launch: () => ({ bin: process.execPath, args: [SCRIPT] }),
        listDevices: async () => ({ devices: [{ udid: ID, name: AVD!, runtime: 'Android', booted: true, platform: 'android' }] })
      },
      send: (_to, channel, ...args) => {
        if (channel === IPC.simStatus(ID)) statuses.push(args[0] as SimStatus)
        if (channel === IPC.simFrame(ID)) frames.push(args[0] as Buffer)
      },
      clientIds: () => [1]
    })

    svc.attach(1, ID, 'e2e', { level: 'active', scale: 0.5 })
    const live = await until('live status', () => statuses.find((s) => s.phase === 'live'), 60_000)
    expect(live.device).toMatchObject({ udid: ID, platform: 'android', ready: true })
    expect(live.device!.pointWidth).toBeGreaterThan(0)

    const first = await until('first frame', () => frames[0])
    expect(first.subarray(12, 14).toString('hex')).toBe('ffd8')
    svc.ackFrame(1, ID)

    expect((await svc.command(1, ID, { cmd: 'button', name: 'home' })).ok).toBe(true)

    const control = createSimControl({
      service: svc,
      projectIdOfNode: () => 'p1',
      simulatorNodes: () => [{ id: 'sim1', title: 'Android', udid: ID }],
      projectCwd: () => proj,
      tempDir: () => os.tmpdir(),
      resolvePath: async (cwd, raw) => ({ ok: true as const, abs: path.join(cwd!, raw) }),
      writeFile: (p, d) => fsp.writeFile(p, d)
    })
    const call = (args: Record<string, string>) => control({ nodeId: 'agent', args, verified: true })

    expect((await call({ list: '' })).message).toContain(ID)
    const looked = await call({ describe: '', node: 'sim1' })
    expect(looked.ok).toBe(true)
    expect(looked.message).toMatch(/^Screen \d+×\d+ pt; \d+ named elements?/)
    const back = await call({ press: 'back', node: 'sim1' })
    expect(back).toMatchObject({ ok: true })
    const siri = await call({ press: 'siri', node: 'sim1' })
    expect(siri.ok).toBe(false)
    const shot = await call({ screenshot: 'home.png', node: 'sim1', scale: '0.3' })
    expect(shot.ok).toBe(true)
    expect(fs.readFileSync(path.join(proj, 'home.png')).subarray(0, 4).toString('hex')).toBe('89504e47')

    // The node and the agent shared ONE helper process.
    expect(pids).toHaveLength(1)
    await svc.dispose()
  }, 120_000)
})
