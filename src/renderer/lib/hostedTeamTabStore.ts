// The team tab model's store side (`TeamTabOps`), against the projects store and the session
// registry. Kept out of Canvas so the placeholder and the removal run under a test against the
// real store.

import { addRelayTab, useProjects } from '../state/projects'
import { bindProjectToSession, unbindProject } from '../session/session'
import { openSuccessor, type TeamTabOps } from './hostedTeamTabs'

/** Is this project an open tab (not closed, not deleted)? What a hosted reconnect is for (R40). */
export function isOpenTab(projectId: string): boolean {
  const p = useProjects.getState().getProject(projectId)
  return !!p && !p.closed
}

/** `teamOf` is the model's own answer (the model is built from these ops, so it comes later). */
export function teamTabStoreOps(teamOf: (projectId: string) => string | undefined): TeamTabOps {
  return {
    getProject: (id) => useProjects.getState().getProject(id),
    isOpenTab,
    adoptProject: (p) => useProjects.getState().adoptProject(p),
    // A relay tab like the team's others (`remote`): the save filter drops it, so a restart never
    // finds one on disk (a boot reconnect would otherwise add a second beside it), and whatever asks
    // whether a project is a relay tab (the codex probe) says yes. `addRelayTab` takes the store's
    // name cap and does not take the screen.
    addPlaceholder: (label) => addRelayTab(label),
    // The STORE delete, never Canvas's `deleteProject` (which ends the host's sessions through the
    // relay transport): a hosted tab leaves this desktop only. When the removed tab was active, the
    // store hands the active slot to whatever slid into it; only when that is a closed project (or
    // none) does this pick an open neighbour, the same team's when it has one. The model's
    // settleActive decides the rest.
    removeTab: (id, hostId) => {
      const store = useProjects.getState()
      const index = store.projects.findIndex((p) => p.id === id)
      if (index < 0) return
      const wasActive = store.activeProjectId === id
      const next = store.deleteProject(id)
      if (!wasActive || isOpenTab(next)) return
      store.setActive(openSuccessor(useProjects.getState().projects, index, (other) => teamOf(other) === hostId))
    },
    activeProjectId: () => useProjects.getState().activeProjectId ?? null,
    setActive: (id) => useProjects.getState().setActive(id),
    bind: (projectId, sessionId) => bindProjectToSession(projectId, sessionId),
    unbind: (projectId) => unbindProject(projectId)
  }
}
