// Issues #1150 and #1175, end to end: the REAL generated codex hook script under /bin/sh, the REAL
// curl, the REAL hook server, and the server's own verdict about WHICH node the event belongs to.
//
// MEASURED on codex-cli 0.162.0 (2026-10-16, private CODEX_HOME + private tmux socket): under the
// shared app-server a hook process is the daemon's child. It carries the DAEMON's environment and
// never CODEX_THREAD_ID; its stdin payload starts with `{"session_id":"<thread id>", …`. The env
// each case below hands the script is one of those measured shapes.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildManagedScript } from './managed-script'
import { hookServer } from '../hook-server'
import { nodeAuthToken } from '../node-auth-token'
import { initPlatform, resetPlatformForTests } from '../../platform'
import { fakePlatform } from '../../platform-fake'
import { testTmpDir } from '../../test-tmp'

const SECRET = Buffer.alloc(32, 5)
const THREAD = '01a1440f-e72b-7581-b7fc-3842cf6839db'
const sh = spawnSync('sh', ['-c', 'exit 0'])
const shAvailable = sh.status === 0 && !sh.error

let dir = ''
let root = ''
let endpoint = ''
let tokens = ''
let codexScript = ''
let claudeScript = ''
let raws: { agentId: string; nodeId: string; verified: boolean }[] = []

beforeAll(async () => {
  dir = testTmpDir('nt-codex-shared-hook-')
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: join(dir, 'userData') }))
  await hookServer.start()
  hookServer.setNodeAuthSecret(SECRET)
  hookServer.setRawListener((agentId, nodeId, _payload, meta) => {
    raws.push({ agentId, nodeId, verified: meta.verified })
  })
  root = join(dir, 'codex-thread-nodes')
  mkdirSync(root, { recursive: true })
  tokens = join(dir, 'node-tokens')
  mkdirSync(tokens, { recursive: true })
  for (const id of ['node-A', 'node-B', 'node-C']) {
    writeFileSync(join(tokens, id), `${nodeAuthToken(SECRET, id)}\n`, { mode: 0o600 })
  }
  endpoint = join(dir, 'hook-endpoint.env')
  writeFileSync(
    endpoint,
    `NODETERM_HOOK_PORT=${hookServer.getPort()}\nNODETERM_HOOK_TOKEN=${hookServer.getToken()}\n` +
      `NODETERM_HOOK_VERSION=2\nNODETERM_NODE_TOKEN_DIR=${tokens}\n`
  )
  codexScript = join(dir, 'codex.sh')
  writeFileSync(codexScript, buildManagedScript('codex', root), { mode: 0o755 })
  claudeScript = join(dir, 'claude.sh')
  writeFileSync(claudeScript, buildManagedScript('claude', root), { mode: 0o755 })
})

afterAll(() => {
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
})

beforeEach(() => {
  raws = []
})

/** A thread → node record exactly as the launcher's bind writes it (system scope). */
function record(threadId: string, nodeId: string): void {
  writeFileSync(
    join(root, threadId),
    `accountId=\nnodeId=${nodeId}\nendpoint=${endpoint}\nagentId=codex\ncanvasControl=1\nsignature=x\n`
  )
}

function payload(threadId: string, event = 'Stop'): string {
  return (
    `{"session_id":"${threadId}","turn_id":"t1","transcript_path":"/x/rollout-${threadId}.jsonl",` +
    `"cwd":"/w","hook_event_name":"${event}","model":"m","tool_input":{"session_id":"nested"}}`
  )
}

/** Runs the hook; its POST is backgrounded, so wait for the server to hear it (or not). */
async function runHook(
  script: string,
  env: Record<string, string>,
  stdin: string,
  expectEvents: number
): Promise<typeof raws> {
  await new Promise<void>((resolve) => {
    const child = spawn('sh', [script], {
      env: { PATH: process.env.PATH ?? '', HOME: join(dir, 'home'), ...env },
      stdio: ['pipe', 'ignore', 'ignore']
    })
    child.stdin.end(stdin)
    child.on('close', () => resolve())
  })
  const deadline = Date.now() + (expectEvents ? 5000 : 800)
  while (Date.now() < deadline && raws.length < Math.max(expectEvents, 1)) {
    await new Promise((r) => setTimeout(r, 25))
  }
  return raws
}

/** The env of a hook spawned by a STALE daemon: the pane that started it, long gone. */
const staleDaemonEnv = {
  NODETERM_NODE_ID: 'node-A',
  NODETERM_AGENT_ID: 'codex',
  // A dead port + bogus credentials: whatever the rebind does must not keep these.
  NODETERM_HOOK_PORT: '1',
  NODETERM_HOOK_TOKEN: 'stale-token',
  // The record's endpoint file advertises no socket, so a stale one must not survive the rebind.
  NODETERM_HOOK_SOCK: join('/nonexistent', 'hook.sock'),
  NODETERM_NODE_TOKEN_DIR: join('/nonexistent', 'tokens')
}

describe.skipIf(!shAvailable)('codex hooks under the shared app-server', () => {
  it('#1150: a scrubbed daemon (no NODETERM_*, no CODEX_THREAD_ID) reports for the thread\'s node', async () => {
    record(THREAD, 'node-B')
    const got = await runHook(codexScript, {}, payload(THREAD), 1)
    expect(got).toEqual([{ agentId: 'codex', nodeId: 'node-B', verified: true }])
  })

  it('#1175: a stale daemon\'s inherited node id is outranked by the thread record', async () => {
    record(THREAD, 'node-B')
    const got = await runHook(codexScript, staleDaemonEnv, payload(THREAD), 1)
    expect(got).toEqual([{ agentId: 'codex', nodeId: 'node-B', verified: true }])
  })

  it('a plain in-process pane (NODETERM_CODEX_PLAIN=1) keeps its own id, record or not', async () => {
    // The bind-refused fallback: node-C runs a thread whose record names node-B.
    record(THREAD, 'node-B')
    const got = await runHook(
      codexScript,
      {
        NODETERM_NODE_ID: 'node-C',
        NODETERM_CODEX_PLAIN: '1',
        NODETERM_HOOK_ENDPOINT: endpoint
      },
      payload(THREAD),
      1
    )
    expect(got).toEqual([{ agentId: 'codex', nodeId: 'node-C', verified: true }])
  })

  it('a thread with no record changes nothing (an inherited id still posts as before)', async () => {
    const got = await runHook(
      codexScript,
      { NODETERM_NODE_ID: 'node-C', NODETERM_HOOK_ENDPOINT: endpoint },
      payload('thread-without-record'),
      1
    )
    expect(got).toEqual([{ agentId: 'codex', nodeId: 'node-C', verified: true }])
  })

  it('no node id, no record: still the silent exit (a user\'s own codex)', async () => {
    expect(await runHook(codexScript, {}, payload('thread-without-record'), 0)).toEqual([])
  })

  it('reads only the LEADING session_id — a nested one in tool input never names a file', async () => {
    record('nested', 'node-B')
    const body = `{"hook_event_name":"Stop","tool_input":{"session_id":"nested"}}`
    expect(await runHook(codexScript, {}, body, 0)).toEqual([])
  })

  it('refuses a payload thread id that could escape the record directory', async () => {
    record(THREAD, 'node-B')
    expect(await runHook(codexScript, {}, payload('..'), 0)).toEqual([])
    expect(await runHook(codexScript, {}, payload('../codex-thread-nodes/x'), 0)).toEqual([])
  })

  it('the claude script ignores the payload: its session_id is never a codex thread', async () => {
    record(THREAD, 'node-B')
    expect(await runHook(claudeScript, {}, payload(THREAD), 0)).toEqual([])
  })
})
