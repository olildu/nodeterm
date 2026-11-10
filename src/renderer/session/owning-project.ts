import { createContext, createElement, useContext, type ReactNode } from 'react'
import { SessionProvider, sessionForProject, type SessionSource } from './session'

/**
 * The project whose nodes the surrounding subtree renders — set by Canvas around `<ReactFlow>`
 * (to the project React Flow's store holds, `useFlowStoreOwner`) and by `ProjectSessionScope`
 * around a surface that mounts a node outside the canvas (the kanban card modal, on both boards).
 * `null` = not known: outside any provider, or before React Flow has held a project.
 *
 * It exists beside the SessionProvider because a session alone cannot say whether a node is in
 * the right place. An unbound remote project resolves to the offline relay session, whose
 * core-bound calls reject — but a node of a remote project that ends up under a LOCAL session
 * anyway (a provider keyed on the wrong project, a surface mounted outside any project's provider)
 * would create its host-side id on this core. The terminal asks
 * `spawnBelongsElsewhere(isRemoteProjectId(<this id>), session.source)` before it spawns.
 */
export const OwningProjectContext = createContext<string | null>(null)

export function useOwningProjectId(): string | null {
  return useContext(OwningProjectContext)
}

/** What a terminal prints (in gray) when `spawnBelongsElsewhere` refuses its spawn — ONE wording
 *  for the canvas node and the card modal, so the two surfaces cannot say different things. */
export const REMOTE_PROJECT_SPAWN_REFUSAL =
  '[this terminal belongs to a remote project that is not connected here — nothing was started on this machine]'

/**
 * True when a spawn for a node of a project would land on the wrong core: the project lives on
 * another machine (`projectIsRemote`, a hosted team / relay tab) but the session the node runs
 * under is not a relay session — it is this desktop's own core. The caller must then start nothing.
 *
 * Pure on purpose. Callers pass `isRemoteProjectId(<owning project id>)` (session.ts) — the same
 * rule `sessionForProject` uses, so a tab the projects store has deleted still reads as remote
 * here. An unknown project ('' or an id never held as remote) answers false there, which is not
 * evidence of anything.
 */
export function spawnBelongsElsewhere(projectIsRemote: boolean, source: SessionSource): boolean {
  return projectIsRemote && source !== 'relay'
}

/**
 * Mount `children` the way a node of `projectId` is mounted on the canvas: under THAT project's
 * session (`sessionForProject` — the relay session for a bound team tab, the offline relay session
 * for an unbound one, the local session for a local project), keyed by the session id so a session
 * change remounts them, with `OwningProjectContext` set to the project. For a surface that renders a
 * project's node outside Canvas's node subtree — the kanban boards live under App's LOCAL provider,
 * so a card modal mounted there would otherwise attach a team tab's terminal to this desktop's core.
 *
 * The session is resolved at render (the registry is runtime, not reactive), like Canvas's.
 */
export function ProjectSessionScope({ projectId, children }: { projectId: string; children: ReactNode }) {
  const session = sessionForProject(projectId)
  return createElement(SessionProvider, {
    session,
    key: session.id,
    children: createElement(OwningProjectContext.Provider, { value: projectId }, children)
  })
}
