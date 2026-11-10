// The /hook route drops a claude event that came from a process which merely INHERITED the node's
// id (issues #1112, #1153) — before EITHER listener sees it, because the raw listener rebinds the
// node's session/meter/context-link transcript and the normalized one the mirror's session id,
// title and badge. The rule itself is claude-pane-origin.ts; this pins the wiring.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { hookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { testTmpDir } from '../test-tmp'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'

let events: NormalizedAgentEvent[] = []
let raws: { agent: string; payload: Record<string, unknown> }[] = []
let paneTty: string | null = '/dev/pts/3'

function post(agent: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/${agent}`, {
    method: 'POST',
    headers: {
      'X-Nodeterm-Hook-Token': hookServer.getToken(),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(fields).toString()
  })
}

const start = (sessionId: string) => JSON.stringify({
  hook_event_name: 'SessionStart',
  source: 'startup',
  session_id: sessionId,
  model: 'claude-haiku-4-5'
})

beforeAll(async () => {
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: testTmpDir('hooksrv-origin-') }))
  await hookServer.start()
  hookServer.setListener((e) => { events.push(e) })
  hookServer.setRawListener((agent, _node, payload) => { raws.push({ agent, payload }) })
  hookServer.setPaneTtyResolver(async () => paneTty)
})

afterAll(() => {
  hookServer.setPaneTtyResolver(undefined)
  hookServer.stop()
})

beforeEach(() => {
  events = []
  raws = []
  paneTty = '/dev/pts/3'
  hookServer.forgetPaneOrigin('term-a')
})

describe('claude hook events from a process that inherited the node id', () => {
  it('#1112: a claude with no controlling terminal (a detached `claude -p`) reaches no listener', async () => {
    const res = await post('claude', {
      nodeId: 'term-a', nodeterm_claude_pid: '777', nodeterm_claude_fg: '0', nodeterm_claude_tty: '',
      payload: start('foreign-session')
    })
    expect(res.status).toBe(204)
    expect(raws).toHaveLength(0)
    expect(events).toHaveLength(0)
  })

  it('#1153: a claude in the foreground of ANOTHER terminal (Claude\'s daemon-hosted fork) reaches no listener', async () => {
    await post('claude', {
      nodeId: 'term-a', nodeterm_claude_pid: '778', nodeterm_claude_fg: '1', nodeterm_claude_tty: 'pts/9',
      payload: start('fork-session')
    })
    expect(raws).toHaveLength(0)
    expect(events).toHaveLength(0)
  })

  it('the pane\'s own foreground claude is delivered, a new session id included (/clear, resume, restart)', async () => {
    await post('claude', {
      nodeId: 'term-a', nodeterm_claude_pid: '100', nodeterm_claude_fg: '1', nodeterm_claude_tty: 'pts/3',
      payload: start('own-session')
    })
    expect(raws).toHaveLength(1)
    expect(events).toHaveLength(1)
    expect(events[0].sessionId).toBe('own-session')
  })

  it('an event with no origin (older script or claude, Windows) behaves exactly as before', async () => {
    await post('claude', { nodeId: 'term-a', payload: start('legacy-session') })
    expect(raws).toHaveLength(1)
    expect(events).toHaveLength(1)
  })

  it('a pane this core cannot read (Zellij, no live client) is unknown and delivered', async () => {
    paneTty = null
    await post('claude', {
      nodeId: 'term-a', nodeterm_claude_pid: '100', nodeterm_claude_fg: '1', nodeterm_claude_tty: 'pts/9',
      payload: start('unknown-session')
    })
    expect(events).toHaveLength(1)
  })

  it('other agents are not gated by claude fields', async () => {
    await post('codex', {
      nodeId: 'term-a', nodeterm_claude_fg: '0',
      payload: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'c1' })
    })
    expect(raws).toHaveLength(1)
  })
})
