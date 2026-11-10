// The tabs a hosted team occupies on this desktop: one tab per project the host shares, all served
// by ONE relay connection. The store and the session registry are injected (`TeamTabOps`), so
// everything here is plain bookkeeping that runs under a test without either.
//
// - The tab id IS the host's project id. The relay api translates no ids, so a tab under any other
//   id would ask the host about a project it does not know. A tab is therefore never opened under a
//   derived id: when the store holds a CLOSED relay copy under that id (a former tab of a hosted
//   team), the copy is replaced; when it holds anything else (an open tab, or one of the user's own
//   local projects, closed or not), that project is skipped rather than renamed.
// - `place` runs on every (re)mount of the team's connection: on a reconnect it reuses the team's
//   greyed tabs by id, so their nodes and their place in the tab bar survive, and it unbinds and
//   removes the tabs whose project the host stopped sharing while this desktop was away.
// - `sharedChanged` follows the host's share events while the connection is live: it closes the
//   tabs of unshared projects and opens a tab for each newly shared one. Events for one team run
//   one at a time, each against the set the previous one left; the close half is committed before
//   the workspace load is awaited, so a failed load leaves no half-applied event behind. An event
//   that began before the team remounted (or was closed) changes nothing: the newer mount decided.
// - `closeTab` is the user closing ONE of the team's tabs: it is remembered as dismissed (not
//   reopened while it stays shared) and the connection lives on for the team's other tabs. The last
//   tab's close leaves its binding alone, for the caller that ends the connection, and forgets the
//   team, so a later join in the same run starts clean.
// - A team with nothing shared keeps one placeholder tab named after the team, so the team stays
//   visible and reconnectable instead of vanishing from the tab bar; the first shared project
//   replaces it.
// - When a tab the user was looking at goes away, they land on another of the team's open tabs,
//   never on whatever the store falls back to (which can be a closed project).
//
// Removing a tab here is always a removal from THIS desktop only (`removeTab`), never the
// destroying delete: that would end the host's sessions through the relay transport.

import type { Project } from '@shared/types'
import { EMPTY_TAB_SET, cleanSharedIds, dismissTab, planSharedChange, type HostedTabSet } from './hostedTabs'

export interface TeamTabOps {
  getProject(id: string): Project | undefined
  isOpenTab(id: string): boolean
  adoptProject(p: Project): { id: string }
  addPlaceholder(label: string): { id: string }
  /** Drop a hosted tab from THIS desktop only: never the destroying delete (which would kill the
   *  host's sessions through the relay transport). `hostId` is the team the tab belonged to (or was
   *  being opened for), so a caller that has to move the user off it can prefer that team's other
   *  tabs (`openSuccessor`). */
  removeTab(id: string, hostId: string): void
  activeProjectId(): string | null
  setActive(id: string): void
  bind(projectId: string, sessionId: string): void
  unbind(projectId: string): void
}

export interface TeamRef {
  hostId: string
  label: string
}

export interface TeamTabs {
  /** Place the host's shared projects as this team's tabs (host order), reusing `existing` tabs by
   *  id and unbinding and removing the existing ones no longer shared. Never empty: nothing shared
   *  yields the team's placeholder. Binding the returned ids to the session is the caller's. */
  place(team: TeamRef, projects: Project[], existing: string[], opts: { keepActive: boolean }): string[]
  /** The host's shared set is now `projectIds`: close the tabs no longer shared, and open (and bind)
   *  the newly shared ones, calling `load` for the host's workspace only when something opens.
   *  Rejects when the load fails or the session is gone; the closes it made still stand. */
  sharedChanged(
    team: TeamRef & { sessionId: string },
    projectIds: string[],
    load: () => Promise<Project[]>,
    opts: { keepActive: boolean }
  ): Promise<{ opened: string[]; closed: string[] }>
  /** The user closed one of a team's tabs. `remaining` names the team's other open tabs; empty means
   *  this was its last, and the caller owns ending the connection. */
  closeTab(projectId: string): { remaining: string[] }
  /** The team (host id) a tab belongs to, if any. */
  teamOf(projectId: string): string | undefined
}

/** Which project takes the screen when the active tab is removed from the store: the nearest open
 *  tab of the same team, else the nearest open project, else '' (the welcome screen). Never a closed
 *  project — the store's own fallback is whichever project slides into the removed slot, closed or
 *  not. `projects` is the list without the removed tab and `index` the slot it held. */
export function openSuccessor(
  projects: readonly { id: string; closed?: boolean }[],
  index: number,
  sameTeam: (id: string) => boolean
): string {
  const nearest = (pick: (p: { id: string; closed?: boolean }) => boolean): string | undefined =>
    projects
      .map((p, i) => ({ p, d: Math.abs(i - index) }))
      .filter(({ p }) => !p.closed && pick(p))
      .sort((a, b) => a.d - b.d)[0]?.p.id
  return nearest((p) => sameTeam(p.id)) ?? nearest(() => true) ?? ''
}

/** What the joiner must follow after a share event settled, read back from the store (the event can
 *  reject and still have closed tabs, so its own result says too little). `known` is what the joiner
 *  was last told this connection serves, `after` the team's open tabs now, in store order.
 *  `removed` = tabs gone since, each to move onto the first of the returned `known`; `added` = tabs
 *  new since. While the team has no open tab at all, nothing is removed and `known` is kept: another
 *  event for the team may sit between closing its tabs and opening the new ones, and a removal needs
 *  a tab to move onto. A share event never ends the team in the joiner; closing its last tab does. */
export function reconcileTeamTabs(
  known: readonly string[],
  after: readonly string[]
): { removed: string[]; added: string[]; known: string[] } {
  if (after.length === 0) return { removed: [], added: [], known: [...known] }
  return {
    removed: known.filter((id) => !after.includes(id)),
    added: after.filter((id) => !known.includes(id)),
    known: [...after]
  }
}

/** The host's projects with the planner's id rules applied: first occurrence of each sane id. */
function cleanProjects(projects: readonly Project[]): Project[] {
  const byId = new Map<string, Project>()
  for (const p of projects) if (p && typeof p.id === 'string' && !byId.has(p.id)) byId.set(p.id, p)
  return cleanSharedIds([...byId.keys()]).map((id) => byId.get(id) as Project)
}

export function createTeamTabs(ops: TeamTabOps): TeamTabs {
  const sets = new Map<string, HostedTabSet>()
  const placeholders = new Map<string, string>()
  const team = new Map<string, string>()
  // Bumped by every (re)mount and by the team's last tab closing: a share event that began before
  // describes a connection that has been replaced or ended.
  const epochs = new Map<string, number>()
  // One share event at a time per team.
  const chains = new Map<string, Promise<void>>()

  const epochOf = (hostId: string): number => epochs.get(hostId) ?? 0
  const bumpEpoch = (hostId: string): void => {
    epochs.set(hostId, epochOf(hostId) + 1)
  }
  const isTeamTab = (id: string, hostId: string): boolean => team.get(id) === hostId && ops.isOpenTab(id)

  /** Keep the user on their tab when asked. When the tab they were on was this team's and is gone,
   *  move them to the team's first open tab (or its placeholder) unless they already sit on one. */
  const settleActive = (prev: string | null, prevWasTeam: boolean, keep: boolean, hostId: string): void => {
    if (prev && ops.isOpenTab(prev)) {
      if (keep) ops.setActive(prev)
      return
    }
    if (!prevWasTeam) return
    const current = ops.activeProjectId()
    if (current && isTeamTab(current, hostId)) return
    const next = (sets.get(hostId)?.shown ?? []).find((id) => isTeamTab(id, hostId)) ?? placeholders.get(hostId)
    if (next && ops.isOpenTab(next)) ops.setActive(next)
  }

  /** Open `p` as a tab of `hostId` under the host's own id; null when that id cannot be had. */
  const tabFor = (p: Project, hostId: string): string | null => {
    const held = ops.getProject(p.id)
    if (held) {
      if (ops.isOpenTab(p.id)) return null
      // A closed relay copy is a former hosted tab: replace it. A closed local project is the
      // user's own, and removing it from the store would delete it.
      if (held.remote !== true) return null
      ops.removeTab(p.id, hostId)
    }
    const before = ops.activeProjectId()
    const id = ops.adoptProject(p).id
    if (id === p.id) return id
    // The store derived another id; the relay api would not know it. Drop the tab and keep the user
    // where the adopt found them.
    ops.removeTab(id, hostId)
    if (before && ops.isOpenTab(before)) ops.setActive(before)
    return null
  }

  const dropPlaceholder = (hostId: string): void => {
    const ph = placeholders.get(hostId)
    if (!ph) return
    placeholders.delete(hostId)
    team.delete(ph)
    ops.unbind(ph)
    ops.removeTab(ph, hostId)
  }

  const applyShared = async (
    t: TeamRef & { sessionId: string },
    projectIds: string[],
    load: () => Promise<Project[]>,
    opts: { keepActive: boolean },
    epoch: number
  ): Promise<{ opened: string[]; closed: string[] }> => {
    const host = t.hostId
    if (epochOf(host) !== epoch) return { opened: [], closed: [] }
    const prev = ops.activeProjectId()
    const prevWasTeam = !!prev && team.get(prev) === host
    const set = sets.get(host) ?? EMPTY_TAB_SET
    const plan = planSharedChange(set, projectIds)
    for (const id of plan.close) {
      team.delete(id)
      ops.unbind(id)
      ops.removeTab(id, host)
    }
    // Commit the close half before awaiting: a failed load, or the next event, reads a set
    // without the closed tabs.
    sets.set(host, { shown: set.shown.filter((id) => !plan.close.includes(id)), dismissed: plan.next.dismissed })

    const opened: string[] = []
    let failure: { error: unknown } | null = null
    let sessionGone = false
    if (plan.open.length) {
      let loaded: Project[] = []
      try {
        loaded = await load()
      } catch (error) {
        failure = { error }
      }
      if (epochOf(host) !== epoch) return { opened: [], closed: plan.close }
      for (const p of loaded) {
        if (!plan.open.includes(p.id) || opened.includes(p.id)) continue
        const id = tabFor(p, host)
        if (!id) continue
        try {
          ops.bind(id, t.sessionId)
        } catch (error) {
          // The session was disposed while the workspace loaded. An unbound tab would resolve to the
          // offline relay session: a dead tab with no session behind it, so it is dropped instead.
          ops.removeTab(id, host)
          failure = { error }
          sessionGone = true
          break
        }
        team.set(id, host)
        opened.push(id)
      }
    }

    // Shown = the host's order, limited to what is still this team's open tab (a tab the user
    // closed during the load is dismissed, not shown).
    const fresh = sets.get(host) ?? EMPTY_TAB_SET
    const shown = plan.next.shown.filter(
      (id) => (fresh.shown.includes(id) || opened.includes(id)) && isTeamTab(id, host)
    )
    sets.set(host, { shown, dismissed: fresh.dismissed })
    if (shown.length > 0) dropPlaceholder(host)
    else if (!sessionGone && !placeholders.has(host)) {
      const ph = ops.addPlaceholder(t.label).id
      try {
        ops.bind(ph, t.sessionId)
        placeholders.set(host, ph)
        team.set(ph, host)
      } catch (error) {
        ops.removeTab(ph, host)
        failure = failure ?? { error }
      }
    }
    settleActive(prev, prevWasTeam, opts.keepActive, host)
    if (failure) throw failure.error
    return { opened, closed: plan.close }
  }

  return {
    place(t, projects, existing, opts) {
      const host = t.hostId
      bumpEpoch(host)
      const prev = ops.activeProjectId()
      const prevWasTeam = !!prev && (team.get(prev) === host || existing.includes(prev))
      const set = sets.get(host) ?? EMPTY_TAB_SET
      const shared = cleanProjects(projects)
      const reuse = new Set(existing)
      const ids: string[] = []
      for (const p of shared) {
        if (set.dismissed.includes(p.id)) continue
        const id = reuse.has(p.id) && ops.isOpenTab(p.id) ? p.id : tabFor(p, host)
        if (id) ids.push(id)
      }
      const ph = placeholders.get(host)
      for (const id of existing) {
        if (ids.includes(id) || id === ph) continue
        team.delete(id)
        ops.unbind(id)
        ops.removeTab(id, host)
      }
      // A dismissal is remembered only while the host still shares that project.
      const dismissed = set.dismissed.filter((d) => shared.some((p) => p.id === d))
      if (ids.length === 0) {
        if (ph && !ops.isOpenTab(ph)) team.delete(ph)
        const keep = ph && ops.isOpenTab(ph) ? ph : ops.addPlaceholder(t.label).id
        placeholders.set(host, keep)
        team.set(keep, host)
        sets.set(host, { shown: [], dismissed })
        settleActive(prev, prevWasTeam, opts.keepActive, host)
        return [keep]
      }
      if (ph) dropPlaceholder(host)
      for (const id of ids) team.set(id, host)
      sets.set(host, { shown: ids, dismissed })
      settleActive(prev, prevWasTeam, opts.keepActive, host)
      return ids
    },

    sharedChanged(t, projectIds, load, opts) {
      const host = t.hostId
      // The epoch is read when the event arrives: one queued behind an older event is still stale
      // if the team remounts before it runs.
      const epoch = epochOf(host)
      const prior = chains.get(host) ?? Promise.resolve()
      const result = prior.then(() => applyShared(t, projectIds, load, opts, epoch))
      const settled = result.then(
        () => undefined,
        () => undefined
      )
      chains.set(host, settled)
      void settled.then(() => {
        if (chains.get(host) === settled) chains.delete(host)
      })
      return result
    },

    closeTab(projectId) {
      const hostId = team.get(projectId)
      if (!hostId) return { remaining: [] }
      const remaining = [...team]
        .filter(([id, h]) => h === hostId && id !== projectId && ops.isOpenTab(id))
        .map(([id]) => id)
      const set = sets.get(hostId)
      if (set?.shown.includes(projectId)) sets.set(hostId, dismissTab(set, projectId))
      if (placeholders.get(hostId) === projectId) placeholders.delete(hostId)
      team.delete(projectId)
      if (remaining.length) {
        ops.unbind(projectId)
        return { remaining }
      }
      // The team's last tab: forget the team, so a later join in this run is not shadowed by its
      // dismissals, and a share event still in flight changes nothing.
      sets.delete(hostId)
      placeholders.delete(hostId)
      for (const [id, h] of [...team]) if (h === hostId) team.delete(id)
      bumpEpoch(hostId)
      return { remaining }
    },

    teamOf: (projectId) => team.get(projectId)
  }
}
