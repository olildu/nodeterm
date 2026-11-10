// Security audit F1/F2 (2026-10) — every node-keyed tmux verb resolves its target EXACTLY.
//
// tmux resolves a BARE `-t name` by exact name, then fnmatch, then PREFIX on a miss. A relay peer that
// could name a prefix of another node's id (a scoped Team Access guest records any id no project holds
// as "its new node"; a hosted Viewer's shared node whose own session is gone) reached the LONGER, live
// session through send-text, capture, pane-command / pane-cwd, the pane-owner read, send-keys and
// terminate-foreground — for an SSH-project guest, the host's LOCAL sessions, where it was granted no
// shell at all. The fix is `=name:` / `=name` everywhere (tmux-naming.ts `exactPaneTarget`).
//
// This suite drives a REAL `PtyManager` against a REAL tmux: a victim session `nt-<base>-victim12` is
// alive, and every verb is asked about `<base>-victim1` — a node id with NO session of its own, the
// shape of the attack. A CONTROL asks the same verbs about the victim's own id, so a harness that
// cannot see an injection (or a capture) cannot pass by accident. And it measures the one thing the
// fix must not change: for an EXISTING session, `=name:` names the same pane the bare name did.
//
// WHERE IT BINDS. `PtyManager` hardcodes `-L node-terminal` (TMUX_SOCKET), so that is the name this
// suite must use; `test/setup/tmux-sandbox.ts` re-points `TMUX_TMPDIR` for the whole run and the
// `beforeAll` below REFUSES to run unless that sandbox is in effect (issue #629). Its own sessions are
// per-run unique and killed by exact target, never `kill-server`. Allowlisted in
// tmux-socket-isolation.guard.test.ts with that reason.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, promises as fs, readFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { DEFAULT_SETTINGS } from '../shared/types'
import { TMUX_SOCKET, sessionName } from './tmux-naming'
import { SANDBOX_ENV, tmuxSocketPath } from './tmux-test-socket'

const run = promisify(execFile)
const TMUX =
  ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p)) ?? null

vi.mock('./session-host-backend', async () => (await import('./__fixtures__/no-session-host')).noSessionHost())
/** Every pty the manager spawns (its tmux client): a refused NEW-ONLY create must spawn none. */
const spawns = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>)
vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[]) => {
    spawns.push({ file, args })
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!TMUX || process.platform === 'win32')('node-keyed tmux verbs resolve their target exactly', () => {
  const base = `sxt${process.pid}${Date.now().toString(36)}`
  const victimKey = `${base}-victim12`
  /** A PROPER PREFIX of the victim's node id: no session of its own exists. */
  const prefixKey = `${base}-victim1`
  const multiKey = `${base}-multi`
  let dir: string
  let victimOut: string
  let manager: import('./pty-manager').PtyManager

  const tmux = (args: string[]) => run(TMUX!, ['-L', TMUX_SOCKET, ...args], { encoding: 'utf8' })
  const victimSaw = (): string => (existsSync(victimOut) ? readFileSync(victimOut, 'utf8') : '')

  beforeAll(async () => {
    // The socket NAME is the live one; only `TMUX_TMPDIR` keeps it off the live SERVER (issue #629).
    const sandbox = process.env[SANDBOX_ENV]
    expect(sandbox, 'tmux sandbox not in effect — see test/setup/tmux-sandbox.ts').toBeTruthy()
    expect(process.env.TMUX_TMPDIR).toBe(sandbox)
    expect(tmuxSocketPath(sandbox!, process.getuid?.() ?? 0, TMUX_SOCKET)).not.toBe(
      tmuxSocketPath('/tmp', process.getuid?.() ?? 0, TMUX_SOCKET)
    )
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-exact-'))
    victimOut = path.join(dir, 'victim.out')
    initPlatform(fakePlatform({ userDataDir: dir }))
    // The victim: prints a marker (so a capture can be recognised), then records every line it is
    // typed. `cat` reads the tty in cooked mode, so a paste + Enter lands as one line in the file.
    await tmux([
      'new-session', '-d', '-s', sessionName(victimKey), '-x', '100', '-y', '20',
      `sh -c 'echo VICTIM_SCREEN_MARK; exec cat >> ${victimOut}'`
    ])
    // A session with three windows and a split, for the semantics check.
    await tmux(['new-session', '-d', '-s', sessionName(multiKey), '-x', '100', '-y', '30'])
    await tmux(['new-window', '-t', `=${sessionName(multiKey)}:`])
    await tmux(['new-window', '-t', `=${sessionName(multiKey)}:`])
    await tmux(['select-window', '-t', `=${sessionName(multiKey)}:1`])
    await tmux(['split-window', '-t', `=${sessionName(multiKey)}:1`])
    await tmux(['split-window', '-t', `=${sessionName(multiKey)}:1`])
    await tmux(['select-pane', '-t', `=${sessionName(multiKey)}:1.1`])
    await sleep(300)
    const { PtyManager } = await import('./pty-manager')
    manager = new PtyManager()
    manager.init(() => DEFAULT_SETTINGS)
  })

  afterAll(async () => {
    for (const key of [victimKey, multiKey, prefixKey]) {
      try {
        await tmux(['kill-session', '-t', `=${sessionName(key)}`])
      } catch {
        /* not running — the expected case for the prefix */
      }
    }
    resetPlatformForTests()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  it('the trap is real: a BARE target prefix-matches the victim (control for everything below)', async () => {
    const { stdout } = await tmux(['display-message', '-p', '-t', sessionName(prefixKey), '#{session_name}'])
    expect(stdout.trim()).toBe(sessionName(victimKey))
  })

  it('send-text to the prefix id types NOTHING into the victim; to the victim\'s own id it does', async () => {
    expect(await manager.sendText(prefixKey, 'INJECTED_BY_PREFIX', { enter: true })).toBe(false)
    expect(await manager.sendKeys(prefixKey, [{ digit: '7' }, { name: 'Enter' }])).toBe(false)
    await sleep(400)
    expect(victimSaw()).not.toContain('INJECTED_BY_PREFIX')
    expect(victimSaw()).not.toContain('7')
    // Control: the harness sees an injection when one happens.
    expect(await manager.sendText(victimKey, 'OWN_ID_LINE', { enter: true })).toBe(true)
    await vi.waitFor(() => expect(victimSaw()).toContain('OWN_ID_LINE'), { timeout: 10_000 })
    // A failed paste leaves no buffer of ours behind in the server (the sweep ran).
    await vi.waitFor(async () => {
      const { stdout } = await tmux(['list-buffers', '-F', '#{buffer_name}']).catch(() => ({ stdout: '' }))
      expect(stdout).not.toMatch(/nt-paste-/)
    })
  })

  it('capture, pane command, pane cwd and the pane-owner read answer nothing for the prefix id', async () => {
    expect(await manager.captureSession(prefixKey)).toBe('')
    expect(await manager.captureSnapshot(prefixKey)).toBe('')
    expect(await manager.paneCommand(prefixKey)).toBeNull()
    expect(await manager.paneCwd(prefixKey)).toBeNull()
    expect(await manager.paneOwner(prefixKey)).toBeNull()
    expect(await manager.sessionExists(prefixKey)).toBe(false)
    // Control: the same verbs DO answer for the victim's own id.
    expect(await manager.captureSession(victimKey)).toContain('VICTIM_SCREEN_MARK')
    expect(await manager.paneCommand(victimKey)).toBeTruthy()
    expect(await manager.paneCwd(victimKey)).toBeTruthy()
    expect(await manager.sessionExists(victimKey)).toBe(true)
  })

  it('terminate-foreground never signals anything for the prefix id, and the victim keeps running', async () => {
    expect(await manager.terminateForeground(prefixKey)).toBe(false)
    await expect(tmux(['has-session', '-t', `=${sessionName(victimKey)}`])).resolves.toBeTruthy()
  })

  it('for an EXISTING session the exact form names the same pane the bare name did', async () => {
    const fmt = '#{window_index}.#{pane_index}|#{pane_id}'
    const bare = async () => (await tmux(['display-message', '-p', '-t', sessionName(multiKey), fmt])).stdout.trim()
    const exact = async () =>
      (await tmux(['display-message', '-p', '-t', `=${sessionName(multiKey)}:`, fmt])).stdout.trim()
    expect(await exact()).toBe(await bare())
    expect((await exact()).startsWith('1.1|')).toBe(true)
    // Move the selection: both follow it, still identically.
    await tmux(['select-window', '-t', `=${sessionName(multiKey)}:2`])
    expect(await exact()).toBe(await bare())
    expect((await exact()).startsWith('2.0|')).toBe(true)
    // And the production read agrees with tmux about which pane that is.
    expect(await manager.paneCommand(multiKey)).toBeTruthy()
  })

  it('a NEW-ONLY create never joins or reattaches a session that already runs under the name', async () => {
    spawns.length = 0
    const r = await manager.createHeadless({ persistKey: victimKey, cols: 80, rows: 24, newOnly: true })
    expect(r).toEqual({ sessionId: '', fresh: false, unavailable: 'new-only' })
    // Refused BEFORE any tmux client is spawned: `new-session -A -D` would attach to the victim and
    // detach its other clients even if the result were thrown away afterwards.
    expect(spawns).toEqual([])
    // The victim is untouched (still alive, nothing typed).
    await expect(tmux(['has-session', '-t', `=${sessionName(victimKey)}`])).resolves.toBeTruthy()
    // Where nothing runs under the EXACT name (a prefix of a live one included), it spawns fresh.
    const fresh = await manager.createHeadless({ persistKey: prefixKey, cols: 80, rows: 24, newOnly: true })
    expect(fresh.unavailable).toBeUndefined()
    expect(fresh.fresh).toBe(true)
    expect(fresh.sessionId).not.toBe('')
    expect(spawns.map((c) => c.args.includes('new-session'))).toEqual([true])
    manager.releaseHeadless(prefixKey)
  })
})
