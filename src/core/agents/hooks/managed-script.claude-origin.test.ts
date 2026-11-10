// The claude hook script's ORIGIN report (issues #1112, #1153; rule in claude-pane-origin.ts),
// executed for real: the generated script runs under `/bin/sh` inside a pane of a PRIVATE tmux
// server, reads the real `ps` about `$CLAUDE_PID`, and posts to a fake curl that records its argv.
// The three cases are the three shapes measured on Claude Code 2.1.301: the pane's own foreground
// process, a job of the pane's shell that is NOT the foreground group, and a process with no
// controlling terminal at all (what claude's Bash tool and Claude's daemon give a child).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildManagedScript } from './managed-script'
import { testTmpDir } from '../../test-tmp'
import { makeTmuxTmpdir } from '../../tmux-test-socket'

const SOCKET = 'nt-test-claude-origin'
const tmuxOk = process.platform !== 'win32' && spawnSync('tmux', ['-V']).status === 0
const psOk = process.platform !== 'win32' && spawnSync('ps', ['-o', 'stat=', '-o', 'tty=', '-p', String(process.pid)]).status === 0

// `setsid(1)` is util-linux; macOS has none, so the no-terminal cases run where it exists.
const setsidOk = process.platform !== 'win32' && spawnSync('setsid', ['true']).status === 0

let dir = ''
let tmuxDir = ''
let env: NodeJS.ProcessEnv = {}

function tmux(...args: string[]): string {
  const r = spawnSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], { env, encoding: 'utf8' })
  return r.stdout ?? ''
}

function fakeCurl(log: string): string {
  return ['#!/bin/sh', `printf 'ARGV %s\\n' "$*" >> ${JSON.stringify(log)}`, 'cat >/dev/null', 'exit 0', ''].join('\n')
}

async function waitFor(file: string, ms = 8000): Promise<string> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (existsSync(file)) {
      const s = readFileSync(file, 'utf8')
      if (s.includes('ARGV')) return s
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no curl call recorded in ${file}`)
}

/** Runs `prelude; <hook>` as a pane's command and returns the fake curl's recorded argv. */
async function runInPane(name: string, prelude: string, payload = '{"hook_event_name":"Stop"}'): Promise<string> {
  const log = join(dir, `${name}.log`)
  const script = join(dir, 'claude.sh')
  const hook = `printf '%s' '${payload}' | sh ${script}`
  const cmd = `${prelude}; ${hook}; sleep 30`
  tmux('new-session', '-d', '-s', name, '-x', '80', '-y', '20', 'sh', '-c', cmd)
  // The pane's env is the tmux server's; the script reads these.
  const out = await waitFor(log.replace(`${name}.log`, 'curl.log'))
  rmSync(join(dir, 'curl.log'), { force: true })
  return out
}

beforeAll(() => {
  if (!tmuxOk || !psOk) return
  dir = testTmpDir('claude-origin-')
  tmuxDir = makeTmuxTmpdir('nt-co-', SOCKET)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'curl'), fakeCurl(join(dir, 'curl.log')), { mode: 0o755 })
  writeFileSync(join(dir, 'claude.sh'), buildManagedScript('claude', null))
  env = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: dir,
    TMUX_TMPDIR: tmuxDir,
    NODETERM_NODE_ID: 'fixture',
    NODETERM_HOOK_PORT: '1',
    NODETERM_PERM_WAIT_SECS: '1',
    TERM: 'xterm'
  }
  tmux('start-server', ';', 'set', '-g', 'exit-empty', 'off')
})

afterAll(() => {
  if (!tmuxOk || !psOk) return
  tmux('kill-server')
  rmSync(tmuxDir, { recursive: true, force: true })
})

describe.skipIf(!tmuxOk || !psOk)('the claude hook script reports which process ran it', () => {
  it('the pane\'s foreground process: fg=1 and the pane tty', async () => {
    const argv = await runInPane('own', 'export CLAUDE_PID=$$')
    const paneTty = tmux('display-message', '-p', '-t', 'own', '#{pane_tty}').trim().replace(/^\/dev\//, '')
    expect(paneTty).toMatch(/\S/)
    expect(argv).toMatch(/nodeterm_claude_pid=\d+ /)
    expect(argv).toContain('nodeterm_claude_fg=1 ')
    expect(argv).toContain(`nodeterm_claude_tty=${paneTty} `)
  })

  it('a job of the pane\'s shell that is not the foreground group: fg=0', async () => {
    // `set -m`: job control, so the `&` job gets its own process group, as in an interactive shell.
    const argv = await runInPane('bgjob', 'set -m; sleep 30 & export CLAUDE_PID=$!; sleep 0.2')
    expect(argv).toContain('nodeterm_claude_fg=0 ')
  })

  it.skipIf(!setsidOk)('a process with no controlling terminal (setsid, like claude\'s tool shell or its daemon): fg=0, no tty', async () => {
    const argv = await runInPane('detached', 'setsid sleep 30 & export CLAUDE_PID=$!; sleep 0.2')
    expect(argv).toContain('nodeterm_claude_fg=0 ')
    expect(argv).toContain('nodeterm_claude_tty= ')
  })

  it.skipIf(!setsidOk)('never arms the approval wait for a non-foreground claude', async () => {
    const argv = await runInPane(
      'perm',
      'setsid sleep 30 & export CLAUDE_PID=$!; sleep 0.2',
      '{"hook_event_name":"PermissionRequest","tool_name":"Bash"}'
    )
    expect(argv).toContain('nodeterm_pending_id= ')
    const pending = join(dir, '.nodeterm', 'pending')
    expect(existsSync(pending) ? readdirSync(pending).filter((f) => f.endsWith('.json')) : []).toEqual([])
  })

  it('no CLAUDE_PID (an older claude) or a non-numeric one: every field empty, i.e. unknown', async () => {
    for (const [name, prelude] of [
      ['nopid', 'unset CLAUDE_PID'],
      ['badpid', "export CLAUDE_PID='1;id'"],
      ['gone', 'export CLAUDE_PID=999999999']
    ]) {
      const argv = await runInPane(name, prelude)
      expect(argv, name).toContain('nodeterm_claude_pid= ')
      expect(argv, name).toContain('nodeterm_claude_fg= ')
      expect(argv, name).toContain('nodeterm_claude_tty= ')
    }
  })
})

describe('the origin report is claude-only', () => {
  it('no other agent\'s script carries it', () => {
    for (const agent of ['codex', 'gemini', 'grok', 'copilot', 'opencode']) {
      const s = buildManagedScript(agent, null)
      expect(s, agent).not.toContain('nodeterm_claude_')
      expect(s, agent).not.toContain('CLAUDE_PID')
      expect(s, agent).not.toContain('nt_msys')
    }
  })
})
