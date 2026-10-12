import { create } from 'zustand'
import { useEffect, useReducer } from 'react'
import type { SimAgentEvent } from '@shared/sim'

/**
 * Which Simulator nodes an agent is driving through `sim` RIGHT NOW (CLAUDE.md → Simulator node →
 * Links). Fed by the `drive` events core pushes around an input call; this store decides nothing,
 * it paints what main verified (the caller is the verified node that made the call). The node chip
 * and the edge highlight both read it, so they cannot disagree.
 *
 * BOUNDED by construction (the idle-energy rule): every entry carries an `until`, the edge flows
 * only until then, and `useSimDrivingEntry` schedules ONE re-render at that instant. Nothing here
 * is a loop and nothing is persisted.
 */
export interface SimDriveEntry {
  ownerNodeId: string
  until: number
  /** What the call is doing, for the chip (already sanitized by core). */
  action?: string
  /** The latest tap, device points. `seq` changes per tap so the marker replays for a new one. */
  tap?: { x: number; y: number; seq: number }
  swipe?: { x1: number; y1: number; x2: number; y2: number; seq: number }
}
export type SimDriveEntries = Record<string, SimDriveEntry>

/** Fold one `drive` event in: it REPLACES the node's entry (the end-of-call event shortens the
 *  start-of-call window to the linger), and lapsed entries are swept. Pure. */
export function applySimDrive(prev: SimDriveEntries, ev: SimAgentEvent, now: number): SimDriveEntries {
  const next: SimDriveEntries = {}
  for (const [id, e] of Object.entries(prev)) if (e.until > now) next[id] = e
  if (ev.kind !== 'drive') return next
  for (const id of ev.simNodeIds) {
    if (!(ev.until > now)) {
      delete next[id]
      continue
    }
    const before = prev[id]
    const same = before && before.ownerNodeId === ev.ownerNodeId && before.until > now
    const seq = (same ? Math.max(before.tap?.seq ?? 0, before.swipe?.seq ?? 0) : 0) + 1
    // A progress event without a point keeps the previous one: the marker is a finite animation
    // and must not be unmounted half-way by the "waiting to settle" update that follows a tap.
    next[id] = {
      ownerNodeId: ev.ownerNodeId,
      until: ev.until,
      ...(ev.action ? { action: ev.action } : same && before.action ? { action: before.action } : {}),
      ...(ev.tap ? { tap: { ...ev.tap, seq } } : same && before.tap ? { tap: before.tap } : {}),
      ...(ev.swipe ? { swipe: { ...ev.swipe, seq } } : same && before.swipe ? { swipe: before.swipe } : {})
    }
  }
  return next
}

/** `simNodeId>ownerNodeId` pairs being driven at `now` — what the edge layer matches an edge against. */
export function drivenPairs(entries: SimDriveEntries, now: number): Set<string> {
  const out = new Set<string>()
  for (const [simId, e] of Object.entries(entries)) if (e.until > now) out.add(`${simId}>${e.ownerNodeId}`)
  return out
}

interface SimDrivingState {
  entries: SimDriveEntries
  apply: (ev: SimAgentEvent) => void
}

export const useSimDriving = create<SimDrivingState>((set) => {
  const apply = (ev: SimAgentEvent): void =>
    set((s) => ({ entries: applySimDrive(s.entries, ev, Date.now()) }))
  // One subscription for the app's lifetime; guarded so it imports cleanly under jsdom / the browser.
  if (typeof window !== 'undefined') window.nodeTerminal?.sim?.onAgentEvent?.((ev) => {
    if (ev.kind === 'drive') apply(ev)
  })
  return { entries: {}, apply }
})

/** The entry while `nodeId` is being driven, else null; re-renders once when the window lapses. */
export function useSimDrivingEntry(nodeId: string): SimDriveEntry | null {
  const entry = useSimDriving((s) => s.entries[nodeId])
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!entry) return
    const remaining = entry.until - Date.now()
    if (remaining <= 0) return
    const t = setTimeout(bump, remaining + 20)
    return () => clearTimeout(t)
  }, [entry])
  return entry && entry.until > Date.now() ? entry : null
}
