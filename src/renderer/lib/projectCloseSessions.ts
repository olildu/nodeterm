// Closing/deleting a project vs. the tmux sessions it parks (issue #442).
//
// `closeProject` is deliberately NON-destructive — the tab hides, the project stays on disk, and
// its tmux sessions keep running so reopening picks them up warm. That contract is kept. What was
// missing is that nothing SAID so at the moment of the action, and nothing afterwards showed that
// the parked sessions exist: a closed project is filtered out of the tab bar and the sessions
// sidebar, so "close" read like cleanup while actually meaning "hide, and keep running".
//
// This module is the pure half of the fix:
//  - `planProjectClose` decides whether closing needs a confirm (and how many sessions it must
//    name), with an opt-in "end its sessions too" — the default stays parking.
//  - `deleteConfirmCopy` words the permanent delete (the "Recently closed" ×), distinguishing
//    what is removed HERE from what continues to exist elsewhere (a relay tab is only a view of
//    another machine's project; an SSH/local delete never deletes the folder or its
//    .nodeterm/project.json).
//  - `closedSessionCounts` maps a live session sweep onto closed projects for the start screen's
//    per-row badge.
//
// ONE definition of "N sessions" on the dialogs: the project's TERMINAL-kind nodes — exactly the
// set the action addresses (`transport.destroy` per node id, idempotent on an already-dead
// session). Working, idle, hibernated and already-exited all count, because the action tells each
// of them to stop; a liveness-verified count here would let the button and the action disagree
// the moment a session exits between the count and the confirm. The start-screen badge is the
// OPPOSITE: it reports sessions that exist, so it derives from a live sweep and never from node
// counts — and `ok:false` is not "0 sessions" (the session-memory rule), so no sweep ⇒ no badge.

import type { Project, SessionMemoryRow } from '@shared/types'

type ProjectLike = Pick<Project, 'name' | 'nodes' | 'remote' | 'ssh' | 'storeInAppData'>

/** The node ids whose tmux sessions a close-with-end / delete addresses (terminal-kind only). */
export function terminalNodeIds(project: Pick<Project, 'nodes'>): string[] {
  return (project.nodes ?? [])
    .filter((n) => (n.kind ?? 'terminal') === 'terminal')
    .map((n) => n.id)
}

export type ProjectClosePlan = { kind: 'silent' } | { kind: 'confirm'; sessionCount: number }

/**
 * Does closing this project need a confirm? Silent (today's exact behavior) when there is nothing
 * to tell the user about:
 *  - unknown project — nothing to close;
 *  - a RELAY tab (`project.remote`) — a live view of another machine's project. Its sessions are
 *    the host's, closing only drops this machine's connection, and offering to "end" them from
 *    here would promise a kill on a machine this action does not reach;
 *  - no terminal nodes — there are no sessions to park or end, and a dialog would decide nothing.
 */
export function planProjectClose(project: ProjectLike | undefined): ProjectClosePlan {
  if (!project || project.remote) return { kind: 'silent' }
  const count = terminalNodeIds(project).length
  return count === 0 ? { kind: 'silent' } : { kind: 'confirm', sessionCount: count }
}

export interface CloseConfirmCopy {
  message: string
  /** The opt-in checkbox. Ending is the exception — parking stays the default. */
  optionLabel: string
  /** Confirm label while the checkbox is UNCHECKED (the non-destructive default). */
  confirmKeep: string
  /** Confirm label while the checkbox is CHECKED (destructive — the dialog flips to danger). */
  confirmEnd: string
}

const plural = (n: number): string => (n === 1 ? '' : 's')

export function closeConfirmCopy(name: string, sessionCount: number): CloseConfirmCopy {
  const n = sessionCount
  return {
    message:
      `Close “${name}”? Its ${n} terminal session${plural(n)} will keep running in the ` +
      `background — reopen the project from the start screen's “Recently closed” list to pick ` +
      `them up again.`,
    optionLabel: `End its ${n === 1 ? 'session' : `${n} sessions`} too (stops tmux; anything running in them, agents included, is interrupted)`,
    confirmKeep: 'Close',
    confirmEnd: `Close & end ${n} session${plural(n)}`
  }
}

export interface DeleteConfirmCopy {
  message: string
  confirmLabel: string
  /** A relay-view removal is not destructive — nothing anywhere is deleted or stopped. */
  danger: boolean
}

/** How the SSH host is named in the delete copy — the saved label when there is one. */
function sshHostLabel(project: ProjectLike): string {
  const s = project.ssh?.server
  if (!s) return ''
  return s.label || `${s.user}@${s.host}`
}

export function deleteConfirmCopy(project: ProjectLike): DeleteConfirmCopy {
  const name = project.name
  if (project.remote) {
    // The issue-#442 follow-up case: "Delete" on a host-backed tab sounds like removal but only
    // drops this machine's view — and with the tab gone, the next connect re-adopts the host's
    // project (a first connect again), so it all comes back. Say exactly that.
    return {
      message:
        `Remove “${name}”? This tab is a live view of a project on another machine — removing ` +
        `it only closes the view here. Nothing is deleted on the host, its sessions keep ` +
        `running, and reconnecting will bring the project back.`,
      confirmLabel: 'Remove view',
      danger: false
    }
  }
  const n = terminalNodeIds(project).length
  const sessions =
    n === 0
      ? ''
      : project.ssh
        ? `ends its ${n} terminal session${plural(n)} on ${sshHostLabel(project)} and `
        : `ends its ${n} terminal session${plural(n)} and `
  const where = project.ssh ? 'on the server' : 'on disk'
  // A project stored in app data (#1145) has no copy in its folder: removing it deletes the canvas
  // and its app-data side files (WorkspaceStore's data-file sweep).
  const tail = project.storeInAppData && !project.ssh
    ? `The folder ${where} is not deleted, but the canvas, project settings, board log and whiteboards it kept in app data are.`
    : `The folder ${where} (including .nodeterm/project.json) is not deleted.`
  return {
    message: `Delete “${name}”? This ${sessions}removes the project from nodeterm. ${tail}`,
    confirmLabel: 'Delete',
    danger: true
  }
}

/**
 * Per-closed-project count of LIVE local `nt-*` sessions, for the start screen's badge. Rows come
 * from one on-demand local `sessionMemory.read` (this machine only — an SSH project's sessions
 * live on its host and are not claimed here). First project owning a node id wins, matching
 * `resolveSessionRows`. Only ids > 0 are returned, so `counts[id]` is truthy exactly when a badge
 * should show.
 */
export function closedSessionCounts(
  rows: readonly Pick<SessionMemoryRow, 'nodeId'>[],
  closedProjects: readonly Pick<Project, 'id' | 'nodes'>[]
): Record<string, number> {
  const owner = new Map<string, string>()
  for (const p of closedProjects) {
    for (const n of p.nodes ?? []) {
      if (!owner.has(n.id)) owner.set(n.id, p.id)
    }
  }
  const counts: Record<string, number> = {}
  for (const row of rows) {
    const id = owner.get(row.nodeId)
    if (id) counts[id] = (counts[id] ?? 0) + 1
  }
  return counts
}
