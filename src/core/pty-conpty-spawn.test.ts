/**
 * The PtyManager's direct `pty.spawn` (the non-session-host branch) must spread the Windows ConPTY
 * option the shared helper decides — and add nothing when the helper answers `{}`, which is every
 * non-Windows platform. The helper's own decision is windows-conpty-dll.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import type { PtyCreateOptions, PtyCreateResult } from '../shared/types'
import { testTmpDir } from './test-tmp'

const spawned: Array<Record<string, unknown>> = []
let helperAnswer: { useConptyDll?: true } = {}

vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)
vi.mock('./windows-conpty-dll', () => ({
  windowsConptySpawnOptions: () => helperAnswer
}))
vi.mock('node-pty', () => ({
  spawn: (_file: string, _args: string[], options: Record<string, unknown>) => {
    spawned.push(options)
    return {
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => {},
      pid: 4321
    }
  }
}))
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

describe('pty create: ConPTY option on the direct spawn', () => {
  let fake: FakePlatform

  beforeEach(async () => {
    spawned.length = 0
    fake = fakePlatform({ userDataDir: testTmpDir('nodeterm-conpty-spawn-') })
    initPlatform(fake)
    const { PtyManager } = await import('./pty-manager')
    new PtyManager().registerIpc()
  })
  afterEach(() => resetPlatformForTests())

  const create = (persistKey: string) =>
    fake.handlers[IPC.ptyCreate](1, {
      cols: 80,
      rows: 24,
      persistKey,
      cwd: process.cwd()
    } as PtyCreateOptions) as Promise<PtyCreateResult>

  it('passes useConptyDll when the helper asks for the bundled ConPTY', async () => {
    helperAnswer = { useConptyDll: true }
    await create('node-a')
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({ name: 'xterm-256color', useConptyDll: true })
  })

  it('adds no key at all when the helper answers {}', async () => {
    helperAnswer = {}
    await create('node-b')
    expect(spawned).toHaveLength(1)
    expect('useConptyDll' in spawned[0]).toBe(false)
  })
})
