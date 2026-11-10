import { create } from 'zustand'
import { readLocal, writeLocal } from '../lib/localStore'
import { isRecord } from '../../shared/is-record'

// How ONE person looks at a project's board — PERSONAL, per machine: localStorage, never the
// git-shared .nodeterm/project.json (same rule as the view mode and the card panel). What the board
// SAYS (its columns, their categories) is shared; whether this user wants the `closed` columns in
// front of them is not — one teammate hiding finished work must not hide it for everybody.
//
// Deliberately NOT here: the transient status chips (Running / Needs you / Unread). They filter on
// second-by-second agent state, and a filter like that surviving a restart shows a board that is
// wrong before anyone has looked at it. They live in KanbanView's component state.

export const KANBAN_DISPLAY_KEY = 'nodeterm.kanbanDisplay'

export interface ProjectBoardDisplay {
  /** Show columns whose category is `closed`. Absent = hidden (the point of `closed`). */
  showClosed?: boolean
  /** The saved view (`kanban.views[].id`) this user last applied. The views are shared; which one
   *  a person is looking at is theirs. A stale id (the view was deleted) is simply ignored. */
  viewId?: string
}

export type KanbanDisplayMap = Record<string, ProjectBoardDisplay>

/** Parses the persisted map. Anything unreadable is "every default"; only literal booleans are
 *  kept, so a hand-edited value can never flip a default it did not spell exactly. */
export function parseKanbanDisplay(raw: string | null): KanbanDisplayMap {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}
  const out: KanbanDisplayMap = {}
  for (const [pid, v] of Object.entries(parsed)) {
    if (!isRecord(v)) continue
    const entry: ProjectBoardDisplay = {}
    if (typeof v.showClosed === 'boolean') entry.showClosed = v.showClosed
    if (typeof v.viewId === 'string' && v.viewId) entry.viewId = v.viewId
    out[pid] = entry
  }
  return out
}

function save(map: KanbanDisplayMap): void {
  try {
    writeLocal(KANBAN_DISPLAY_KEY, JSON.stringify(map))
  } catch {
    /* quota/private-mode: a display preference is a nicety, never fail the UI */
  }
}

interface KanbanDisplayState {
  byProject: KanbanDisplayMap
  showClosed(projectId: string): boolean
  setShowClosed(projectId: string, show: boolean): void
  activeViewId(projectId: string): string | undefined
  setActiveViewId(projectId: string, viewId: string | undefined): void
}

export const useKanbanDisplay = create<KanbanDisplayState>((set, get) => ({
  byProject: parseKanbanDisplay(readLocal(KANBAN_DISPLAY_KEY)),
  showClosed: (projectId) => get().byProject[projectId]?.showClosed === true,
  setShowClosed: (projectId, show) => {
    const byProject = { ...get().byProject, [projectId]: { ...get().byProject[projectId], showClosed: show } }
    save(byProject)
    set({ byProject })
  },
  activeViewId: (projectId) => get().byProject[projectId]?.viewId,
  setActiveViewId: (projectId, viewId) => {
    const { viewId: _old, ...rest } = get().byProject[projectId] ?? {}
    const byProject = { ...get().byProject, [projectId]: viewId ? { ...rest, viewId } : rest }
    save(byProject)
    set({ byProject })
  }
}))
