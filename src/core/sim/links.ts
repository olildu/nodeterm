/**
 * What a canvas link between an agent and a Simulator node MEANS to the `sim` verb
 * (CLAUDE.md → Simulator node, "Links"). Pure and Electron-free; the shell supplies the persisted
 * bridges and the events, this file decides.
 *
 * - A linked Simulator node is the agent's DEFAULT `sim` target: one → used, several → refused
 *   with the list, none → refused with how to get one.
 * - A `sim` call that resolves to a Simulator node the caller is NOT linked to creates the link
 *   (auto-link), once, in the caller's own project — unless the user removed that link earlier in
 *   this app run. The ledger below is that run's memory; it is deliberately not persisted (a new
 *   run is a new conversation with the user about their canvas).
 */

export type { SimAgentEvent } from '../../shared/sim'

export interface PairLike {
  source: string
  target: string
}

/** Order-independent key for an agent↔device pair. */
export function simPairKey(agentId: string, simNodeId: string): string {
  return `${agentId}\u0000${simNodeId}`
}

export interface SimLinkLedger {
  /** The agent was auto-linked to the device this run (the bridge may not be persisted yet). */
  autoLinked(agentId: string, simNodeId: string): boolean
  noteAutoLinked(agentId: string, simNodeId: string): void
  /** The user removed the link: never re-create it this run, and forget the optimistic record. */
  noteRemoved(agentId: string, simNodeId: string): void
  suppressed(agentId: string, simNodeId: string): boolean
  /** Simulator nodes this run auto-linked to the agent and the user has not removed. */
  autoLinkedFor(agentId: string): string[]
}

export function createSimLinkLedger(): SimLinkLedger {
  const linked = new Map<string, Set<string>>()
  const removed = new Set<string>()
  return {
    autoLinked: (a, s) => linked.get(a)?.has(s) ?? false,
    noteAutoLinked(a, s) {
      if (removed.has(simPairKey(a, s))) return
      const set = linked.get(a) ?? new Set<string>()
      set.add(s)
      linked.set(a, set)
    },
    noteRemoved(a, s) {
      removed.add(simPairKey(a, s))
      linked.get(a)?.delete(s)
    },
    suppressed: (a, s) => removed.has(simPairKey(a, s)),
    autoLinkedFor: (a) => [...(linked.get(a) ?? [])]
  }
}

/**
 * The Simulator nodes of the caller's project that the caller is linked to: a persisted bridge in
 * either direction (the planner stores device → agent, but a hand-edited file may not), plus what
 * this run auto-linked and the autosave has not written yet. Only nodes in `simNodeIds` — the
 * caller's own project — can appear, so a link never reaches across projects.
 */
export function linkedSimulatorIds(
  callerId: string,
  simNodeIds: readonly string[],
  bridges: readonly PairLike[],
  ledger?: SimLinkLedger
): string[] {
  const sims = new Set(simNodeIds)
  const out = new Set<string>()
  for (const b of bridges) {
    if (b.source === callerId && sims.has(b.target)) out.add(b.target)
    else if (b.target === callerId && sims.has(b.source)) out.add(b.source)
  }
  for (const id of ledger?.autoLinkedFor(callerId) ?? []) if (sims.has(id)) out.add(id)
  // Keep the canvas's own order so "several linked" lists read the same as `--list`.
  return simNodeIds.filter((id) => out.has(id))
}

export type DefaultTarget =
  | { ok: true; node: string }
  | { ok: false; reason: 'none' | 'several'; candidates: string[] }

/** The `sim` target for a call that named neither `--node` nor `--udid`. */
export function defaultSimTarget(linked: readonly string[]): DefaultTarget {
  if (linked.length === 1) return { ok: true, node: linked[0] }
  return { ok: false, reason: linked.length === 0 ? 'none' : 'several', candidates: [...linked] }
}

/** Whether a resolved call should create a link now (the caller is a linkable agent, the pair is
 *  neither linked nor removed by the user this run). */
export function shouldAutoLink(
  callerId: string,
  simNodeId: string,
  linked: readonly string[],
  ledger: SimLinkLedger,
  callerCanLink: boolean
): boolean {
  if (!callerCanLink) return false
  if (linked.includes(simNodeId)) return false
  return !ledger.suppressed(callerId, simNodeId)
}

/** How long a "driving" highlight outlives the end of a call. Bounded on purpose (idle-energy rule). */
export const SIM_DRIVE_LINGER_MS = 4_000
/** The longest a highlight may run before its call finishes (an input call also waits for settle). */
export const SIM_DRIVE_MAX_MS = 20_000
