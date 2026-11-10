// @vitest-environment jsdom
//
// Bug F, root cause B (report-F.md): during a project switch the OUTGOING project's nodes rendered
// under the INCOMING project's session, so a hosted team tab's terminals were created on this
// desktop's own core (and a local terminal on the relay HOST).
//
// Canvas keyed the node subtree's SessionProvider on `sessionForProject(activeProjectId)`, computed
// at RENDER, while the nodes are swapped by the active-project load EFFECT. Worse, ReactFlowProvider
// sits ABOVE that keyed provider and xyflow copies the `nodes` prop into its store in a PASSIVE
// effect, so any key flip remounts whatever the store still holds — the outgoing nodes. The fix
// keys the subtree on the project whose nodes the store holds (`useFlowStoreOwner`).
//
// The node component below is a PROBE, not TerminalNode (Canvas/TerminalNode have no render
// harness): it applies TerminalNode's create rule (TerminalNode.tsx, the lifecycle effect's create
// path — `dialsSsh`, the near-side refusal, `requireRemote: sshRemoteTmux`). `CanvasReplica` is
// Canvas cut down to the lines that matter: the load effect (`setNodes` + `installEpoch` + the
// saved viewport + the settle timer's framing), the merged array handed to `<ReactFlow nodes>`, and
// the keyed provider — wired with the REAL `useNodesEpoch`, `useFlowStoreOwner` and `useFlowLanding`. The source pin at the bottom fails
// if Canvas stops wiring the provider the same way, so the replica cannot silently drift.
import { act, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStoreApi,
  type Node,
  type NodeProps,
  type Viewport
} from '@xyflow/react'
import { create } from 'zustand'
import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasNodeState, NodeTerminalApi, Project, PtyCreateOptions } from '@shared/types'
import {
  bindProjectToSession,
  createSession,
  resetSessionsForTest,
  sessionForProject,
  SessionProvider,
  useSession
} from '../session/session'
import { OwningProjectContext, useOwningProjectId } from '../session/owning-project'
import { sanitizeRelayProject } from '../session/relay-ssh'
import { localizeAdoptedNode } from '../../shared/adopt-cwd'
import { LocalTransport } from '../terminal/local-transport'
import { nodeStatesToFlow, type CanvasNode } from '../state/workspace'
import { useNodesEpoch } from './nodesEpoch'
import { useFlowStoreOwner } from './flowStoreOwner'
import { useFlowLanding } from './flowLanding'
import { canCreateOnCanvas } from '../state/persistGuards'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── The field run's ids (2026-10-03) ─────────────────────────────────────────────────────────────
const TEAM_ALPHA = 'project-musvmmle-8443e887' // the host's proj-alpha = the team tab's id
const TEAM_BETA = 'project-host-beta' // a second tab of the SAME team (same relay session)
const SSH_ALPHA = 'project-musuo41w-198f61e1' // the desktop's own (closed, handed-off) SSH proj-alpha
const SSH_BETA = 'project-beta-ssh' // the new SSH project "Connect over SSH…" created
const LOCAL_ONE = 'project-local-one'
const LOCAL_TWO = 'project-local-two'
const AGENT = 'term-musuoygd-979507b8'
const PLAIN = 'term-musur58h-4ab48dbe'
const HOST_HOME = '/home/e2e'

const sshServer = { host: 'h.example', user: 'e2e', port: 22 }
/** The desktop SSH project's nodes, as its mirror wrote them into the host's project.json. */
const sshNodes = (): CanvasNodeState[] =>
  [
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

/** What the team tab holds: the host's adopted (localized) project, through the relay ingest. */
function teamTabNodes(): CanvasNodeState[] {
  return sanitizeRelayProject({
    id: TEAM_ALPHA,
    name: 'proj-alpha',
    color: '#888',
    cwd: `${HOST_HOME}/proj-alpha`,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: sshNodes().map((n) => localizeAdoptedNode(n, HOST_HOME))
  } as unknown as Project).nodes
}

function plainTerminal(id: string, y = 0): CanvasNodeState {
  return {
    id,
    kind: 'terminal',
    title: id,
    color: '#888',
    position: { x: 0, y },
    size: { width: 600, height: 360 },
    cwd: '/root/work'
  } as unknown as CanvasNodeState
}

// ── Two cores ─────────────────────────────────────────────────────────────────────────────────────
type Core = 'local' | 'host'
type Create = PtyCreateOptions & { core: Core }
let creates: Create[] = []
let refusals: Array<{ core: Core; id: string }> = []
let mounts: Array<{ session: string; owner: string | null; id: string; sshRemoteTmux: boolean }> = []
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

// ── The probe: TerminalNode's create rule ─────────────────────────────────────────────────────────
function ProbeTerminal({ id, data }: NodeProps<CanvasNode>) {
  const session = useSession()
  const owner = useOwningProjectId()
  useEffect(() => {
    mounts.push({ session: session.id, owner, id, sshRemoteTmux: !!data.sshRemoteTmux })
    const ssh = data.ssh
    const sshRemoteTmux = !!data.sshRemoteTmux
    const localSsh = !!ssh && !sshRemoteTmux
    const dialsSsh = sshRemoteTmux && session.source !== 'relay'
    // `dialsSsh && ssh ? await resolveSshRemote(…) : undefined` — no master exists in this test.
    const sshRemote = undefined
    if (dialsSsh && !sshRemote) {
      refusals.push({ core: session.source === 'local' ? 'local' : 'host', id })
      return
    }
    void new LocalTransport(session.api).create({
      cols: 80,
      rows: 24,
      shell: localSsh ? 'ssh' : (data.shell as string | undefined),
      cwd: data.cwd as string | undefined,
      persistKey: id,
      agentId: data.agentId as string | undefined,
      sshRemote,
      requireRemote: sshRemoteTmux
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once, like the real lifecycle effect
  }, [])
  return <div style={{ width: 600, height: 360 }} />
}
const nodeTypes = { terminal: ProbeTerminal }

// ── Canvas, cut down to the lines that matter ─────────────────────────────────────────────────────
const useActive = create<{ id: string }>(() => ({ id: TEAM_ALPHA }))
let stored: Record<string, CanvasNodeState[]> = {}
let viewports: Record<string, Viewport> = {}
/** Every key the node-subtree provider rendered with, in order. */
let providerKeys: string[] = []
let readViewport: (() => Viewport) | null = null
let readStore: ReturnType<typeof useStoreApi> | null = null
// ── The load's settle timer and the cross-project focus it consumes (Canvas's pendingFocusRef) ──
/** A node to frame once its project lands, as a notification click / sidebar jump stages it. */
let pendingFocus: string | null = null
/** false = 2e9684300's ordering: the settle timer frames at once instead of waiting for the store. */
let gateOnOwner = true
/** How the load schedules its settle callback; Canvas: `setTimeout(…, 0)`. Returns the cancel. */
let scheduleSettle: (fn: () => void) => () => void = (fn) => {
  const t = setTimeout(fn, 0)
  return () => clearTimeout(t)
}
/** A settle callback held back by a test, fired by `settleAtCommitOf` below. */
let heldSettle: (() => void) | null = null
/** When set, the held settle fires in the COMMIT of the render that hands this project's nodes —
 *  after that render, before its passive effects copy them into the store. That is the window a due
 *  timer hits when React runs those passive effects in a later task (the field ordering). */
let settleAtCommitOf: string | null = null
/** Every landing that ran, by project. */
let landings: string[] = []
/** What each framing saw: the target's y in React Flow's store, and the pan/zoom it drove. */
let framings: Array<{ id: string; y: number | null; panZoom: unknown }> = []
// ── "Open recent" / a `nodeterm://` link into a folder: Canvas's resumeWhenLanded + pendingResumeRef ──
/** A resume staged for the load's landing (Canvas's pendingResumeRef). */
let pendingResume: { projectId: string; id: string } | null = null
/** false = ff4fb2812's direct path: create + frame as soon as the epoch tag is installed. */
let gateDirectOnOwner = true
/** Canvas's `resumeWhenLanded`, published by the replica's latest render. */
let resumeWhenLanded: ((projectId: string, id: string) => void) | null = null
/** Per direct-path call: the epoch tag it saw and whether the landing held the project. */
let resumeCalls: Array<{ epoch: string | null; holds: boolean }> = []
function CanvasReplica() {
  const activeProjectId = useActive((s) => s.id)
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const { nodesProjectIdRef, renderedProjectId, installEpoch } = useNodesEpoch(nodes)
  const { setViewport, getViewport, getInternalNode } = useReactFlow()
  const store = useStoreApi()
  readViewport = getViewport
  readStore = store
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 })
  // Canvas merges the ephemeral cards and the keep-alive pool into a NEW array per change.
  const allNodes = useMemo(() => [...nodes], [nodes])
  const flowOwnerProjectId = useFlowStoreOwner(allNodes, renderedProjectId)
  const nodeSession = sessionForProject(flowOwnerProjectId ?? '')
  const flowLanding = useFlowLanding(flowOwnerProjectId)
  providerKeys.push(nodeSession.id)
  /** goToNode, cut down to the two reads that matter: the node off React Flow's store (as
   *  frameNode reads it) and the pan/zoom the camera moves. */
  const frame = (id: string): void => {
    const y = getInternalNode(id)?.internals.positionAbsolute.y ?? null
    framings.push({ id, y, panZoom: store.getState().panZoom })
    if (y !== null) void setViewport({ x: 40, y: 100 - y, zoom: 1 })
  }
  // Canvas's `resumeWhenLanded` (runLinkOpen's tail is the same shape): create and frame now when
  // the canvas holds the project, else stage it for the load's landing. The shared node stands in
  // for the resumed one; what matters is which copy the framing reads and which pan/zoom it drives.
  resumeWhenLanded = (projectId, id) => {
    const holds = flowLanding.holds(projectId)
    resumeCalls.push({ epoch: nodesProjectIdRef.current, holds })
    if (
      projectId === useActive.getState().id &&
      canCreateOnCanvas(nodesProjectIdRef.current, projectId) &&
      (!gateDirectOnOwner || holds)
    ) {
      frame(id)
      return
    }
    pendingResume = { projectId, id }
  }
  // Canvas's active-project load effect: `setNodes(flow)` + `installEpoch` + the saved viewport,
  // then the settle timer whose framing work waits for the store (`flowLanding.land`).
  useEffect(() => {
    // Canvas's bail-out: no active project (welcome screen) leaves the PREVIOUS nodes mounted.
    if (!activeProjectId) {
      installEpoch(null)
      return
    }
    const flow = nodeStatesToFlow(stored[activeProjectId] ?? [])
    setNodes(flow)
    installEpoch(activeProjectId, flow)
    const vp = viewports[activeProjectId]
    if (vp) {
      viewportRef.current = vp
      void setViewport(vp)
    }
    const projectId = activeProjectId
    // Canvas's pendingResumeRef and pendingFocusRef consumers.
    const consume = (): void => {
      landings.push(projectId)
      const resume = pendingResume
      if (resume && resume.projectId === projectId) {
        pendingResume = null
        frame(resume.id) // Canvas: resumeCreateRef.current → createRecentResumeNode → goToNode
      }
      const id = pendingFocus
      if (!id) return
      pendingFocus = null
      if (!flow.some((n) => n.id === id)) return // Canvas: `nodesRef.current.find`, the node not here
      frame(id)
    }
    const cancelSettle = scheduleSettle(() => (gateOnOwner ? flowLanding.land(projectId, consume) : consume()))
    return () => {
      cancelSettle()
      flowLanding.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId])
  useLayoutEffect(() => {
    if (settleAtCommitOf === null || renderedProjectId !== settleAtCommitOf) return
    const fire = heldSettle
    heldSettle = null
    fire?.()
  }, [renderedProjectId])
  return (
    <SessionProvider session={nodeSession} key={nodeSession.id}>
      <OwningProjectContext.Provider value={flowOwnerProjectId}>
        <div style={{ width: 1200, height: 900 }}>
          <ReactFlow
            nodes={allNodes}
            edges={[]}
            nodeTypes={nodeTypes}
            defaultViewport={viewportRef.current}
            onMove={(_e, vp) => {
              viewportRef.current = vp
            }}
          />
        </div>
      </OwningProjectContext.Provider>
    </SessionProvider>
  )
}

let root: Root | null = null
let host: HTMLDivElement | null = null
async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ReactFlowProvider>
        <CanvasReplica />
      </ReactFlowProvider>
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
async function switchTo(projectId: string): Promise<void> {
  // `openSshProject` / `switchProject` / `closeProject`: one store write of `activeProjectId`.
  await act(async () => {
    useActive.setState({ id: projectId })
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
const teamIds = [AGENT, PLAIN]
const localCreatesOfTeamNodes = (): Create[] =>
  creates.filter((c) => c.core === 'local' && teamIds.includes(c.persistKey as string))
const mountCount = (id: string): number => mounts.filter((m) => m.id === id).length
/** Every node mounted under the session of the project the owning context names, and that project
 *  really holds the node. The invariant the whole fix exists for. */
function expectMountsUnderTheirOwners(): void {
  for (const m of mounts) {
    expect(m.owner, `${m.id} mounted with no owning project`).not.toBeNull()
    expect(sessionForProject(m.owner!).id, `${m.id} mounted under the wrong session`).toBe(m.session)
    expect((stored[m.owner!] ?? []).map((n) => n.id)).toContain(m.id)
  }
}

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
  refusals = []
  mounts = []
  providerKeys = []
  stored = {}
  viewports = {}
  readViewport = null
  readStore = null
  pendingFocus = null
  gateOnOwner = true
  scheduleSettle = (fn) => {
    const t = setTimeout(fn, 0)
    return () => clearTimeout(t)
  }
  heldSettle = null
  settleAtCommitOf = null
  landings = []
  framings = []
  pendingResume = null
  gateDirectOnOwner = true
  resumeWhenLanded = null
  resumeCalls = []
  resetSessionsForTest()
  createSession('local', fakeApi('local'), 'This machine')
  const relay = createSession('relay', fakeApi('host'), 'e2ehost')
  bindProjectToSession(TEAM_ALPHA, relay.id)
  bindProjectToSession(TEAM_BETA, relay.id)
  useActive.setState({ id: TEAM_ALPHA })
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  host?.remove()
  host = null
  vi.unstubAllGlobals()
})

describe('why the team tab is exposed: it receives plain terminals (the host localized them)', () => {
  it('localizeAdoptedNode drops sshRemoteTmux, so nothing on the node itself keeps it off this core', () => {
    for (const n of teamTabNodes()) {
      expect(n.sshRemoteTmux).toBeUndefined()
      expect(n.ssh).toBeUndefined()
      expect(n.cwd).toBe(`${HOST_HOME}/proj-alpha`)
    }
  })
})

describe('the node subtree runs under the session of the project React Flow STORE holds', () => {
  it('(a) team tab → new SSH project: no team node id is created on the local core', async () => {
    stored = { [TEAM_ALPHA]: teamTabNodes(), [SSH_BETA]: [] }
    await mount()
    // While the team tab is active, its terminals are created on the HOST core only.
    expect(creates.map((c) => `${c.core}:${c.persistKey}`).sort()).toEqual([`host:${AGENT}`, `host:${PLAIN}`])
    creates = []

    await switchTo(SSH_BETA)

    // Field: two LOCAL tmux sessions nt-term-musuoygd-979507b8 / nt-term-musur58h-4ab48dbe in the
    // local $HOME, `-e NODETERM_AGENT_ID=claude`, created by the outgoing nodes' remount.
    expect(localCreatesOfTeamNodes()).toEqual([])
    expect(mountCount(AGENT)).toBe(1)
    expect(mountCount(PLAIN)).toBe(1)
    expectMountsUnderTheirOwners()
  })

  it('(b) team tab → "Open here anyway" SSH project (same ids): no local create without requireRemote, both refuse near-side', async () => {
    // Same node ids in both projects. Keyed on the ACTIVE id, the window mounted the TEAM nodes
    // under 'local'; the load then swapped the SSH project's data into those same instances, whose
    // lifecycle effect never re-ran with `requireRemote`.
    stored = { [TEAM_ALPHA]: teamTabNodes(), [SSH_ALPHA]: sshNodes() }
    await mount()
    creates = []
    refusals = []

    await switchTo(SSH_ALPHA)

    expect(creates.filter((c) => c.core === 'local' && c.requireRemote !== true)).toEqual([])
    // The SSH nodes mount FRESH under the local session and stop at the near-side guard (no master).
    expect(refusals.filter((r) => r.core === 'local').map((r) => r.id).sort()).toEqual([AGENT, PLAIN].sort())
    const localMounts = mounts.filter((m) => m.session === 'local')
    expect(localMounts.map((m) => `${m.id}:${m.sshRemoteTmux}`).sort()).toEqual([`${AGENT}:true`, `${PLAIN}:true`].sort())
    expectMountsUnderTheirOwners()
  })

  it('(c) local project → team tab: the local node is never created on the host', async () => {
    stored = { [LOCAL_ONE]: [plainTerminal('term-local-1')], [TEAM_ALPHA]: [] }
    useActive.setState({ id: LOCAL_ONE })
    await mount()
    expect(creates.map((c) => `${c.core}:${c.persistKey}`)).toEqual(['local:term-local-1'])
    creates = []

    await switchTo(TEAM_ALPHA)

    expect(creates.filter((c) => c.core === 'host' && c.persistKey === 'term-local-1')).toEqual([])
    expect(mountCount('term-local-1')).toBe(1)
    expectMountsUnderTheirOwners()
  })

  it('(d) local → local: the key stays "local" and a node present before the switch is never remounted', async () => {
    // Two local projects holding the same node id (a second worktree of one committed canvas):
    // its terminal must survive the switch in place — parked terminals and the webview keep-alive
    // pool rely on a local switch never remounting the subtree.
    stored = {
      [LOCAL_ONE]: [plainTerminal('term-shared'), plainTerminal('term-one', 400)],
      [LOCAL_TWO]: [plainTerminal('term-shared'), plainTerminal('term-two', 400)]
    }
    useActive.setState({ id: LOCAL_ONE })
    await mount()
    expect(mountCount('term-shared')).toBe(1)
    expect(mountCount('term-one')).toBe(1)

    await switchTo(LOCAL_TWO)

    expect(mountCount('term-shared')).toBe(1) // not remounted
    expect(mountCount('term-one')).toBe(1) // unmounted, never remounted
    expect(mountCount('term-two')).toBe(1)
    expect(new Set(providerKeys)).toEqual(new Set(['local']))
    expect(creates.filter((c) => c.persistKey === 'term-shared')).toHaveLength(1)
    expect(creates.every((c) => c.core === 'local')).toBe(true)
  })

  it('(e) team → team (same session): no local create and no remount', async () => {
    stored = { [TEAM_ALPHA]: teamTabNodes(), [TEAM_BETA]: [plainTerminal('term-beta-1')] }
    await mount()
    const relayKey = sessionForProject(TEAM_ALPHA).id
    providerKeys = []

    await switchTo(TEAM_BETA)

    expect(creates.filter((c) => c.core === 'local')).toEqual([])
    expect(mountCount(AGENT)).toBe(1)
    expect(mountCount(PLAIN)).toBe(1)
    expect(mountCount('term-beta-1')).toBe(1)
    expect(new Set(providerKeys)).toEqual(new Set([relayKey]))
    expectMountsUnderTheirOwners()
  })

  it('a session-changing switch keeps the incoming project\'s saved camera (the remount comes after the load)', async () => {
    // The key now flips one commit AFTER the load effect applied the viewport, and a remounted
    // <ReactFlow> builds a fresh pan/zoom from `defaultViewport` — so Canvas hands it the live
    // camera, or every local ↔ team switch would land at the origin.
    stored = { [LOCAL_ONE]: [plainTerminal('term-local-1')], [TEAM_ALPHA]: teamTabNodes() }
    viewports = { [LOCAL_ONE]: { x: 120, y: -40, zoom: 0.75 }, [TEAM_ALPHA]: { x: -300, y: 25, zoom: 1.5 } }
    useActive.setState({ id: LOCAL_ONE })
    await mount()
    expect(readViewport!()).toEqual(viewports[LOCAL_ONE])

    await switchTo(TEAM_ALPHA)
    expect(providerKeys.at(-1)).toBe(sessionForProject(TEAM_ALPHA).id)
    expect(readViewport!()).toEqual(viewports[TEAM_ALPHA])

    await switchTo(LOCAL_ONE)
    expect(providerKeys.at(-1)).toBe('local')
    expect(readViewport!()).toEqual(viewports[LOCAL_ONE])
  })
})

// ── The load's framing work waits for the store (review of 2e9684300) ──────────────────────────────
describe('a just-loaded project is framed only once React Flow\'s store holds its nodes', () => {
  /** Hold the next settle callback and fire it in the commit that hands `projectId`'s nodes —
   *  before that commit's passive effects copy them into the store. No `act` boundary sits between
   *  the two: React runs them in its own order inside one flush. */
  function settleBeforeTheStoreCopy(projectId: string): void {
    scheduleSettle = (fn) => {
      heldSettle = fn
      return () => {
        if (heldSettle === fn) heldSettle = null
      }
    }
    settleAtCommitOf = projectId
  }
  /** One node id in both projects ("Open here anyway", a second worktree): only its y tells the
   *  incoming copy (2000) from the outgoing one (0). */
  function sharedNode(from: string, to: string): void {
    stored = { [from]: [plainTerminal('term-shared', 0)], [to]: [plainTerminal('term-shared', 2000)] }
    useActive.setState({ id: from })
  }

  it('session-changing switch: the framing reads the INCOMING copy and drives the remounted pan/zoom', async () => {
    sharedNode(LOCAL_ONE, TEAM_ALPHA)
    await mount()
    landings = []
    pendingFocus = 'term-shared'
    settleBeforeTheStoreCopy(TEAM_ALPHA)

    await switchTo(TEAM_ALPHA)

    expect(heldSettle).toBeNull() // the timer did fire, in the window
    expect(providerKeys.at(-1)).toBe(sessionForProject(TEAM_ALPHA).id) // and the remount happened
    expect(landings).toEqual([TEAM_ALPHA])
    expect(framings).toHaveLength(1)
    expect(framings[0].y).toBe(2000)
    expect(framings[0].panZoom).toBe(readStore!.getState().panZoom)
    expect(readViewport!()).toEqual({ x: 40, y: -1900, zoom: 1 })
  })

  it('local → local (no remount): the owner still flips, and the framing waits for it', async () => {
    sharedNode(LOCAL_ONE, LOCAL_TWO)
    await mount()
    landings = []
    pendingFocus = 'term-shared'
    settleBeforeTheStoreCopy(LOCAL_TWO)

    await switchTo(LOCAL_TWO)

    expect(heldSettle).toBeNull()
    expect(new Set(providerKeys)).toEqual(new Set(['local']))
    expect(landings).toEqual([LOCAL_TWO])
    expect(framings.map((f) => f.y)).toEqual([2000])
    expect(readViewport!()).toEqual({ x: 40, y: -1900, zoom: 1 })
  })

  it.each([
    ['session-changing', LOCAL_ONE, TEAM_ALPHA],
    ['local → local', LOCAL_ONE, LOCAL_TWO]
  ])('control (%s): on 2e9684300\'s ordering the same timer frames the OUTGOING copy', async (_kind, from, to) => {
    // The window is real: without the gate, the framing reads the copy the store still holds.
    sharedNode(from, to)
    await mount()
    gateOnOwner = false
    pendingFocus = 'term-shared'
    settleBeforeTheStoreCopy(to)

    await switchTo(to)

    expect(heldSettle).toBeNull()
    expect(framings.map((f) => f.y)).toEqual([0])
    if (sessionForProject(from).id !== sessionForProject(to).id) {
      // ...and moved a pan/zoom instance the remount then threw away.
      expect(framings[0].panZoom).not.toBe(readStore!.getState().panZoom)
    }
  })

  it.each([
    ['session-changing', TEAM_ALPHA],
    ['local → local', LOCAL_TWO]
  ])('%s switch into a project with NO nodes still releases the landing, once', async (_kind, to) => {
    stored = { [LOCAL_ONE]: [plainTerminal('term-x')], [to]: [] }
    useActive.setState({ id: LOCAL_ONE })
    await mount()
    landings = []
    pendingFocus = 'term-x'
    settleBeforeTheStoreCopy(to)

    await switchTo(to)

    expect(landings).toEqual([to])
    expect(pendingFocus).toBeNull() // consumed: the node is not on this canvas, so nothing framed
    expect(framings).toEqual([])
    await act(async () => {
      readStore!.getState().setNodes([]) // a later store change with the same owner
    })
    expect(landings).toEqual([to])
  })

  it('a timer that fires after the store copy frames at once', async () => {
    sharedNode(LOCAL_ONE, TEAM_ALPHA)
    await mount()
    landings = []
    pendingFocus = 'term-shared'

    await switchTo(TEAM_ALPHA) // the default setTimeout fires after the remount

    expect(landings).toEqual([TEAM_ALPHA])
    expect(framings.map((f) => f.y)).toEqual([2000])
    expect(framings[0].panZoom).toBe(readStore!.getState().panZoom)
  })
})

describe('a folder opened to resume or follow a link frames only once the store holds it', () => {
  // `resumeRecentConversation` 'open-folder' → `openOrAdoptFolder(…).then(() => resumeWhenLanded(…))`
  // and `runLinkOpen` → `await openOrAdoptFolder(…)` → `createFromLink`. On the adopt / new-folder
  // branch the project switch is the folder open's LAST synchronous step, so this is not a race:
  // the zustand write queues React's SyncLane microtask, that render runs the load effect
  // (installing the epoch tag), and only then does the caller's continuation run — before the
  // DefaultLane `setNodes(flow)` render that hands the store the incoming nodes.
  async function openFolder(projectId: string): Promise<void> {
    await Promise.resolve() // the probe / projectFileState await before the switch
    useActive.setState({ id: projectId })
  }
  const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  /** Real React and real timers: act() would flush both lanes together and close the window. */
  async function openAndResume(from: string, to: string): Promise<void> {
    stored = { [from]: [plainTerminal('term-shared', 0)], [to]: [plainTerminal('term-shared', 2000)] }
    useActive.setState({ id: from })
    await mount()
    landings = []
    actEnv.IS_REACT_ACT_ENVIRONMENT = false
    try {
      // Nothing is flushed between the switch and the continuation.
      void openFolder(to).then(() => resumeWhenLanded!(to, 'term-shared'))
      for (let i = 0; i < 100 && !landings.includes(to); i++) await new Promise((r) => setTimeout(r, 10))
      expect(landings).toEqual([to])
      await new Promise((r) => setTimeout(r, 30)) // anything late would land here
    } finally {
      actEnv.IS_REACT_ACT_ENVIRONMENT = true
    }
  }
  const cases = [
    ['session-changing', LOCAL_ONE, TEAM_ALPHA],
    ['local → local', LOCAL_ONE, LOCAL_TWO]
  ] as const

  it.each(cases)('%s: the continuation leaves the work to the landing, which frames the INCOMING copy once', async (_kind, from, to) => {
    await openAndResume(from, to)

    // The window was open: the epoch-tag guard alone already passed when the `.then` ran.
    expect(resumeCalls).toEqual([{ epoch: to, holds: false }])
    expect(pendingResume).toBeNull() // consumed by the landing
    expect(framings).toHaveLength(1) // never twice
    expect(framings[0].y).toBe(2000)
    expect(framings[0].panZoom).toBe(readStore!.getState().panZoom)
    expect(readViewport!()).toEqual({ x: 40, y: -1900, zoom: 1 })
  })

  it.each(cases)('control (%s): on ff4fb2812\'s direct path the same continuation frames the OUTGOING copy', async (_kind, from, to) => {
    gateDirectOnOwner = false
    await openAndResume(from, to)

    expect(resumeCalls).toEqual([{ epoch: to, holds: false }])
    expect(framings.map((f) => f.y)).toEqual([0])
    if (sessionForProject(from).id !== sessionForProject(to).id) {
      // ...and drove a pan/zoom instance the remount then threw away.
      expect(framings[0].panZoom).not.toBe(readStore!.getState().panZoom)
    }
  })

  it('a project the store already holds is resumed at once (no landing involved)', async () => {
    stored = { [LOCAL_ONE]: [plainTerminal('term-shared', 300)] }
    useActive.setState({ id: LOCAL_ONE })
    await mount()
    landings = []

    await act(async () => resumeWhenLanded!(LOCAL_ONE, 'term-shared'))

    expect(resumeCalls).toEqual([{ epoch: LOCAL_ONE, holds: true }])
    expect(pendingResume).toBeNull()
    expect(landings).toEqual([])
    expect(framings.map((f) => f.y)).toEqual([300])
  })
})

// ── The hook alone ────────────────────────────────────────────────────────────────────────────────
describe('useFlowStoreOwner', () => {
  let renders = 0
  let owner: string | null | undefined
  let storeApi: ReturnType<typeof useStoreApi> | null = null
  function Harness({ handed, projectId }: { handed: Node[]; projectId: string | null }) {
    renders++
    storeApi = useStoreApi()
    owner = useFlowStoreOwner(handed, projectId)
    return null
  }
  async function render(handed: Node[], projectId: string | null): Promise<void> {
    await act(async () => {
      root!.render(
        <ReactFlowProvider>
          <Harness handed={handed} projectId={projectId} />
        </ReactFlowProvider>
      )
    })
  }
  /** What xyflow's StoreUpdater does with the `nodes` prop, in its passive effect. */
  async function storeTakes(arr: Node[]): Promise<void> {
    await act(async () => {
      storeApi!.getState().setNodes(arr)
    })
  }
  beforeEach(() => {
    renders = 0
    owner = undefined
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  it('names the project whose array the store holds, not the one handed this render', async () => {
    const a: Node[] = []
    await render(a, null)
    expect(owner).toBeNull() // nothing known yet
    await render(a, 'project-a')
    expect(owner).toBeNull() // recorded, but the store still holds xyflow's own initial array
    await storeTakes(a)
    expect(owner).toBe('project-a')
    const b: Node[] = []
    await render(b, 'project-b')
    expect(owner).toBe('project-a') // handed, not yet copied into the store
    await storeTakes(b)
    expect(owner).toBe('project-b')
  })

  it('keeps the last known owner while the store holds an array nobody handed (a reset)', async () => {
    const a: Node[] = []
    await render(a, 'project-a')
    await storeTakes(a)
    expect(owner).toBe('project-a')
    const before = renders
    await storeTakes([]) // e.g. a remounted <ReactFlow>'s store reset
    expect(owner).toBe('project-a')
    expect(renders).toBe(before) // the fallback is selected, so nothing changed and nothing rendered
  })

  it('does not record an array handed while no project is mounted (the welcome-screen bail-out)', async () => {
    const a: Node[] = []
    await render(a, 'project-a')
    await storeTakes(a)
    const orphan: Node[] = []
    await render(orphan, null)
    await storeTakes(orphan)
    expect(owner).toBe('project-a')
  })

  it('a store update that keeps the same owner does not re-render (one primitive per drag frame)', async () => {
    const a1: Node[] = []
    const a2: Node[] = []
    await render(a1, 'project-a')
    await render(a2, 'project-a')
    await storeTakes(a1)
    const before = renders
    await storeTakes(a2) // a drag frame: a new array, same project
    expect(renders).toBe(before)
    expect(owner).toBe('project-a')
  })
})

describe('useFlowLanding', () => {
  let landing: ReturnType<typeof useFlowLanding> | null = null
  function Harness({ owner }: { owner: string | null }) {
    landing = useFlowLanding(owner)
    return <span className="landing-harness" />
  }
  async function render(owner: string | null): Promise<void> {
    await act(async () => {
      root!.render(<Harness owner={owner} />)
    })
  }
  beforeEach(() => {
    landing = null
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  it('holds work until the store holds its project, then runs it exactly once', async () => {
    const ran: string[] = []
    await render('project-a')
    landing!.land('project-b', () => ran.push('b'))
    expect(ran).toEqual([])
    await render('project-a')
    expect(ran).toEqual([])
    await render('project-b')
    expect(ran).toEqual(['b'])
    await render('project-a')
    await render('project-b')
    expect(ran).toEqual(['b'])
  })

  it('runs at once when the store already holds the project (an in-place reload, a late timer)', async () => {
    const ran: string[] = []
    await render('project-a')
    landing!.land('project-a', () => ran.push('a'))
    expect(ran).toEqual(['a'])
  })

  it('cancel drops the work: a project the user moved on from never runs it late', async () => {
    const ran: string[] = []
    await render('project-a')
    landing!.land('project-b', () => ran.push('b'))
    landing!.cancel()
    await render('project-b')
    expect(ran).toEqual([])
  })

  it('a later land replaces the earlier one', async () => {
    const ran: string[] = []
    await render('project-a')
    landing!.land('project-b', () => ran.push('b'))
    landing!.land('project-c', () => ran.push('c'))
    await render('project-b')
    expect(ran).toEqual([])
    await render('project-c')
    expect(ran).toEqual(['c'])
  })

  it('holds answers the owner the effect committed', async () => {
    await render('project-a')
    expect(landing!.holds('project-a')).toBe(true)
    expect(landing!.holds('project-b')).toBe(false)
    await render('project-b')
    expect(landing!.holds('project-a')).toBe(false)
    expect(landing!.holds('project-b')).toBe(true)
  })

  it('a throwing item is logged, does not unmount the tree, and the next landing still runs', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ran: string[] = []
      await render('project-a')
      // Runs inside the owner's passive effect, where an uncaught throw would unmount the root.
      landing!.land('project-b', () => {
        throw new Error('boom')
      })
      await render('project-b')
      expect(errors).toHaveBeenCalledWith('[canvas] landing failed', expect.objectContaining({ message: 'boom' }))
      expect(host!.querySelector('.landing-harness')).not.toBeNull()
      // Runs at once from `land` (the settle timer's path): logged, not thrown at the caller.
      expect(() =>
        landing!.land('project-b', () => {
          throw new Error('again')
        })
      ).not.toThrow()
      expect(errors).toHaveBeenCalledTimes(2)
      landing!.land('project-c', () => ran.push('c'))
      await render('project-c')
      expect(ran).toEqual(['c'])
      expect(host!.querySelector('.landing-harness')).not.toBeNull()
    } finally {
      errors.mockRestore()
    }
  })

  it('is one stable object (Canvas leaves it out of the load effect\'s deps)', async () => {
    await render('project-a')
    const first = landing
    await render('project-b')
    expect(landing).toBe(first)
  })
})

// ── Source pin: the replica is only as good as this ───────────────────────────────────────────────
describe('source pin (the replica mirrors Canvas)', () => {
  const CANVAS = fs.readFileSync(path.join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

  it('Canvas records the exact array it hands <ReactFlow nodes> and keys the node subtree on its owner', () => {
    const memo = CANVAS.indexOf('const allNodes = useMemo(')
    const hook = CANVAS.indexOf('const flowOwnerProjectId = useFlowStoreOwner(allNodes, renderedProjectId)')
    expect(memo).toBeGreaterThan(0)
    expect(hook).toBeGreaterThan(memo)
    expect(CANVAS).toContain("const nodeSession = sessionForProject(flowOwnerProjectId ?? '')")
    const provider = CANVAS.indexOf('<SessionProvider session={nodeSession} key={nodeSession.id}>')
    const owning = CANVAS.indexOf('<OwningProjectContext.Provider value={flowOwnerProjectId}>')
    const flow = CANVAS.indexOf('<ReactFlow\n')
    expect(provider).toBeGreaterThan(0)
    expect(owning).toBeGreaterThan(provider)
    expect(flow).toBeGreaterThan(owning)
    // The props of THIS <ReactFlow> run up to its edges prop.
    const props = CANVAS.slice(flow, CANVAS.indexOf('edges={displayEdges}', flow))
    expect(props).toContain('nodes={allNodes}')
    expect(props).toContain('defaultViewport={viewportRef.current}')
    // Not on the active id: that flip is what remounted the outgoing nodes under the incoming session.
    expect(CANVAS).not.toMatch(/<SessionProvider session=\{sessionForProject\(activeProjectId/)
    expect(CANVAS).not.toMatch(/key=\{sessionForProject\(activeProjectId/)
  })

  it('Canvas frames a just-loaded project only through the owner-gated landing', () => {
    const hook = CANVAS.indexOf('const flowOwnerProjectId = useFlowStoreOwner(allNodes, renderedProjectId)')
    expect(CANVAS.indexOf('const flowLanding = useFlowLanding(flowOwnerProjectId)')).toBeGreaterThan(hook)
    const timer = CANVAS.indexOf('const t = setTimeout(() => {\n      loadingRef.current = false')
    const land = CANVAS.indexOf('flowLanding.land(project.id, () => {', timer)
    const end = CANVAS.indexOf('\n    }, 0)\n', land)
    expect(timer).toBeGreaterThan(0)
    expect(land).toBeGreaterThan(timer)
    expect(end).toBeGreaterThan(land)
    const beforeLand = CANVAS.slice(timer, land)
    const inLand = CANVAS.slice(land, end)
    for (const ref of ['pendingFocusRef', 'pendingResumeRef', 'pendingLinkRef']) {
      expect(beforeLand).not.toContain(ref)
      expect(inLand).toContain(`${ref}.current`)
    }
    expect(inLand).toContain('goToNode(node)')
    // The load effect's cleanup drops it, so a project the user moved on from never frames late.
    expect(CANVAS.slice(end, end + 120)).toContain('flowLanding.cancel()')
  })

  it('a folder-open resume and a link create at once only when the landing holds the project', () => {
    const resume = CANVAS.slice(
      CANVAS.indexOf('const resumeWhenLanded = useCallback('),
      CANVAS.indexOf('pendingResumeRef.current = { projectId, conv }')
    )
    expect(resume).toMatch(
      /canCreateOnCanvas\(nodesProjectIdRef\.current, projectId\) &&\s*flowLanding\.holds\(projectId\)\s*\) \{\s*createRecentResumeNode\(conv\)/
    )
    const link = CANVAS.slice(
      CANVAS.indexOf('const runLinkOpen = useCallback('),
      CANVAS.indexOf('pendingLinkRef.current = { projectId, open, at: Date.now() }')
    )
    expect(link).toMatch(
      /canCreateOnCanvas\(nodesProjectIdRef\.current, projectId\) &&\s*flowLanding\.holds\(projectId\)\s*\) \{\s*createFromLink\(open\)/
    )
    // Those are the only direct creates; everything else goes through the landing's refs.
    expect(CANVAS.match(/createRecentResumeNode\(conv\)/g)).toHaveLength(1)
    expect(CANVAS.match(/createFromLink\(open\)/g)).toHaveLength(1)
    // The "Open folder & resume" continuation goes through resumeWhenLanded.
    expect(CANVAS).toMatch(/void openOrAdoptFolder\(plan\.folder\)[\s\S]{0,400}if \(landed\) resumeWhenLanded\(landed\.id, conv\)/)
  })

  it('Canvas loads nodes in an effect (the window the keying has to survive)', () => {
    expect(CANVAS).toMatch(/nodeStatesToFlow\(project\.nodes\)[\s\S]{0,200}\n {4}setNodes\(flow\)/)
    expect(CANVAS).toContain('installEpoch(project.id, flow)')
  })
})
