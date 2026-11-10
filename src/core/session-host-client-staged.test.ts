// Issue #829 step 3: the client hands the launcher a staged runtime (outside the install
// directory) when one is available, and the legacy launch (null) whenever staging fails.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const launcherMocks = vi.hoisted(() => ({
  resolveSessionHostScript: vi.fn(() => 'fake-session-host.cjs'),
  spawnSessionHost: vi.fn()
}))
const identityMocks = vi.hoisted(() => ({
  readExistingSessionHostIdentity: vi.fn(() => ({ kind: 'absent' })),
  startupLockState: vi.fn(() => 'other' as string),
  LISTEN_RETRY_BUDGET_MS: 120_000,
  EMPTY_LOCK_STALE_MS: 15_000
}))
vi.mock('./session-host-launcher', () => launcherMocks)
vi.mock('../session-host/existing-host-state', () => identityMocks)

import { SessionHostClient } from './session-host-client'
import { testTmpDir } from './test-tmp'

beforeEach(() => {
  vi.clearAllMocks()
  identityMocks.readExistingSessionHostIdentity.mockReturnValue({ kind: 'absent' })
})

// Each failing connect polls 30 × 150 ms for a host that never appears (the launcher is mocked).
// On the real clock that was 4.5 s per connect and 22.6 s for this file on CI;
// the pause is injected instead, so the loop still runs every attempt of its budget.
const connectPollSleep = vi.fn(async (_ms: number) => {})
const newClient = (
  stageRuntime?: (script: string) => Promise<{ exe: string; script: string } | null>
): SessionHostClient =>
  new SessionHostClient({ userDataDir: testTmpDir('nt-staged-'), stageRuntime, connectPollSleep })

const staged = { exe: 'C:\\L\\nodeterm\\session-host\\v\\nodeterm-sessionhost-v2.exe', script: 'C:\\L\\h.cjs' }

describe('SessionHostClient launches from a staged runtime when one is available', () => {
  it('passes the staged runtime to the launcher', async () => {
    const stageRuntime = vi.fn(async () => staged)
    const client = newClient(stageRuntime)
    await expect(client.listSessions()).rejects.toThrow()
    expect(stageRuntime).toHaveBeenCalledWith('fake-session-host.cjs')
    expect(launcherMocks.spawnSessionHost).toHaveBeenCalledTimes(1)
    expect(launcherMocks.spawnSessionHost.mock.calls[0][2]).toEqual(staged)
    // The ordinary budget is unchanged: 30 polls 150 ms apart (4.5 s) before giving up.
    expect(connectPollSleep).toHaveBeenCalledTimes(30)
    expect(connectPollSleep.mock.calls.every(([ms]) => ms === 150)).toBe(true)
  })

  it('falls back to the legacy launch when staging rejects', async () => {
    const stageRuntime = vi.fn(async () => {
      throw new Error('disk full')
    })
    const client = newClient(stageRuntime)
    await expect(client.listSessions()).rejects.toThrow()
    expect(launcherMocks.spawnSessionHost.mock.calls[0][2]).toBeNull()
  })

  it('stops offering the staged runtime after it failed to start once', async () => {
    const stageRuntime = vi.fn(async () => staged)
    const client = newClient(stageRuntime)
    await expect(client.listSessions()).rejects.toThrow()
    const onStagedFailure = launcherMocks.spawnSessionHost.mock.calls[0][3] as () => void
    onStagedFailure()
    await expect(client.listSessions()).rejects.toThrow()
    const last = launcherMocks.spawnSessionHost.mock.calls.at(-1)!
    expect(last[2]).toBeNull()
  })

  it('without a stager behaves exactly as before (no staged argument)', async () => {
    const client = newClient()
    await expect(client.listSessions()).rejects.toThrow()
    expect(launcherMocks.spawnSessionHost.mock.calls[0][2]).toBeNull()
  })
})
