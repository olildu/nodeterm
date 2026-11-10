import { useRef } from 'react'
import { useStore } from '@xyflow/react'

/**
 * The project whose nodes React Flow's STORE holds right now — which is not always the project
 * whose nodes Canvas just handed to `<ReactFlow nodes>`, and not the active project either.
 *
 * xyflow copies the `nodes` prop into its store in a PASSIVE effect (StoreUpdater), and the store
 * lives in `ReactFlowProvider`, which sits ABOVE anything Canvas keys. So for a commit after a
 * project switch the store still holds the OUTGOING project's nodes, and whatever remounts in that
 * commit renders THEM. Keying the node subtree's session on the active id — or on the array Canvas
 * handed over (`renderedProjectId`), measured to leak the same way — remounted the outgoing nodes
 * under the incoming project's session: a team tab's terminals were created on this desktop's own
 * core, and a local terminal on the relay host (report-F, root cause B).
 *
 * Every array Canvas hands over is recorded against the project it belongs to (`renderedProjectId`,
 * the project THIS render's nodes are) in a per-hook WeakMap, and the store's array is looked up in
 * it. An array the map does not know — xyflow's own initial/reset array, or one handed while no
 * project was mounted (`renderedProjectId` null, the welcome-screen bail-out, whose array is still
 * the previous project's nodes) — answers the last known owner instead, initially `null`.
 *
 * The selector returns a primitive, so a drag frame (a new array, same project) re-renders nothing.
 * Must be called inside a `ReactFlowProvider`, with the EXACT array passed to `<ReactFlow nodes>`.
 */
export function useFlowStoreOwner(handed: readonly unknown[], renderedProjectId: string | null): string | null {
  const ownersRef = useRef<WeakMap<object, string> | null>(null)
  if (ownersRef.current === null) ownersRef.current = new WeakMap()
  const owners = ownersRef.current
  if (renderedProjectId !== null) owners.set(handed, renderedProjectId)
  const lastKnownRef = useRef<string | null>(null)
  // The fallback lives INSIDE the selector: a remount's store reset (`[]`) then selects the same
  // owner and schedules no render, where an `undefined` outside it cost a whole Canvas render.
  const held = useStore((s) => owners.get(s.nodes) ?? lastKnownRef.current)
  lastKnownRef.current = held
  return held
}
