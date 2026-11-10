// @vitest-environment jsdom
//
// The card modal's Pull requests section and metadata strip must read the CARD's project, not the
// active one. On the Omni board a lane's card modal runs under the lane project's
// ProjectSessionScope while another project is active; both components key their reads on
// `useOwningProjectId() ?? activeProjectId`. A revert to `activeProjectId` alone made the Pull
// requests section show the ACTIVE project's pull requests and auto-move target, so an Unlink wrote
// the wrong project's PR number as a tombstone into the lane's board, and made the Members picker
// offer the active project's board-log authors. Each test renders the REAL component under a real
// ProjectSessionScope for a lane project that is not the active one (the pattern of
// boardLogPanelSession.test.tsx).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BoardLogEntry, NodeTerminalApi, Project, ProjectKanban } from '@shared/types'
import type { GitHubPullBoard } from '@shared/github-pull-status'
import { cardAssignees, cardMeta } from '@shared/kanban-labels'
import { readPullLinks } from '@shared/kanban-pull-links'
import { CardPullRequests, PULL_LINK_SSH_REASON } from './CardPullRequests'
import { CardMetaBar } from './CardMetaBar'
import type { KanbanSession } from './KanbanView'
import { useBoardLog } from '../../state/boardLog'
import { useGitHubIssues } from '../../state/githubIssues'
import { useProjects } from '../../state/projects'
import { useSettings } from '../../state/settings'
import { ProjectSessionScope } from '../../session/owning-project'
import {
  createSession,
  resetSessionsForTest,
  SessionProvider,
  setActiveSession,
  type WorkspaceSession
} from '../../session/session'

const ACTIVE = 'p-active'
const LANE = 'p-lane'
const SSH = { server: { host: 'h', user: 'u' } as never, remoteCwd: '~' }

const project = (id: string, ssh = false): Project =>
  ({ id, name: id, color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], ...(ssh ? { ssh: SSH } : {}) }) as unknown as Project

const board: ProjectKanban = {
  columns: [{ id: 'doing', title: 'Doing', color: '#fff' }, { id: 'done', title: 'Done', color: '#fff' }],
  assignments: [],
  github: { columnMappings: [], repository: 'o/r' }
}

const session = (over: Partial<KanbanSession> = {}): KanbanSession => ({
  id: 'n-lane', title: 'Agent', color: '#fff', kind: 'terminal', spawn: {}, worktreeBranch: 'feat/x', ...over
})

// Both projects have an open PR from the SAME branch name, so only the project decides which shows.
const pullBoard = (number: number): GitHubPullBoard => ({
  repository: 'o/r',
  pulls: [{ number, lifecycle: 'open', headRefName: 'feat/x', headRefOid: 'a'.repeat(40), ci: 'passed', merge: 'ready', closes: [] }],
  observedAt: 1, stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false
})

const author = (name: string, color: string): BoardLogEntry =>
  ({ id: `e-${name}`, ts: 1, author: { name, color }, nodeId: 'n-lane', kind: 'comment', text: 'hi' })

let root: Root | null = null
let host: HTMLElement
let local: WorkspaceSession

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  resetSessionsForTest()
  local = createSession('local', {} as NodeTerminalApi, 'This computer')
  setActiveSession(local.id)
  useProjects.setState({ projects: [project(ACTIVE), project(LANE)], activeProjectId: ACTIVE } as never)
  useGitHubIssues.setState({
    projects: { [ACTIVE]: { pullBoard: pullBoard(99) } as never, [LANE]: { pullBoard: pullBoard(12) } as never }
  })
  useSettings.setState({
    settings: {
      ...useSettings.getState().settings,
      kanbanPullAutoMove: {
        projects: { [ACTIVE]: { columnId: 'doing', armedAt: 1 }, [LANE]: { columnId: 'done', armedAt: 1 } }
      }
    }
  })
  useBoardLog.setState({
    entriesByProject: { [ACTIVE]: [author('Active Author', '#aa0000')], [LANE]: [author('Lane Author', '#00aa00')] },
    unsupportedByProject: {},
    errorByProject: {}
  } as never)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  document.body.innerHTML = ''
  resetSessionsForTest()
  vi.unstubAllGlobals()
})

/** Under App's LOCAL provider, as both boards are; the modal is scoped to the lane's project. */
function renderInLane(child: React.ReactNode): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root!.render(
      <SessionProvider session={local}>
        <ProjectSessionScope projectId={LANE}>{child}</ProjectSessionScope>
      </SessionProvider>
    )
  })
}

const button = (text: string): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement

describe('CardPullRequests reads the card project, not the active one', () => {
  it('lists the lane project\'s pull requests and unlinks the lane\'s PR number', () => {
    const onChange = vi.fn()
    renderInLane(<CardPullRequests session={session()} board={board} onChangeBoard={onChange} />)
    expect(host.textContent).toContain('PR #12')
    expect(host.textContent).not.toContain('PR #99')
    act(() => button('Unlink').click())
    const next = onChange.mock.calls[0][0] as ProjectKanban
    expect(readPullLinks(next).unlinked).toEqual([{ nodeId: 'n-lane', pull: 12 }])
  })

  it('offers the lane project\'s auto-move target column', () => {
    const onChange = vi.fn()
    renderInLane(<CardPullRequests session={session()} board={board} onChangeBoard={onChange} />)
    expect(host.textContent).toContain('Move this card to “Done” when its pull requests merge')
    expect(host.textContent).not.toContain('“Doing”')
    const optOut = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    act(() => optOut.click())
    expect(readPullLinks(onChange.mock.calls[0][0] as ProjectKanban).noAutoMove).toEqual(['n-lane'])
  })

  it('takes the SSH flag from the lane project', () => {
    useProjects.setState({ projects: [project(ACTIVE), project(LANE, true)] } as never)
    renderInLane(<CardPullRequests session={session()} board={board} onChangeBoard={vi.fn()} />)
    expect(host.textContent).toContain(PULL_LINK_SSH_REASON)
  })

  it('an SSH active project does not hide a local lane\'s links', () => {
    useProjects.setState({ projects: [project(ACTIVE, true), project(LANE)] } as never)
    renderInLane(<CardPullRequests session={session()} board={board} onChangeBoard={vi.fn()} />)
    expect(host.textContent).not.toContain(PULL_LINK_SSH_REASON)
    expect(host.textContent).toContain('PR #12')
  })
})

describe('CardMetaBar reads the card project\'s board log, not the active one', () => {
  it('offers the lane project\'s board-log authors and assigns the one picked', () => {
    const onChange = vi.fn()
    renderInLane(<CardMetaBar nodeId="n-lane" board={board} onChange={onChange} />)
    act(() => (host.querySelector('button[title="Assign a member"]') as HTMLButtonElement).click())
    expect(host.textContent).toContain('Lane Author')
    expect(host.textContent).not.toContain('Active Author')
    act(() => button('Lane Author').click())
    const next = onChange.mock.calls[0][0] as ProjectKanban
    expect(cardAssignees(cardMeta(next, 'n-lane')).map((a) => a.name)).toEqual(['Lane Author'])
  })
})
