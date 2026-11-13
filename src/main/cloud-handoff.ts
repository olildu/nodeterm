/**
 * Fork-only (cross build): the Cloud button's bridge to the user's `cloud-handoff` script, which
 * moves a tab's Claude agents to a cloud box and back (`handoff out|back <tab>`).
 *
 * The script is the whole implementation; this file only runs it. Rules:
 * - argv only, never a shell: ids are checked against a closed pattern and the task text rides one
 *   argv element after `--`, so nothing the renderer sends can become a flag or shell syntax.
 * - one long run (out/back) per tab at a time; a second request is refused, not queued.
 * - progress is the script's own log, one JSON line per step (HANDOFF_JSON=1), forwarded verbatim
 *   on `cloudHandoffProgress`, then one `done` event with the exit status.
 * - a missing script answers `notInstalled`, so the button can say so instead of failing.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import type { CloudHandoffProgress, CloudHandoffRequest, CloudHandoffResult, CloudHandoffVerb } from '../shared/types'

const ID_RE = /^[A-Za-z0-9._-]{1,120}$/
const SHORT_TIMEOUT_MS = 90_000
const MAX_TEXT = 4000

export function cloudHandoffScriptPath(): string {
  return process.env.NODETERM_HANDOFF_SCRIPT || join(homedir(), 'Documents', 'git', 'oss', 'cloud-handoff', 'handoff')
}

/** The script's argv for a request, or an error string. Pure; tested. */
export function cloudHandoffArgs(req: CloudHandoffRequest): string[] | string {
  if (!req || typeof req !== 'object') return 'bad request'
  const { verb, tabId } = req
  if (typeof tabId !== 'string' || !ID_RE.test(tabId)) return 'bad tab id'
  switch (verb) {
    case 'where':
      return ['where', tabId]
    case 'plan':
      return ['plan', tabId, '--json']
    case 'out':
      return ['out', tabId]
    case 'back':
      return ['back', tabId]
    case 'back-force':
      return ['back', tabId, '--force']
    case 'bind':
      if (typeof req.node !== 'string' || !ID_RE.test(req.node)) return 'bad node id'
      if (typeof req.canvasNode !== 'string' || !ID_RE.test(req.canvasNode)) return 'bad canvas node id'
      return ['bind', tabId, req.node, req.canvasNode]
    case 'reconnect':
      if (typeof req.node !== 'string' || !ID_RE.test(req.node)) return 'bad node id'
      return ['reconnect', tabId, req.node]
    case 'warm-on':
      return ['warm', 'on', tabId]
    case 'warm-off':
      return ['warm', 'off', tabId]
    case 'queue': {
      if (typeof req.node !== 'string' || !ID_RE.test(req.node)) return 'bad node id'
      if (typeof req.text !== 'string') return 'no task text'
      // One line: the box types it into the agent's prompt, where a newline would submit early.
      const text = req.text.replace(/[\r\n]+/g, ' ').trim()
      if (!text || text.length > MAX_TEXT || text.includes('\0')) return 'task text is empty or too long'
      return ['queue', tabId, req.node, '--', text]
    }
    default:
      return 'unknown verb'
  }
}

const LONG: ReadonlySet<CloudHandoffVerb> = new Set(['out', 'back', 'back-force'])

/** One progress line from the script's stdout/stderr: its JSON `msg`/`error`, else the raw text. */
export function progressLine(raw: string): string | null {
  const line = raw.trim()
  if (!line) return null
  if (line.startsWith('{')) {
    try {
      const j = JSON.parse(line) as { msg?: unknown; error?: unknown }
      if (typeof j.msg === 'string') return j.msg
      if (typeof j.error === 'string') return j.error
    } catch {
      /* not JSON: show it as it is */
    }
  }
  return line.replace(/^handoff: /, '')
}

export interface CloudHandoffDeps {
  handle: (channel: string, fn: (req: CloudHandoffRequest) => Promise<CloudHandoffResult>) => void
  send: (channel: string, payload: CloudHandoffProgress) => void
}

export function registerCloudHandoffIpc(deps: CloudHandoffDeps): void {
  const running = new Map<string, ChildProcess>()

  deps.handle(IPC.cloudHandoffRun, async (req: CloudHandoffRequest): Promise<CloudHandoffResult> => {
    if (req?.verb === 'cancel') {
      // The script decides: it stops only while nothing has been stopped or moved yet.
      const child = typeof req.tabId === 'string' ? running.get(req.tabId) : undefined
      if (!child) return { ok: false, error: 'Nothing is running for this tab.' }
      child.kill('SIGTERM')
      return { ok: true }
    }
    const args = cloudHandoffArgs(req)
    if (typeof args === 'string') return { ok: false, error: args }
    const script = cloudHandoffScriptPath()
    if (!existsSync(script)) return { ok: false, notInstalled: true, error: `cloud-handoff not found at ${script}` }
    const long = LONG.has(req.verb)
    if (long && running.has(req.tabId)) return { ok: false, error: 'A move for this tab is already running.' }

    const env = {
      ...process.env,
      // A GUI app does not inherit the login PATH: ssh, rsync, git, tmux and python3 must resolve.
      PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH, '/usr/bin', '/bin', '/usr/sbin', '/sbin']
        .filter(Boolean)
        .join(':'),
      HANDOFF_JSON: '1'
    }
    return await new Promise<CloudHandoffResult>((resolve) => {
      const child = spawn('/usr/bin/env', ['python3', script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      if (long) running.set(req.tabId, child)
      let stdout = ''
      let stderr = ''
      let pending = ''
      const emit = (raw: string): void => {
        const line = progressLine(raw)
        if (line && long) deps.send(IPC.cloudHandoffProgress, { tabId: req.tabId, verb: req.verb, line })
      }
      child.stdout.on('data', (b: Buffer) => {
        const s = b.toString('utf8')
        stdout += s
        if (!long) return
        pending += s
        const parts = pending.split('\n')
        pending = parts.pop() ?? ''
        parts.forEach(emit)
      })
      child.stderr.on('data', (b: Buffer) => {
        stderr += b.toString('utf8')
      })
      const timer = long ? null : setTimeout(() => child.kill('SIGTERM'), SHORT_TIMEOUT_MS)
      const finish = (ok: boolean, error?: string): void => {
        if (timer) clearTimeout(timer)
        if (long) {
          if (pending) emit(pending)
          running.delete(req.tabId)
          deps.send(IPC.cloudHandoffProgress, { tabId: req.tabId, verb: req.verb, done: true, ok })
        }
        let data: unknown
        if (!long && ok) {
          try {
            data = JSON.parse(stdout.trim().split('\n').pop() || 'null')
          } catch {
            data = undefined
          }
        }
        resolve({ ok, data, error })
      }
      child.on('error', (e) => finish(false, `could not start the script: ${e.message}`))
      child.on('close', (code) => {
        const err = stderr.split('\n').map(progressLine).filter(Boolean).join('\n') || undefined
        finish(code === 0, code === 0 ? undefined : err || `exited with ${code}`)
      })
    })
  })
}
