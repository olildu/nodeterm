// `~/.nodeterm` on an SSH host is an owner-only umbrella (0700), not a world-traversable directory
// whose safety rests on every child's own mode. Run for real, under real shells, against a fake
// host tree — the same discipline as remote-write-truncation.test.ts.
//
// Before: `mkdir -p ~/.nodeterm` with no umask, so a fresh host got 0755 and an existing one kept
// whatever mode it had. Every secret inside was 0600 on its own, but a future file written there
// without an explicit mode would have been born world-readable inside a traversable directory.
import { allRemote } from './remote-hooks.test-plan'
import { spawnSync } from 'child_process'
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteHooks, privateRemoteDirCommand, type RemoteRunner } from './remote-hooks'

const conn = { host: 'fixture', user: 'fixture' }
let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'nt-private-dir-'))
  chmodSync(home, 0o755)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

/** A stock host: umask 022, so a bare `mkdir` makes 0755. */
function hostRunner(): RemoteRunner {
  return {
    run: async (args, stdin) => {
      const command = args.at(-1)!
      if (args[0] === '-O') return { code: 0, stdout: '' }
      if (command.includes('%{http_code}')) return { code: 0, stdout: '204' }
      const result = spawnSync('/bin/sh', ['-c', `umask 022; ${command}`], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
        input: stdin,
        encoding: 'utf8'
      })
      if (result.error) throw result.error
      return { code: result.status ?? 1, stdout: result.stdout }
    }
  }
}

const modeOf = (p: string) => statSync(p).mode & 0o777
const setup = () =>
  new RemoteHooks(hostRunner(), allRemote).setup('p1', conn, '/fixture.sock', { port: 51234, token: 'tok', version: '1' })

/** Every POSIX shell on this machine that a host's login shell could be. */
const SHELLS: string[][] = [['/bin/sh', '-c']]
for (const candidate of [['bash', '-c'], ['dash', '-c'], ['busybox', 'sh', '-c'], ['zsh', '-c']]) {
  if (spawnSync(candidate[0], [...candidate.slice(1), 'true']).status === 0) SHELLS.push(candidate)
}
const runIn = (shell: string[], command: string) =>
  spawnSync(shell[0], [...shell.slice(1), `umask 022; ${command}`], { encoding: 'utf8' })

describe.skipIf(process.platform === 'win32')('~/.nodeterm on the host is owner-only (real shells)', () => {
  it('setup() creates it 0700 on a fresh host', { timeout: 30_000 }, async () => {
    expect(await setup()).not.toBeNull()
    expect(modeOf(path.join(home, '.nodeterm'))).toBe(0o700)
  })

  it('setup() tightens an existing 0755 one, keeping its contents', { timeout: 30_000 }, async () => {
    mkdirSync(path.join(home, '.nodeterm', 'agent-hooks'), { recursive: true })
    chmodSync(path.join(home, '.nodeterm'), 0o755)
    expect(await setup()).not.toBeNull()
    expect(modeOf(path.join(home, '.nodeterm'))).toBe(0o700)
    expect(existsSync(path.join(home, '.nodeterm', 'agent-hooks'))).toBe(true)
  })

  for (const shell of SHELLS) {
    describe(shell.join(' '), () => {
      it('creates a missing dir 0700 and tightens an existing one', () => {
        const fresh = path.join(home, 'fresh', '.nodeterm')
        mkdirSync(path.dirname(fresh))
        expect(runIn(shell, privateRemoteDirCommand(fresh)).status).toBe(0)
        expect(modeOf(fresh)).toBe(0o700)
        const old = path.join(home, 'old')
        mkdirSync(old, { mode: 0o755 })
        chmodSync(old, 0o777)
        expect(runIn(shell, privateRemoteDirCommand(old)).status).toBe(0)
        expect(modeOf(old)).toBe(0o700)
      })

      it('never follows a symlink: the directory it points at keeps its mode', () => {
        const target = path.join(home, 'elsewhere')
        mkdirSync(target)
        chmodSync(target, 0o755)
        const link = path.join(home, 'linked')
        symlinkSync(target, link)
        runIn(shell, privateRemoteDirCommand(link))
        expect(lstatSync(link).isSymbolicLink()).toBe(true)
        expect(modeOf(target)).toBe(0o755)
      })

      it('quotes the path: a home with a space and a quote is one argument', () => {
        const odd = path.join(home, "it's a home", '.nodeterm')
        mkdirSync(path.dirname(odd))
        expect(runIn(shell, privateRemoteDirCommand(odd)).status).toBe(0)
        expect(modeOf(odd)).toBe(0o700)
      })
    })
  }

  // Only root can hand a directory to another user; that is the case `-O` exists for — a root
  // login whose `~/.nodeterm` belongs to someone else must not have its mode changed under it.
  it.skipIf(typeof process.getuid !== 'function' || process.getuid() !== 0)(
    "leaves a directory it does not own alone (root login, someone else's dir)",
    () => {
      const foreign = path.join(home, 'foreign')
      mkdirSync(foreign)
      chmodSync(foreign, 0o755)
      chownSync(foreign, 65534, 65534)
      runIn(['/bin/sh', '-c'], privateRemoteDirCommand(foreign))
      expect(modeOf(foreign)).toBe(0o755)
    }
  )
})
