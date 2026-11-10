// @vitest-environment jsdom
//
// Bug F, root cause F2a (report-F.md): a REMOTE project (a hosted team / relay tab) whose relay
// binding is gone — the session was disposed (the last team tab closed), or the binding dropped —
// resolved to the LOCAL session in `sessionForProject`. Its nodes stay mounted (the welcome-screen
// bail-out keeps the previous array in React Flow), the provider key flips to 'local', and every
// one of them remounts and creates its host-side node id on THIS desktop's core.
//
// The fix: such a project resolves to an OFFLINE relay session (`OFFLINE_RELAY_SESSION_ID`) whose
// api is a relay api over a dead transport, so every core-bound call (pty.create first) REJECTS at
// once and nothing reaches the local core. Lifecycle code that asks "which relay session is bound to
// this tab?" asks `boundSessionForProject`, which never answers the sentinel.
//
// The ported scenarios run the node subtree through the REAL `useFlowStoreOwner` + `useNodesEpoch`
// (Canvas's keying since Task 2) under a real React Flow, with a probe node that applies
// TerminalNode's create rule (see flowStoreOwner.test.tsx for the full replica and its source pin).
import { act, createElement, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlow, ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasNodeState, NodeTerminalApi, Project, PtyCreateOptions } from '@shared/types'
import { E_DISCONNECTED } from '../../shared/rpc'
import { addRelayTab, useProjects } from '../state/projects'
import {
  OFFLINE_RELAY_SESSION_ID,
  activeSessionApi,
  bindProjectToSession,
  boundSessionForProject,
  createSession,
  disposeSession,
  getActiveSession,
  getSessionStores,
  isOfflineRelaySession,
  presenceForProject,
  projectIdsBoundToSession,
  resetSessionsForTest,
  sessionCount,
  sessionForProject,
  SessionProvider,
  setActiveSession,
  setOfflineRelayApiFactory,
  unbindProject,
  useSession
} from './session'
import { deadRelayTransport, offlineRelayApi } from './offline-relay-session'
import { sanitizeRelayProject } from './relay-ssh'
import { localizeAdoptedNode } from '../../shared/adopt-cwd'
import { LocalTransport } from '../terminal/local-transport'
import { nodeStatesToFlow, type CanvasNode } from '../state/workspace'
import { useNodesEpoch } from '../canvas/nodesEpoch'
import { useFlowStoreOwner } from '../canvas/flowStoreOwner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── The field run's ids (2026-10-03) ─────────────────────────────────────────────────────────────
const TEAM_ALPHA = 'project-musvmmle-8443e887' // the host's proj-alpha = the team tab's id
const LOCAL_ONE = 'project-local-one'
const AGENT = 'term-musuoygd-979507b8'
const PLAIN = 'term-musur58h-4ab48dbe'
const HOST_HOME = '/home/e2e'

const sshServer = { host: 'h.example', user: 'e2e', port: 22 }
/** The team tab's nodes: the desktop SSH project's nodes, adopted (localized) by the host and
 *  passed through the relay ingest — plain terminals, `sshRemoteTmux` gone. */
function teamTabProject(): Project {
  const hostNodes = [
    { id: AGENT, kind: 'terminal', agentId: 'claude' },
    { id: PLAIN, kind: 'terminal' }
  ].map(
    (n) =>
      ({
        ...n,
        title: n.id,
        color: '#888',
        position: { x: 0, y: n.id === AGENT ? 0 : 400 },
        size: { width: 600, height: 360 },
        cwd: '~/proj-alpha',
        ssh: sshServer,
        sshRemoteTmux: true
      }) as unknown as CanvasNodeState
  )
  const adopted = sanitizeRelayProject({
    id: TEAM_ALPHA,
    name: 'proj-alpha',
    color: '#888',
    cwd: `${HOST_HOME}/proj-alpha`,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: hostNodes.map((n) => localizeAdoptedNode(n, HOST_HOME))
  } as unknown as Project)
  // `openRelayTab` adopts the host's project with `remote: true` (relay-tab.ts).
  return { ...adopted, remote: true }
}

function localProject(): Project {
  return {
    id: LOCAL_ONE,
    name: 'local-one',
    color: '#888',
    cwd: '/root/work',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: []
  } as unknown as Project
}

// ── Two cores ─────────────────────────────────────────────────────────────────────────────────────
type Core = 'local' | 'host'
type Create = PtyCreateOptions & { core: Core }
let creates: Create[] = []
/** Every probe mount: which session it ran under and how its create settled. */
let outcomes: Array<{ session: string; id: string; result: 'created' | 'rejected' | 'refused'; code?: string }> = []
function fakeApi(core: Core): NodeTerminalApi {
  return {
    core,
    pty: {
      create: vi.fn(async (o: PtyCreateOptions) => {
        creates.push({ ...o, core })
        return { sessionId: `${core}-${o.persistKey}`, fresh: true }
      }),
      kill: vi.fn()
    }
  } as unknown as NodeTerminalApi
}

let localApi: NodeTerminalApi
let savedNodeTerminal: unknown

// ── The probe: TerminalNode's create rule, with TerminalNode's catch (spawnError) ────────────────
function ProbeTerminal({ id, data }: NodeProps<CanvasNode>) {
  const session = useSession()
  useEffect(() => {
    const sshRemoteTmux = !!data.sshRemoteTmux
    // `dialsSsh = sshRemoteTmux && session.source !== 'relay'` — no master exists in this test.
    if (sshRemoteTmux && session.source !== 'relay') {
      outcomes.push({ session: session.id, id, result: 'refused' })
      return
    }
    new LocalTransport(session.api)
      .create({
        cols: 80,
        rows: 24,
        cwd: data.cwd as string | undefined,
        persistKey: id,
        agentId: data.agentId as string | undefined,
        requireRemote: sshRemoteTmux
      })
      .then(
        () => outcomes.push({ session: session.id, id, result: 'created' }),
        (err: { code?: string }) => outcomes.push({ session: session.id, id, result: 'rejected', code: err?.code })
      )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once, like the real lifecycle effect
  }, [])
  return createElement('div', { style: { width: 600, height: 360 } })
}
const nodeTypes = { terminal: ProbeTerminal }

/** Canvas, cut down to the lines that matter: the active-project load effect (with its
 *  welcome-screen bail-out), and the node subtree keyed on the project React Flow's STORE holds. */
function CanvasReplica() {
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const { renderedProjectId, installEpoch } = useNodesEpoch(nodes)
  const owner = useFlowStoreOwner(nodes, renderedProjectId)
  const nodeSession = sessionForProject(owner ?? '')
  useEffect(() => {
    if (!activeProjectId) {
      installEpoch(null)
      return
    }
    const flow = nodeStatesToFlow(useProjects.getState().getProject(activeProjectId)?.nodes ?? [])
    setNodes(flow)
    installEpoch(activeProjectId, flow)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId])
  return createElement(SessionProvider, {
    session: nodeSession,
    key: nodeSession.id,
    children: createElement(
      'div',
      { style: { width: 1200, height: 900 } },
      createElement(ReactFlow, { nodes, edges: [], nodeTypes })
    )
  })
}

let root: Root | null = null
let host: HTMLDivElement | null = null
const tree = () => createElement(ReactFlowProvider, null, createElement(CanvasReplica))
async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(tree()))
  await settle()
}
async function rerender(): Promise<void> {
  await act(async () => root!.render(tree()))
  await settle()
}
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
const teamIds = [AGENT, PLAIN]
const localCreatesOfTeamNodes = (): Create[] =>
  creates.filter((c) => c.core === 'local' && teamIds.includes(c.persistKey as string))

const timeout = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  creates = []
  outcomes = []
  // The local session's api IS `window.nodeTerminal` in the app; the offline relay api spreads it
  // (`...local`) for the app-global namespaces, exactly as a real relay tab's api does.
  localApi = fakeApi('local')
  savedNodeTerminal = (window as unknown as { nodeTerminal?: unknown }).nodeTerminal
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = localApi
  resetSessionsForTest()
  setActiveSession(createSession('local', localApi, 'This machine').id)
  // Production registers the factory as a side effect of importing the module (localSession.ts
  // imports it); re-register per test because test (g) unregisters it.
  setOfflineRelayApiFactory(offlineRelayApi)
  useProjects.setState({ projects: [teamTabProject(), localProject()], activeProjectId: TEAM_ALPHA })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  host?.remove()
  host = null
  setOfflineRelayApiFactory(offlineRelayApi)
  useProjects.setState({ projects: [], activeProjectId: '' })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = savedNodeTerminal
  vi.unstubAllGlobals()
})

describe('deadRelayTransport', () => {
  it('reports the connection closed synchronously on every send, stores no listener, never becomes ready', async () => {
    const t = deadRelayTransport()
    const closes = vi.fn()
    t.onClose(closes)
    t.onMessage(() => {
      throw new Error('a dead transport delivers nothing')
    })
    t.send('{"t":"req","id":1}')
    expect(closes).toHaveBeenCalledTimes(1)
    t.send('{"t":"req","id":2}')
    expect(closes).toHaveBeenCalledTimes(2)
    await expect(t.ready()).rejects.toMatchObject({ code: E_DISCONNECTED })
  })
})

describe('an unbound REMOTE project resolves to the offline relay session', () => {
  it('(a) is relay-shaped, offline, the sentinel id, and never the local session', () => {
    const s = sessionForProject(TEAM_ALPHA)
    expect(s.source).toBe('relay')
    expect(s.status).toBe('offline')
    expect(s.id).toBe(OFFLINE_RELAY_SESSION_ID)
    expect(s.label).toBe('Disconnected')
    expect(isOfflineRelaySession(s)).toBe(true)
    expect(s).not.toBe(sessionForProject(LOCAL_ONE))
    expect(s.api).not.toBe(localApi)
    // Created once per registry: every caller gets the same object (a stable provider value/key).
    expect(sessionForProject(TEAM_ALPHA)).toBe(s)
  })

  it('(b) its pty.create REJECTS at once (never hangs) and the local core is never asked', async () => {
    const api = sessionForProject(TEAM_ALPHA).api
    const settled = await Promise.race([
      api.pty.create({ cols: 80, rows: 24, persistKey: AGENT } as PtyCreateOptions).then(
        () => 'resolved' as const,
        (err: { code?: string }) => err
      ),
      timeout(200)
    ])
    expect(settled).not.toBe('timeout')
    expect(settled).not.toBe('resolved')
    expect(settled).toMatchObject({ code: E_DISCONNECTED })
    // Through the same seam TerminalNode uses.
    await expect(
      new LocalTransport(api).create({ cols: 80, rows: 24, persistKey: PLAIN } as PtyCreateOptions)
    ).rejects.toMatchObject({ code: E_DISCONNECTED })
    expect(localApi.pty.create).not.toHaveBeenCalled()
  })

  it('(c) a LOCAL unbound project still resolves to the local session', () => {
    const s = sessionForProject(LOCAL_ONE)
    expect(s.id).toBe('local')
    expect(s.api).toBe(localApi)
    // So does an id the store does not know (a deleted project, '' on the welcome screen).
    expect(sessionForProject('').id).toBe('local')
    expect(sessionForProject('project-unknown').id).toBe('local')
  })

  it('(d) boundSessionForProject answers the live binding only — never the sentinel, never a fallback', () => {
    expect(boundSessionForProject(TEAM_ALPHA)).toBeNull()
    expect(boundSessionForProject(LOCAL_ONE)).toBeNull()
    const relay = createSession('relay', fakeApi('host'), 'e2ehost')
    bindProjectToSession(TEAM_ALPHA, relay.id)
    expect(boundSessionForProject(TEAM_ALPHA)).toBe(relay)
    expect(sessionForProject(TEAM_ALPHA)).toBe(relay)
    // A stale binding (session disposed) is pruned exactly like sessionForProject prunes it.
    disposeSession(relay.id)
    expect(boundSessionForProject(TEAM_ALPHA)).toBeNull()
    expect(projectIdsBoundToSession(relay.id)).toEqual([])
    expect(sessionForProject(TEAM_ALPHA).id).toBe(OFFLINE_RELAY_SESSION_ID)
    // A tab can never bind to the sentinel, so a binding can never name it.
    expect(() => bindProjectToSession(TEAM_ALPHA, OFFLINE_RELAY_SESSION_ID)).toThrow()
  })

  it('a remote tab the store has since deleted still resolves offline; a never-remote one stays local', () => {
    const relay = createSession('relay', fakeApi('host'), 'e2ehost')
    bindProjectToSession(TEAM_ALPHA, relay.id) // remote in the store at bind time
    // Team Access's fallback tab (the host shared nothing to adopt), bound to the same session. It
    // is an EMPTY relay tab, `remote` like every relay tab (`addRelayTab`, what Canvas passes as the
    // first-connect `addProject`): the host's nodes reach it over canvas sync.
    const fallback = addRelayTab("Ayşe's Mac")
    bindProjectToSession(fallback.id, relay.id)
    disposeSession(relay.id)
    expect(sessionForProject(fallback.id).id).toBe(OFFLINE_RELAY_SESSION_ID)
    useProjects.setState({ projects: [localProject()] }) // TEAM_ALPHA and the fallback leave the store
    expect(sessionForProject(TEAM_ALPHA).id).toBe(OFFLINE_RELAY_SESSION_ID)
    expect(sessionForProject(fallback.id).id).toBe(OFFLINE_RELAY_SESSION_ID)
    expect(presenceForProject(TEAM_ALPHA)).toBe(getSessionStores(OFFLINE_RELAY_SESSION_ID).presence)
    // A local project the store holds stays local (local projects are never bound).
    expect(sessionForProject(LOCAL_ONE).id).toBe('local')
    // An id that was never bound remote stays local.
    expect(sessionForProject('project-never-seen').id).toBe('local')
  })

  it('(e) sessionCount() does not count the sentinel', () => {
    expect(sessionForProject(TEAM_ALPHA).id).toBe(OFFLINE_RELAY_SESSION_ID)
    expect(sessionCount()).toBe(1)
  })

  it('(f) disposeSession(OFFLINE_RELAY_SESSION_ID) is a no-op', () => {
    const s = sessionForProject(TEAM_ALPHA)
    disposeSession(OFFLINE_RELAY_SESSION_ID)
    expect(sessionForProject(TEAM_ALPHA)).toBe(s)
    expect(getActiveSession().id).toBe('local')
    expect(sessionCount()).toBe(1)
  })

  it('(g) with no factory registered, the old local fallback stands', () => {
    setOfflineRelayApiFactory(null)
    expect(sessionForProject(TEAM_ALPHA).id).toBe('local')
    setOfflineRelayApiFactory(offlineRelayApi)
    expect(sessionForProject(TEAM_ALPHA).id).toBe(OFFLINE_RELAY_SESSION_ID)
  })

  it('answers its own stores and is accepted as the active session (Canvas activates sessionForProject(active).id)', () => {
    const s = sessionForProject(TEAM_ALPHA)
    const stores = getSessionStores(OFFLINE_RELAY_SESSION_ID)
    // Its own stores — never the local session's (a dead core's status must not touch local unread).
    expect(stores).not.toBe(getSessionStores('local'))
    expect(stores.agentStatus).not.toBe(getSessionStores('local').agentStatus)
    expect(stores.presence).not.toBe(getSessionStores('local').presence)
    setActiveSession(s.id)
    expect(getActiveSession()).toBe(s)
    expect(activeSessionApi()).toBe(s.api)
    // Dropping the factory while the sentinel is active falls back to local, never a dangling id.
    setOfflineRelayApiFactory(null)
    expect(getActiveSession().id).toBe('local')
  })

  it('presenceForProject resolves exactly as sessionForProject does (offline presence, never local)', () => {
    expect(presenceForProject(TEAM_ALPHA)).toBe(getSessionStores(OFFLINE_RELAY_SESSION_ID).presence)
    expect(presenceForProject(LOCAL_ONE)).toBe(getSessionStores('local').presence)
    const relay = createSession('relay', fakeApi('host'), 'e2ehost')
    bindProjectToSession(TEAM_ALPHA, relay.id)
    expect(presenceForProject(TEAM_ALPHA)).toBe(getSessionStores(relay.id).presence)
  })

  it('is recreated after resetSessionsForTest (once per registry)', () => {
    const first = sessionForProject(TEAM_ALPHA)
    resetSessionsForTest()
    createSession('local', localApi, 'This machine')
    const second = sessionForProject(TEAM_ALPHA)
    expect(second.id).toBe(OFFLINE_RELAY_SESSION_ID)
    expect(second).not.toBe(first)
  })
})

describe('ported repro scenarios: a team tab without a live binding creates nothing on the local core', () => {
  it('a team tab that loses its binding while its nodes are mounted', async () => {
    const relay = createSession('relay', fakeApi('host'), 'e2ehost')
    bindProjectToSession(TEAM_ALPHA, relay.id)
    await mount()
    // Healthy first: both team nodes were created on the HOST.
    expect(creates.filter((c) => c.core === 'host').map((c) => c.persistKey).sort()).toEqual(teamIds.slice().sort())
    creates = []
    outcomes = []
    await act(async () => unbindProject(TEAM_ALPHA))
    await rerender()
    expect(localCreatesOfTeamNodes()).toEqual([])
    // The remount ran under the offline sentinel and its creates were refused by the dead transport.
    expect(outcomes.map((o) => [o.session, o.result]).sort()).toEqual([
      [OFFLINE_RELAY_SESSION_ID, 'rejected'],
      [OFFLINE_RELAY_SESSION_ID, 'rejected']
    ])
    expect(outcomes.every((o) => o.code === E_DISCONNECTED)).toBe(true)
    expect(localApi.pty.create).not.toHaveBeenCalled()
  })

  it('closing the LAST team tab (welcome screen) leaves its nodes mounted under the offline sentinel', async () => {
    useProjects.setState({ projects: [teamTabProject()], activeProjectId: TEAM_ALPHA })
    const relay = createSession('relay', fakeApi('host'), 'e2ehost')
    bindProjectToSession(TEAM_ALPHA, relay.id)
    await mount()
    creates = []
    outcomes = []
    // `performCloseProject` → `disposeRelayTabForProject` (last tab: disposeSession) → `closeProject`
    // → activeProjectId '' → the load effect bails out and leaves the team's nodes mounted.
    await act(async () => disposeSession(relay.id))
    await act(async () => {
      useProjects.getState().closeProject(TEAM_ALPHA)
    })
    await settle()
    expect(useProjects.getState().activeProjectId).toBe('')
    expect(localCreatesOfTeamNodes()).toEqual([])
    expect(outcomes.map((o) => o.session)).toEqual([OFFLINE_RELAY_SESSION_ID, OFFLINE_RELAY_SESSION_ID])
    expect(outcomes.every((o) => o.result === 'rejected')).toBe(true)
    expect(localApi.pty.create).not.toHaveBeenCalled()
  })

  // Found while enumerating: `teamTabStoreOps.removeTab` (a host that stops sharing a project)
  // deletes the tab from the STORE and unbinds it. When it was the only open tab the welcome screen
  // keeps its nodes mounted, and an id the store no longer holds would read as "not remote".
  it('the host stops sharing the only open team tab (store delete) while its nodes are mounted', async () => {
    useProjects.setState({ projects: [teamTabProject()], activeProjectId: TEAM_ALPHA })
    const relay = createSession('relay', fakeApi('host'), 'e2ehost')
    bindProjectToSession(TEAM_ALPHA, relay.id)
    await mount()
    creates = []
    outcomes = []
    await act(async () => {
      unbindProject(TEAM_ALPHA)
      useProjects.getState().deleteProject(TEAM_ALPHA)
    })
    await settle()
    expect(useProjects.getState().activeProjectId).toBe('')
    expect(useProjects.getState().getProject(TEAM_ALPHA)).toBeUndefined()
    expect(localCreatesOfTeamNodes()).toEqual([])
    expect(outcomes.map((o) => [o.session, o.result])).toEqual([
      [OFFLINE_RELAY_SESSION_ID, 'rejected'],
      [OFFLINE_RELAY_SESSION_ID, 'rejected']
    ])
    expect(localApi.pty.create).not.toHaveBeenCalled()
  })

  it('a local project is untouched: its nodes keep the local session', async () => {
    useProjects.setState({
      projects: [
        teamTabProject(),
        { ...localProject(), nodes: [{ id: 'term-local-1', kind: 'terminal', title: 't', color: '#888', position: { x: 0, y: 0 }, size: { width: 600, height: 360 }, cwd: '/root/work' } as unknown as CanvasNodeState] }
      ],
      activeProjectId: LOCAL_ONE
    })
    await mount()
    expect(outcomes).toEqual([{ session: 'local', id: 'term-local-1', result: 'created' }])
    expect(creates.map((c) => [c.core, c.persistKey])).toEqual([['local', 'term-local-1']])
  })
})

describe('source pins', () => {
  const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')

  it('localSession.ts imports the offline relay session module, so production always registers the factory', () => {
    expect(read('localSession.ts')).toMatch(/^import '\.\/offline-relay-session'$/m)
  })

  // Canvas's relay LIFECYCLE sites ask "which relay session is bound to this tab?" — dispose it,
  // read its api once, hand it over as the stale session a reconnect replaces. `sessionForProject`
  // now answers the offline sentinel for an unbound remote tab, which must never be disposed or
  // passed as `staleSessionId`, so each of these asks `boundSessionForProject` (no fallback).
  // Note `boundSessionForProject(` does not contain the lowercase `sessionForProject(`.
  it('Canvas relay lifecycle sites ask boundSessionForProject, never sessionForProject', () => {
    const canvas = read('../canvas/Canvas.tsx')
    const between = (start: string, end: string): string => {
      const a = canvas.indexOf(start)
      const b = canvas.indexOf(end, a + start.length)
      expect(a, start).toBeGreaterThan(-1)
      expect(b, end).toBeGreaterThan(a)
      return canvas.slice(a, b)
    }
    const sites = [
      between('const disposeRelayTabForProject = useCallback(', '}, [teamTabs])'),
      between('.then((tab): HostedMountOutcome | null => {', 'if (reconnectProjectId) {'),
      between('mount: (connectionId, req, hooks) => {', 'return confirmAndMount('),
      between('const reconnectRelay = useCallback(', 'void reconnectRelayTab(projectId, {')
    ]
    for (const body of sites) {
      expect(body).toContain('boundSessionForProject(')
      expect(body).not.toContain('sessionForProject(')
    }
  })

  // Canvas's first-connect `addProject` (the host shared nothing to adopt) must make a RELAY tab:
  // a plain `useProjects.getState().addProject(name)` is a local project — saved to this machine's
  // workspace with the host's node ids, and LOCAL again once its relay session is gone.
  it('Canvas creates the Team Access fallback tab with addRelayTab', () => {
    const canvas = read('../canvas/Canvas.tsx')
    const a = canvas.indexOf('const mountRemoteMirror = useCallback(')
    const b = canvas.indexOf('adoptProject: reconnectProjectId', a)
    expect(a).toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a)
    const deps = canvas.slice(a, b)
    expect(deps).toContain('(name) => addRelayTab(name)')
    expect(deps).not.toContain('.addProject(')
  })

  it('offline-relay-session.ts registers the factory at module load', () => {
    expect(read('offline-relay-session.ts')).toMatch(/^setOfflineRelayApiFactory\(offlineRelayApi\)$/m)
  })

  // ModalTerminal has no render harness (an xterm + fit addon in jsdom). Its create rejection —
  // what the offline session answers once the card modal runs under its project's session — must
  // land on the terminal as a refusal BEFORE anything reads the result, never as a blank viewer and
  // an unhandled rejection out of the effect. (TerminalNode's `.catch` → spawnError overlay is the
  // canvas twin; the ported scenarios above exercise the rejection itself.)
  it('ModalTerminal turns a rejected create into a written refusal before reading the result', () => {
    const src = read('../components/kanban/ModalTerminal.tsx')
    const create = src.indexOf('const res = await transport.create({')
    const caught = src.indexOf('}).catch((err: unknown): Error =>', create)
    const guard = src.indexOf('if (res instanceof Error) {', caught)
    const written = src.indexOf('[this terminal could not be started: ${why}]', guard)
    const firstRead = src.indexOf('res.unavailable', create)
    expect(create).toBeGreaterThan(-1)
    expect(caught).toBeGreaterThan(create)
    expect(guard).toBeGreaterThan(caught)
    expect(written).toBeGreaterThan(guard)
    expect(firstRead).toBeGreaterThan(written)
  })
})
