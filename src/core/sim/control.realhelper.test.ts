import os from 'node:os'
// The `sim` verb end to end against the REAL sim-helper and a BOOTED simulator. Skipped unless a
// device is named (CI has no Xcode), like service.realhelper.test.ts:
//
//   NODETERM_TEST_SIM_UDID=<booted udid> npx vitest run src/core/sim/control.realhelper.test.ts
//
// Run it ALONE: it and service.realhelper.test.ts each take the device's one-controller lock, so
// two real-helper files in one run race for it (`already-attached`).
//
// It only reads the accessibility tree, presses Home and takes a screenshot into a scratch project.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { testTmpDir } from '../test-tmp'
import { createSimControl } from './control'
import { prepareScreenshotParent } from './screenshot-dir'
import { createSimService } from './service'
import type { HelperChild } from './helper-process'

const UDID = process.env.NODETERM_TEST_SIM_UDID
const BIN = path.resolve(__dirname, '../../../resources/bin/sim-helper')
const run = UDID && fs.existsSync(BIN) ? describe : describe.skip

run('the sim verb against the real helper', () => {
  it('lists, reads, presses a button, screenshots into a new folder, and leaves one helper', async () => {
    const proj = fs.realpathSync(testTmpDir('simverb-'))
    const pids: number[] = []
    const svc = createSimService({
      isDarwin: true,
      helperPath: () => BIN,
      spawn: (bin, args) => {
        const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
        if (child.pid) pids.push(child.pid)
        return child as unknown as HelperChild
      },
      listDevices: async () => ({ devices: [{ udid: UDID!, name: 'device', runtime: 'iOS', booted: true }] }),
      boot: async () => ({ ok: false }),
      send: () => undefined,
      clientIds: () => []
    })
    const control = createSimControl({
      service: svc,
      projectIdOfNode: () => 'p1',
      simulatorNodes: () => [{ id: 'sim1', title: 'Phone', udid: UDID! }],
      projectCwd: () => proj,
      tempDir: () => os.tmpdir(),
      resolvePath: async (cwd, raw) => {
        await prepareScreenshotParent(cwd, raw, { realpath: (p) => fsp.realpath(p), mkdir: (p, o) => fsp.mkdir(p, o) })
        // The path jail itself lives in src/main (and core may not import it); here the path is ours.
        return { ok: true as const, abs: path.join(cwd!, raw) }
      },
      writeFile: (p, d) => fsp.writeFile(p, d)
    })
    const call = (args: Record<string, string>) => control({ nodeId: 'agent', args, verified: true })

    expect((await call({ list: '' })).message).toContain(`${UDID}`)

    const looked = await call({ describe: '', node: 'sim1' })
    expect(looked.ok).toBe(true)
    expect(looked.message).toMatch(/^Screen \d+×\d+ pt; \d+ named elements?/)

    const home = await call({ press: 'home', node: 'sim1' })
    expect(home).toMatchObject({ ok: true })
    expect(home.message).toMatch(/pressed home — (screen settled after \d+ ms|no visible change within \d+ ms)/)

    const shot = await call({ screenshot: 'shots/nested/home.png', node: 'sim1', scale: '0.3' })
    expect(shot.ok).toBe(true)
    const png = fs.readFileSync(path.join(proj, 'shots', 'nested', 'home.png'))
    expect(png.subarray(0, 4).toString('hex')).toBe('89504e47')

    // Every call above shared ONE helper process.
    expect(pids).toHaveLength(1)
    await svc.dispose()
  }, 90_000)
})
