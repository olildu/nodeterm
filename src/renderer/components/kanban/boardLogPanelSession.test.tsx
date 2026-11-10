// @vitest-environment jsdom
//
// The card modal's comments panel must read and write the board log of the CARD's project, over
// that project's session. On the Omni board a lane's card modal runs under the lane project's
// session (ProjectSessionScope), but the panel used to key the log on the ACTIVE project: it asked
// the lane's core for the active project's log (blank, "unsupported" on a relay), and a comment
// typed there was inserted optimistically, appended to a project the lane's core does not know,
// answered false and persisted nowhere. This renders the REAL panel under a real
// ProjectSessionScope for a lane project that is not the active one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NodeTerminalApi, Project } from '@shared/types'
import { BoardLogPanel } from './BoardLogPanel'
import { useBoardLog } from '../../state/boardLog'
import { useProjects } from '../../state/projects'
import { ProjectSessionScope } from '../../session/owning-project'
import {
  bindProjectToSession,
  createSession,
  resetSessionsForTest,
  SessionProvider,
  setActiveSession,
  type WorkspaceSession
} from '../../session/session'

const ACTIVE = 'p-active'
const LANE = 'p-lane'

function fakeBoardLogApi() {
  return {
    boardLog: {
      read: vi.fn(async () => ({ entries: [] })),
      append: vi.fn(async () => true),
      onChanged: vi.fn(() => () => {})
    }
  }
}

let root: Root | null = null
let host: HTMLElement
let local: WorkspaceSession
let relay: WorkspaceSession
let localApi: ReturnType<typeof fakeBoardLogApi>
let laneApi: ReturnType<typeof fakeBoardLogApi>

const project = (id: string, remote = false): Project =>
  ({ id, name: id, color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], ...(remote ? { remote: true } : {}) }) as unknown as Project

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  resetSessionsForTest()
  localApi = fakeBoardLogApi()
  laneApi = fakeBoardLogApi()
  local = createSession('local', localApi as unknown as NodeTerminalApi, 'This computer')
  setActiveSession(local.id)
  relay = createSession('relay', laneApi as unknown as NodeTerminalApi, 'Team')
  useProjects.setState({ projects: [project(ACTIVE), project(LANE, true)], activeProjectId: ACTIVE } as never)
  bindProjectToSession(LANE, relay.id)
  useBoardLog.setState({ entriesByProject: {}, unsupportedByProject: {}, errorByProject: {} } as never)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  document.body.innerHTML = ''
  resetSessionsForTest()
  vi.unstubAllGlobals()
})

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0))
})

async function renderLaneModalPanel(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  // Under App's LOCAL provider, as both boards are; the modal is scoped to the lane's project.
  await act(async () => {
    root!.render(
      <SessionProvider session={local}>
        <ProjectSessionScope projectId={LANE}>
          <BoardLogPanel card={{ id: 'n-lane' }} />
        </ProjectSessionScope>
      </SessionProvider>
    )
  })
  await flush()
}

async function typeAndSend(value: string): Promise<void> {
  const ta = host.querySelector('textarea') as HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(ta, value)
    ta.setSelectionRange(value.length, value.length)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await flush()
}

describe('the card modal comments panel uses the card project, not the active one', () => {
  it('reads and subscribes to the lane project\'s log on the lane\'s api', async () => {
    await renderLaneModalPanel()
    expect(laneApi.boardLog.read).toHaveBeenCalledWith(LANE)
    expect(laneApi.boardLog.onChanged).toHaveBeenCalledWith(LANE, expect.any(Function))
    expect(laneApi.boardLog.read).not.toHaveBeenCalledWith(ACTIVE)
    // This machine's core is never asked about the lane's card.
    expect(localApi.boardLog.read).not.toHaveBeenCalled()
    expect(localApi.boardLog.onChanged).not.toHaveBeenCalled()
  })

  it('appends a typed comment to the lane project on the lane\'s api', async () => {
    await renderLaneModalPanel()
    await typeAndSend('hello lane')
    expect(laneApi.boardLog.append).toHaveBeenCalledTimes(1)
    expect(laneApi.boardLog.append).toHaveBeenCalledWith(
      LANE,
      expect.objectContaining({ kind: 'comment', nodeId: 'n-lane', text: 'hello lane' })
    )
    expect(localApi.boardLog.append).not.toHaveBeenCalled()
    // The optimistic entry is filed under the lane project, where the panel reads it back.
    expect(useBoardLog.getState().entriesFor(LANE).map((e) => e.text)).toEqual(['hello lane'])
    expect(useBoardLog.getState().entriesFor(ACTIVE)).toEqual([])
  })
})
