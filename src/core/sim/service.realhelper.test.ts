// End to end against the REAL sim-helper and a BOOTED simulator. Skipped unless a device is named:
//
//   NODETERM_TEST_SIM_UDID=<booted udid> npx vitest run src/core/sim/service.realhelper.test.ts
//
// It drives the same `createSimService` the app registers, with the real child process, and only
// ever presses Home / taps the middle of the screen / reads the accessibility tree — it types
// nothing and launches nothing. CI has no Xcode, so it is skipped there like `*.realzellij.test.ts`.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { IPC } from '../../shared/ipc'
import type { SimStatus } from '../../shared/sim'
import { createSimService } from './service'
import type { HelperChild } from './helper-process'

const UDID = process.env.NODETERM_TEST_SIM_UDID
const BIN = path.resolve(__dirname, '../../../resources/bin/sim-helper')
const run = UDID && fs.existsSync(BIN) ? describe : describe.skip

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async <T>(what: string, get: () => T | undefined, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

run('sim service against the real helper', () => {
  it('attaches, streams frames with credit, drives input, screenshots, and releases the device', async () => {
    const statuses: SimStatus[] = []
    const frames: Buffer[] = []
    const pids: number[] = []
    const svc = createSimService({
      isDarwin: true,
      helperPath: () => BIN,
      spawn: (bin, args) => {
        const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
        if (child.pid) pids.push(child.pid)
        return child as unknown as HelperChild
      },
      listDevices: async () => ({ devices: [] }),
      boot: async () => ({ ok: false }),
      send: (_to, channel, ...args) => {
        if (channel === IPC.simStatus(UDID!)) statuses.push(args[0] as SimStatus)
        if (channel === IPC.simFrame(UDID!)) frames.push(args[0] as Buffer)
      },
      clientIds: () => [1],
      graceMs: 300
    })

    svc.attach(1, UDID!, 'e2e', { level: 'active', scale: 0.5 })
    const live = await until('live status', () => statuses.find((s) => s.phase === 'live'))
    expect(live.device?.pointWidth).toBeGreaterThan(0)
    expect(live.device?.name).toBeTruthy()

    // A frame is a JPEG; core stops after two until acked, then the newest follows.
    const first = await until('first frame', () => frames[0])
    expect(first.subarray(12, 14).toString('hex')).toBe('ffd8')
    svc.ackFrame(1, UDID!)
    svc.ackFrame(1, UDID!)

    const home = await svc.command(1, UDID!, { cmd: 'button', name: 'home' })
    expect(home.ok).toBe(true)
    const w = live.device!.pointWidth
    const h = live.device!.pointHeight
    expect((await svc.command(1, UDID!, { cmd: 'tap', x: w / 2, y: h / 2 })).ok).toBe(true)
    svc.input(1, UDID!, { cmd: 'touch', phase: 'down', x: w / 2, y: h / 2 })
    svc.input(1, UDID!, { cmd: 'touch', phase: 'move', x: w / 2, y: h / 2 - 40 })
    svc.input(1, UDID!, { cmd: 'touch', phase: 'up', x: w / 2, y: h / 2 - 40 })

    const tree = await svc.command(1, UDID!, { cmd: 'describe', flat: true })
    expect(tree.ok).toBe(true)
    expect(Number((tree as { count?: number }).count)).toBeGreaterThan(0)

    const shot = await svc.screenshot(1, UDID!)
    expect(shot.ok).toBe(true)
    if (shot.ok) {
      expect(shot.format).toBe('png')
      expect(Buffer.from(shot.data.subarray(0, 4)).toString('hex')).toBe('89504e47')
    }

    // A rejected command never reaches the device.
    expect(await svc.command(1, UDID!, { cmd: 'tap', x: NaN, y: 1 })).toMatchObject({ ok: false, code: 'bad-request' })

    // Turn the stream off: no new frames while nobody is looking.
    svc.setView(1, UDID!, 'e2e', { level: 'off' })
    await new Promise((r) => setTimeout(r, 400))
    const settled = frames.length
    await svc.command(1, UDID!, { cmd: 'button', name: 'home' })
    await new Promise((r) => setTimeout(r, 400))
    expect(frames.length).toBe(settled)

    // Last viewer leaves: the helper exits after the grace and releases the device lock...
    svc.detach(1, UDID!, 'e2e')
    await until('helper exit', () => (pids.length === 1 && !alive(pids[0]) ? true : undefined))
    expect(svc.activeDevices()).toEqual([])

    // ...so a fresh attach gets a working helper (not `already-attached`).
    svc.attach(1, UDID!, 'e2e', { level: 'active', scale: 0.5 })
    await until('second live status', () => statuses.slice(statuses.indexOf(live) + 1).find((s) => s.phase === 'live'))
    expect(pids).toHaveLength(2)
    await svc.dispose()
    await until('second helper exit', () => (!alive(pids[1]) ? true : undefined))
  }, 90_000)
})
