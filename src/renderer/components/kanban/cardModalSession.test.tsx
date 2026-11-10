// @vitest-environment jsdom
//
// Bug F, the card-modal path (report-F.md, "Other paths": DETERMINISTIC). Both kanban boards render
// OUTSIDE Canvas's node-subtree SessionProvider, inside App's LOCAL provider. Opening a team tab's
// terminal card therefore mounted its ModalTerminal under the local session, and the modal's
// `pty.create` (persistKey = the HOST's node id) created that id on this desktop's own core.
//
// The fix (F2b): each board mounts its card modal under `sessionForProject(<the card's project>)`
// — keyed by the session id — and provides `OwningProjectContext` with the card's project, so the
// modal's terminal (and everything else it asks `useSession()` for) talks to the core that owns the
// node. A local project's modal still resolves to the local session, byte-identically.
//
// Plus the source pins for F2c (the create-time refusal in TerminalNode + ModalTerminal) and the
// relay-ssh.ts header (F4): those components have no render harness (xterm + fit addon in jsdom).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanvasNodeState, NodeTerminalApi, Project, ProjectKanban } from '@shared/types'
import { KanbanView, type KanbanSession } from './KanbanView'
import { GlobalKanbanView } from './GlobalKanbanView'
import { REMOTE_PROJECT_SPAWN_REFUSAL } from '../../session/owning-project'
import { useProjects } from '../../state/projects'
import { useViewMode } from '../../state/viewMode'
import {
  bindProjectToSession,
  createSession,
  resetSessionsForTest,
  SessionProvider,
  setActiveSession,
  type WorkspaceSession
} from '../../session/session'

/** What the probe CardModal saw at each render: the session it runs under and its owning project. */
const probe = vi.hoisted(() => ({
  seen: [] as Array<{ session: string; source: string; owner: string | null; projectId: string }>
}))

vi.mock('./CardModal', async () => {
  const session = await import('../../session/session')
  const owning = await import('../../session/owning-project')
  return {
    CardModal: ({ projectId }: { projectId: string }) => {
      const s = session.useSession()
      probe.seen.push({ session: s.id, source: s.source, owner: owning.useOwningProjectId(), projectId })
      return null
    }
  }
})
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))

const LOCAL_PROJECT = 'p-local'
const TEAM_PROJECT = 'p-team'

let root: Root | null = null
let host: HTMLElement
let local: WorkspaceSession
let relay: WorkspaceSession

const terminal = (id: string): CanvasNodeState =>
  ({ id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: id, color: '#fff', group: null }) as CanvasNodeState
const project = (id: string, nodes: CanvasNodeState[], remote = false): Project =>
  ({ id, name: id, color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes, ...(remote ? { remote: true } : {}) }) as unknown as Project
const card = (id: string): KanbanSession =>
  ({ id, title: id, color: '#fff', kind: 'terminal', spawn: {} }) as unknown as KanbanSession
const board = (): ProjectKanban => ({ columns: [{ id: 'todo', title: 'To Do', color: '#888' }], assignments: [] }) as unknown as ProjectKanban

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    boardLog: { list: async () => [], onChanged: () => () => {} },
    settings: { save: async () => {} }
  }
  probe.seen.length = 0
  resetSessionsForTest()
  local = createSession('local', window.nodeTerminal, 'This computer')
  setActiveSession(local.id)
  relay = createSession('relay', { boardLog: { list: async () => [], onChanged: () => () => {} } } as unknown as NodeTerminalApi, 'Team')
  useProjects.setState({
    projects: [project(LOCAL_PROJECT, [terminal('n-local')]), project(TEAM_PROJECT, [terminal('n-team')], true)],
    activeProjectId: LOCAL_PROJECT
  } as never)
  bindProjectToSession(TEAM_PROJECT, relay.id)
  useViewMode.setState({ requestedCardNodeId: null } as never)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  document.body.innerHTML = ''
  resetSessionsForTest()
  vi.unstubAllGlobals()
})

/** Render under App's LOCAL provider — where both boards really live (outside Canvas's subtree). */
function render(el: JSX.Element): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<SessionProvider session={local}>{el}</SessionProvider>))
}
const openCard = (nodeId: string): void => act(() => useViewMode.getState().requestCard(nodeId))
const noop = (): void => {}

function renderProjectBoard(projectId: string, nodeId: string): void {
  useProjects.setState({ activeProjectId: projectId } as never)
  render(
    <KanbanView board={board()} sessions={[card(nodeId)]} onChange={noop} onOpenNode={noop}
      onCreateNode={noop} onRenameNode={noop} onEditSticky={noop} onDeleteNode={noop}
      onModalNodeChange={noop} onBrowserNav={noop} onSetIcon={noop} />
  )
}

describe('the per-project board mounts its card modal under the card project\'s session', () => {
  it('a team tab\'s card runs under its relay session, owned by the team project', () => {
    renderProjectBoard(TEAM_PROJECT, 'n-team')
    openCard('n-team')
    expect(probe.seen.length).toBeGreaterThan(0)
    expect(probe.seen.at(-1)).toEqual({ session: relay.id, source: 'relay', owner: TEAM_PROJECT, projectId: TEAM_PROJECT })
  })

  it('a local project\'s card still runs under the local session', () => {
    renderProjectBoard(LOCAL_PROJECT, 'n-local')
    openCard('n-local')
    expect(probe.seen.at(-1)).toEqual({ session: 'local', source: 'local', owner: LOCAL_PROJECT, projectId: LOCAL_PROJECT })
  })
})

describe('the Omni board mounts each lane\'s card modal under THAT lane\'s session', () => {
  it('a team lane\'s card runs under the relay session even while a local project is active', () => {
    render(<GlobalKanbanView />)
    openCard('n-team')
    expect(probe.seen.length).toBeGreaterThan(0)
    expect(probe.seen.at(-1)).toEqual({ session: relay.id, source: 'relay', owner: TEAM_PROJECT, projectId: TEAM_PROJECT })
  })

  it('a local lane\'s card runs under the local session', () => {
    useProjects.setState({ activeProjectId: TEAM_PROJECT } as never)
    render(<GlobalKanbanView />)
    openCard('n-local')
    expect(probe.seen.at(-1)).toEqual({ session: 'local', source: 'local', owner: LOCAL_PROJECT, projectId: LOCAL_PROJECT })
  })
})

// ── Source pins (F2c, F4): TerminalNode and ModalTerminal have no render harness ─────────────────
const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')
// Both terminals print the ONE exported refusal; the pins below find its use, not a retyped copy.
const REFUSAL = '${REMOTE_PROJECT_SPAWN_REFUSAL}'

describe('the refusal line is one constant', () => {
  it('names that nothing was started here, and no terminal retypes it', () => {
    expect(REMOTE_PROJECT_SPAWN_REFUSAL).toContain('remote project that is not connected here')
    expect(REMOTE_PROJECT_SPAWN_REFUSAL).toContain('nothing was started on this machine')
    for (const rel of ['../../nodes/TerminalNode.tsx', 'ModalTerminal.tsx']) {
      const src = read(rel)
      expect(src).toContain('import { REMOTE_PROJECT_SPAWN_REFUSAL,')
      expect(src).not.toContain('nothing was started on this machine')
    }
  })
})

describe('both terminals refuse to spawn locally for a remote project (F2c)', () => {
  it('TerminalNode asks spawnBelongsElsewhere after the noSpawn return, before any SSH resolve or create', () => {
    const src = read('../../nodes/TerminalNode.tsx')
    expect(src).toContain('const owningProject = useOwningProjectId()')
    expect(src).toContain('owningProjectRef.current = owningProject')
    const noSpawn = src.indexOf('if (noSpawn) return')
    // The ONE remote-project rule (session.ts), never a store-only `getProject(...)?.remote` read.
    const ask = src.indexOf("spawnBelongsElsewhere(isRemoteProjectId(owningProjectRef.current ?? ''), session.source)", noSpawn)
    const refusal = src.indexOf(REFUSAL, ask)
    const resolve = src.indexOf('await resolveSshRemote(', noSpawn)
    const create = src.indexOf('transport\n        .create({', noSpawn)
    expect(noSpawn).toBeGreaterThan(-1)
    expect(ask).toBeGreaterThan(noSpawn)
    expect(refusal).toBeGreaterThan(ask)
    expect(resolve).toBeGreaterThan(refusal)
    expect(create).toBeGreaterThan(resolve)
    expect(src).toContain('ownerProjectId: sshProjectId ?? owningProjectRef.current ?? useProjects.getState().activeProjectId')
    expect(src).not.toMatch(/spawnBelongsElsewhere\(useProjects/)
  })

  it('ModalTerminal asks spawnBelongsElsewhere before its SSH resolve and its create', () => {
    const src = read('ModalTerminal.tsx')
    expect(src).toContain('const owningProject = useOwningProjectId()')
    expect(src).toContain('owningProjectRef.current = owningProject')
    const ask = src.indexOf("spawnBelongsElsewhere(isRemoteProjectId(owner ?? ''), session.source)")
    const refusal = src.indexOf(REFUSAL, ask)
    const resolve = src.indexOf('await resolveSshRemote(', ask)
    const create = src.indexOf('const res = await transport.create({', ask)
    expect(ask).toBeGreaterThan(-1)
    expect(refusal).toBeGreaterThan(ask)
    expect(resolve).toBeGreaterThan(refusal)
    expect(create).toBeGreaterThan(resolve)
    // A non-dialing card's pane is owned by the CARD's project, not whichever is active.
    expect(src).toContain('const owner = owningProjectRef.current')
    expect(src).toContain(': (owner ?? useProjects.getState().activeProjectId)')
    expect(src).toContain('ownerProjectId: projectId,')
    expect(src).not.toMatch(/spawnBelongsElsewhere\(useProjects/)
  })

  it('ModalTerminal gates the SSH dial on session.source like TerminalNode\'s dialsSsh', () => {
    const src = read('ModalTerminal.tsx')
    expect(src).toContain("const dialsSsh = !!spawn.sshRemoteTmux && session.source !== 'relay'")
    expect(src).toMatch(/dialsSsh && spawn\.ssh\n\s+\? await resolveSshRemote\(/)
    expect(src).toContain('if (dialsSsh && !sshRemote) {')
    // The relay host joins its own session with requireRemote; it has no master to dial.
    expect(src).not.toMatch(/spawn\.sshRemoteTmux && spawn\.ssh\n\s+\? await resolveSshRemote\(/)
    expect(src).not.toContain('if (spawn.sshRemoteTmux && !sshRemote) {')
    expect(src).toContain('requireRemote: spawn.sshRemoteTmux')
  })
})

describe('relay-ssh.ts no longer claims sshRemoteTmux survives for a shared project (F4)', () => {
  it('says the host adopts it (flag dropped) and names what keeps its nodes off this core', () => {
    const src = read('../../session/relay-ssh.ts')
    expect(src).not.toContain('It keeps `requireRemote` on the create the tab sends to the HOST\'s core')
    expect(src).toContain('localizeAdoptedNode')
    expect(src).toContain('spawnBelongsElsewhere')
  })
})
