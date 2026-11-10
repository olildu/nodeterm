// A WEDGED tmux SERVER NO LONGER HOLDS BOOT, PROVEN AGAINST A REAL tmux CLIENT.
//
// The unit suite (`pty-tmux-boot-timeout.test.ts`) pins that every boot-path call carries the
// bound; whether the bound actually ends a real client stuck on a server that never answers is a
// property of tmux and the kernel, so it is measured here. The "server" is a unix listener bound
// where `-L node-terminal` resolves that accepts and then says nothing — the original repro, which
// held an unbounded client 4.05 s (the listener's whole lifetime). It works with main blocked in
// `execFileSync`: the kernel completes the connect from the listen backlog, no JS has to run.
//
// Private `TMUX_TMPDIR`, never the run-wide sandbox: other suites bind `node-terminal` inside that
// sandbox (`host-destroy-tmux.test.ts`), and planting a dead socket there would wedge them.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import net from 'net'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { makeTmuxTmpdir, tmuxSocketPath } from './tmux-test-socket'
import { TMUX_SOCKET } from './tmux-naming'

// Only the login-shell probe is stubbed (it would spawn a shell); tmux itself is found for real,
// from the fixed install paths or this process's PATH.
vi.mock('./exec-path', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-path')>()),
  resolveShellPath: () => Promise.resolve(null),
  shellPathNow: () => undefined
}))
vi.mock('node-pty', () => ({ spawn: () => ({ onData: () => {}, onExit: () => {}, kill: () => {} }) }))

let tmp: string
let tmuxOk = false
let listener: net.Server | null = null
const accepted: net.Socket[] = []
const savedTmpdir = process.env.TMUX_TMPDIR

beforeAll(async () => {
  if (process.platform === 'win32') return // no tmux on Windows — the session host owns that world
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    tmuxOk = true
  } catch {
    return // no tmux on this host — the test below self-skips
  }
  tmp = makeTmuxTmpdir('ntwdg-', TMUX_SOCKET)
  const sock = tmuxSocketPath(tmp, process.getuid?.() ?? 0, TMUX_SOCKET)
  // tmux refuses a socket directory that is not private to the user.
  fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 })
  listener = net.createServer((c) => {
    accepted.push(c) // hold it open, never write: a server that took the client and went silent
  })
  await new Promise<void>((resolve) => listener!.listen(sock, resolve))
  process.env.TMUX_TMPDIR = tmp
})

afterEach(() => {
  vi.restoreAllMocks()
  resetPlatformForTests()
})

afterAll(async () => {
  if (savedTmpdir === undefined) delete process.env.TMUX_TMPDIR
  else process.env.TMUX_TMPDIR = savedTmpdir
  for (const c of accepted) c.destroy()
  if (listener) await new Promise<void>((resolve) => listener!.close(() => resolve()))
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

describe('boot against a tmux server that never answers', () => {
  it.skipIf(process.platform === 'win32')(
    'ensureTmux returns within the bound, logs it, and keeps tmux resolved (needs a real tmux)',
    async () => {
      if (!tmuxOk) return // no tmux binary on this host: nothing real to measure
      initPlatform(fakePlatform())
      // ensureTmux writes the generated tmux.conf into userDataDir; the fake's dir does not exist.
      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { PtyManager } = await import('./pty-manager')
      const mgr = new PtyManager()
      mgr.tmuxBootCmdTimeoutMs = 300 // production is 2 s; the property is what is under test

      const started = Date.now()
      mgr.init(() => ({ tmuxEnabled: true, tmuxScrollback: 10_000 }) as never)
      const elapsed = Date.now() - started

      expect(mgr.getTmuxBin()).not.toBeNull()
      // The client really was wedged (it waited out the bound) and really was ended by it.
      expect(elapsed).toBeGreaterThanOrEqual(300)
      expect(elapsed).toBeLessThan(2_000)
      // The listener's accept callback could not run while main was blocked; let it drain, then
      // confirm the client did reach OUR dead socket (not some other server, not a connect error).
      for (let i = 0; i < 50 && accepted.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(accepted.length).toBeGreaterThan(0)
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
        /tmux source-file .*timed out after 300ms/
      )
    }
  )
})
