import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

/**
 * THE BOOT-PATH tmux CALLS ARE BOUNDED.
 *
 * `ensureTmux`'s `source-file` runs on the main thread before the first window exists, and
 * `ensureUpdateEnvKeys`' `show-options` / `set-option` run on a spawn. All three were
 * `execFileSync` with no timeout, so a tmux server that accepts the connection and never answers
 * held main for as long as it stayed wedged (4.05 s in a repro — the listener's whole
 * lifetime). These pin the contract with an injected `execFileSync`: every call carries the bound,
 * a timeout is WARNED and fails open and starts a cooldown with no further spawn-path probe, and
 * the ordinary "no server yet" failure stays as silent as it always was. The real-tmux proof is
 * `pty-tmux-wedged.realtmux.test.ts`.
 */

type ExecCall = { args: string[]; opts: { timeout?: number; killSignal?: string } }
const execState = vi.hoisted(() => ({
  calls: [] as ExecCall[],
  /** Per-subcommand behaviour: a string is stdout, an object is thrown. */
  reply: new Map<string, string | object>()
}))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const execFileSync = (_file: string, args: string[], opts: ExecCall['opts']): Buffer => {
    execState.calls.push({ args, opts })
    const r = execState.reply.get(args[2])
    if (r !== undefined && typeof r !== 'string') throw r
    return Buffer.from(r ?? '')
  }
  return { ...actual, default: { ...actual, execFileSync }, execFileSync }
})
vi.mock('./exec-path', () => ({
  resolveShellPath: () => Promise.resolve(null),
  shellPathNow: () => undefined,
  findInPathString: () => null,
  findExecutableSync: () => null
}))
vi.mock('node-pty', () => ({ spawn: () => ({ onData: () => {}, onExit: () => {}, kill: () => {} }) }))
// Hermetic resolution (see pty-single-user.test.ts, issue #160): tmux is "installed", nothing real runs.
vi.mock('./tmux-hint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tmux-hint')>()),
  findFixedTmux: () => '/usr/bin/tmux'
}))

/** The shape Node gives `execFileSync` when `timeout` fires (measured: code ETIMEDOUT, status null). */
const TIMED_OUT = Object.assign(new Error('spawnSync /usr/bin/tmux ETIMEDOUT'), {
  code: 'ETIMEDOUT',
  signal: 'SIGKILL',
  status: null
})
/** The shape of "no server running on this socket": a plain non-zero exit. */
const NO_SERVER = Object.assign(new Error('Command failed'), { status: 1, signal: null })

const callsFor = (verb: string): ExecCall[] => execState.calls.filter((c) => c.args[2] === verb)

async function boot() {
  const { PtyManager, TMUX_BOOT_CMD_TIMEOUT_MS } = await import('./pty-manager')
  const mgr = new PtyManager()
  mgr.init(() => ({ tmuxEnabled: true, tmuxScrollback: 10_000 }) as never)
  const ensureUpdateEnvKeys = (names: string[]): void =>
    (mgr as unknown as { ensureUpdateEnvKeys: (n: string[]) => void }).ensureUpdateEnvKeys(names)
  return { mgr, ensureUpdateEnvKeys, TMUX_BOOT_CMD_TIMEOUT_MS }
}

describe('boot-path tmux calls under a wedged server', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    execState.calls.length = 0
    execState.reply.clear()
    initPlatform(fakePlatform())
    // ensureTmux writes the generated tmux.conf into userDataDir; the fake's dir does not exist.
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetPlatformForTests()
  })

  it('source-file carries the bound and a SIGKILL, and a healthy server is unchanged', async () => {
    const { mgr, TMUX_BOOT_CMD_TIMEOUT_MS } = await boot()
    const [push] = callsFor('source-file')
    expect(push.args.slice(0, 3)).toEqual(['-L', 'node-terminal', 'source-file'])
    expect(push.opts.timeout).toBe(TMUX_BOOT_CMD_TIMEOUT_MS)
    expect(push.opts.killSignal).toBe('SIGKILL')
    expect(mgr.getTmuxBin()).toBe('/usr/bin/tmux')
    expect(warn).not.toHaveBeenCalled()
  })

  it('a source-file timeout is logged and tmux stays resolved (fail open)', async () => {
    execState.reply.set('source-file', TIMED_OUT)
    const { mgr } = await boot()
    expect(mgr.getTmuxBin()).toBe('/usr/bin/tmux')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/tmux source-file .*timed out after 2000ms/)
  })

  it('"no server yet" stays silent, exactly as before', async () => {
    execState.reply.set('source-file', NO_SERVER)
    execState.reply.set('show-options', NO_SERVER)
    execState.reply.set('set-option', NO_SERVER)
    const { mgr, ensureUpdateEnvKeys } = await boot()
    ensureUpdateEnvKeys(['MY_KEY'])
    expect(mgr.getTmuxBin()).toBe('/usr/bin/tmux')
    expect(callsFor('set-option')).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a show-options timeout skips every set-option, then no spawn probes until the cooldown ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { ensureUpdateEnvKeys, TMUX_UPDATE_ENV_COOLDOWN_MS } = await bootWithCooldown()
    execState.reply.set('show-options', TIMED_OUT)
    ensureUpdateEnvKeys(['KEY_A', 'KEY_B', 'KEY_C'])
    // One stall, not 1 + 3: the set-options would only wait out the same wedge.
    expect(callsFor('show-options')).toHaveLength(1)
    expect(callsFor('set-option')).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)

    // Every spawn passes the account-scope names, so a re-probe per spawn would stall main up to
    // 2 s per terminal on a slow server. Inside the cooldown no sync tmux call runs at all.
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(TMUX_UPDATE_ENV_COOLDOWN_MS / 25)
      ensureUpdateEnvKeys(['KEY_A', 'KEY_B'])
    }
    expect(callsFor('show-options')).toHaveLength(1)
    expect(callsFor('set-option')).toHaveLength(0)

    // The server recovers and the cooldown ends: the cache was left unset, so the next spawn
    // probes it properly.
    vi.advanceTimersByTime(TMUX_UPDATE_ENV_COOLDOWN_MS)
    execState.reply.set('show-options', 'update-environment[0] KEY_A\n')
    ensureUpdateEnvKeys(['KEY_A', 'KEY_B'])
    expect(callsFor('show-options')).toHaveLength(2)
    expect(callsFor('set-option').map((c) => c.args[5])).toEqual(['KEY_B'])
    vi.useRealTimers()
  })

  it('a set-option timeout stops the loop after the first name and starts the same cooldown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { ensureUpdateEnvKeys, TMUX_UPDATE_ENV_COOLDOWN_MS } = await bootWithCooldown()
    execState.reply.set('set-option', TIMED_OUT)
    ensureUpdateEnvKeys(['KEY_A', 'KEY_B', 'KEY_C'])
    expect(callsFor('set-option')).toHaveLength(1)
    for (const c of [...callsFor('show-options'), ...callsFor('set-option')]) {
      expect(c.opts.timeout).toBe(2000)
      expect(c.opts.killSignal).toBe('SIGKILL')
    }
    expect(warn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(TMUX_UPDATE_ENV_COOLDOWN_MS - 1)
    ensureUpdateEnvKeys(['KEY_A', 'KEY_B', 'KEY_C'])
    expect(callsFor('set-option')).toHaveLength(1)

    vi.advanceTimersByTime(1)
    execState.reply.delete('set-option')
    ensureUpdateEnvKeys(['KEY_A', 'KEY_B', 'KEY_C'])
    expect(callsFor('set-option').map((c) => c.args[5])).toEqual(['KEY_A', 'KEY_A', 'KEY_B', 'KEY_C'])
    vi.useRealTimers()
  })
})

async function bootWithCooldown() {
  const booted = await boot()
  const { TMUX_UPDATE_ENV_COOLDOWN_MS } = await import('./pty-manager')
  return { ...booted, TMUX_UPDATE_ENV_COOLDOWN_MS }
}
