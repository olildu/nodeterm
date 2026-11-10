import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import type { PtyCreateOptions, PtyCreateResult } from '../shared/types'

/**
 * `requireRemote`: a node that belongs to a remote host is never spawned locally.
 *
 * The bug this pins: an SSH project's terminal, created while its ControlMaster was down (no
 * network, host unreachable), used to fall straight through to the LOCAL tmux/plain-shell branch —
 * a local shell in the local `$HOME` carrying the remote node's id, its `SSH user@host` header
 * chip, and (agent nodes) a cold-restore `--resume` typed on the wrong machine. Nothing in the
 * result said so, so it read as "the session reconnected".
 */
const spawned: Array<{ file: string; args: string[] }> = []

// Pin the persistence backend: `sessionHostSupported()` only asks whether
// out/session-host/host.cjs exists on disk, so whether this suite exercises the mocked
// `node-pty` spawn below or a real session-host shim depended on whether anyone had run
// `npm run build` (or `npm run host:build`). See src/core/__fixtures__/no-session-host.ts.
vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[]) => {
    spawned.push({ file, args })
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

const ALICE = 1
const BOB = 2

/**
 * A machine with pty devices to spare, always.
 *
 * Without this the real probe runs a `readdir('/dev')` against the DEVELOPER's host, and
 * `spawnSession`'s pre-flight refuses every create once that host is within `PTY_DEVICE_HEADROOM`
 * of its own `kern.tty.ptmx_max` — which a machine running this app all day genuinely reaches (511
 * on macOS; this one sits in the 480s). Nothing below is about device pressure, so it is pinned
 * healthy rather than left to depend on who is running the suite and how many terminals they have
 * open. The pressure behaviour itself is tested in pty-spawn-preflight.test.ts.
 */
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

// The "still JOINS" case holds a REMOTE session, whose spawn needs `findSsh` to resolve (without it
// the remote branch is skipped) and whose agent-socket probe would run a real `ssh -G`. Every other
// executable lookup is the real one.
vi.mock('./exec-path', async (importOriginal) => {
  const real = await importOriginal<typeof import('./exec-path')>()
  return {
    ...real,
    findExecutableSync: (bin: string, fallbacks?: string[]) =>
      bin === 'ssh' ? '/usr/bin/ssh' : real.findExecutableSync(bin, fallbacks)
  }
})
vi.mock('./remote-ssh/agent-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./remote-ssh/agent-probe')>()),
  probeAgentSockToPin: async () => undefined
}))

describe('pty create: requireRemote never falls back to a local shell', () => {
  let fake: FakePlatform
  let manager: import('./pty-manager').PtyManager

  beforeEach(async () => {
    spawned.length = 0
    fake = fakePlatform()
    initPlatform(fake)
    const { PtyManager } = await import('./pty-manager')
    manager = new PtyManager()
    manager.registerIpc()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetPlatformForTests()
  })

  const create = (clientId: number, options: Partial<PtyCreateOptions>) =>
    fake.handlers[IPC.ptyCreate](clientId, {
      cols: 80,
      rows: 24,
      persistKey: 'node-1',
      ...options
    }) as Promise<PtyCreateResult>

  it('refuses (spawning nothing) when the master is gone', async () => {
    const res = await create(ALICE, { requireRemote: true, cwd: '/srv/app' })

    expect(spawned).toHaveLength(0) // ← the whole point: no local shell wearing a remote node's id
    expect(res.unavailable).toBe('ssh')
    expect(res.sessionId).toBe('')
    expect(res.fresh).toBe(false) // nothing was created, so nothing is "cold"
  })

  it('without the flag the same options DO spawn locally (what used to happen silently)', async () => {
    const res = await create(ALICE, { cwd: '/srv/app' })

    expect(spawned).toHaveLength(1)
    expect(res.unavailable).toBeUndefined()
    expect(res.sessionId).not.toBe('')
  })

  it('still JOINS a live REMOTE session for that node — only a fresh local spawn is refused', async () => {
    // The session is already running on the host (it was created while the master was up). A
    // second view — the kanban card modal, another window — whose master is momentarily down must
    // attach to it: refusing the join would break a perfectly healthy remote terminal. (A held
    // LOCAL session is the opposite case and is refused: pty-require-remote-join.test.ts.)
    const internals = manager as unknown as {
      remoteSessionVerdict: () => Promise<string>
      captureForResync: (s: string) => Promise<string>
      paneCursor: (s: string) => Promise<unknown>
    }
    // No host to ask: the freshness read answers "absent" (so the first create spawns its ssh
    // client) and the joiner's paint capture answers nothing, instead of running a real ssh.
    vi.spyOn(internals, 'remoteSessionVerdict').mockResolvedValue('absent')
    vi.spyOn(internals, 'captureForResync').mockResolvedValue('')
    vi.spyOn(internals, 'paneCursor').mockResolvedValue(undefined)
    const first = await create(ALICE, {
      requireRemote: true,
      sshRemote: { controlPath: '/tmp/nt-test-cm-require-remote', conn: { host: 'h1', user: 'u' }, remoteCwd: '/srv/app' }
    })
    expect(first.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].file).toBe('/usr/bin/ssh') // the remote branch, never a local shell

    const joined = await create(BOB, { requireRemote: true })

    expect(spawned).toHaveLength(1)
    expect(joined.unavailable).toBeUndefined()
    expect(joined.sessionId).toBe(first.sessionId)
  })

  // Issue #1186: `requireRemote` comes from the node's own fields, which reach a node through a
  // SHARED file the host's desktop also writes. The owning project — a machine-local fact — must
  // refuse the local spawn on its own when a caller forgot to route the node.
  describe('a node owned by an SSH project (issue #1186)', () => {
    const sshProjects = new Set(['ssh-p'])
    beforeEach(() => manager.setSshProjectCheck((id) => sshProjects.has(id)))

    it('refuses a local spawn with no requireRemote and no sshRemote', async () => {
      const res = await create(ALICE, { ownerProjectId: 'ssh-p', cwd: '.', agentId: 'codex' })
      expect(spawned).toHaveLength(0)
      expect(res.unavailable).toBe('ssh')
    })

    it('a LOCAL project still spawns locally', async () => {
      const res = await create(ALICE, { ownerProjectId: 'local-p', cwd: '/srv/app' })
      expect(spawned).toHaveLength(1)
      expect(res.unavailable).toBeUndefined()
    })

    it('a plain `ssh <host>` terminal is a local pty by design and still spawns', async () => {
      const res = await create(ALICE, { ownerProjectId: 'ssh-p', shell: 'ssh', shellArgs: ['-p', '22', 'u@h'] })
      expect(spawned).toHaveLength(1)
      expect(res.unavailable).toBeUndefined()
    })

    it('the renderer-marked local login node still spawns', async () => {
      const res = await create(ALICE, { ownerProjectId: 'ssh-p', localOnSshCanvas: true })
      expect(spawned).toHaveLength(1)
      expect(res.unavailable).toBeUndefined()
    })

    it('unwired: no refusal (the pre-check behaviour)', async () => {
      manager.setSshProjectCheck(null)
      const res = await create(ALICE, { ownerProjectId: 'ssh-p' })
      expect(spawned).toHaveLength(1)
      expect(res.unavailable).toBeUndefined()
    })
  })
})
