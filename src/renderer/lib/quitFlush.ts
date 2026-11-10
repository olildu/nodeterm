// Pending writes that must land before the app quits or restarts to update, beyond the canvas
// autosave Canvas flushes itself.
//
// Main asks the renderer ONCE (`workspace.onFlushRequest`, src/main/renderer-flush.ts) and takes
// the first answer, capped at ~1 s. A second `onFlushRequest` subscriber would race Canvas's answer
// and lose, so anything else with a debounced write registers here instead and Canvas's handler
// waits for all of them before it answers. Today that is an open whiteboard editor
// (whiteboard/WhiteboardEditor.tsx), whose autosave waits 1.5 s after the last stroke.
//
// Desktop only in effect: the Server Edition's bridge has no flush request (a browser tab cannot
// hold its own close for an async write).

const flushes = new Set<() => Promise<unknown>>()

/** Register a pending-write flush; returns the unregister function. */
export function addQuitFlush(flush: () => Promise<unknown>): () => void {
  flushes.add(flush)
  return () => {
    flushes.delete(flush)
  }
}

/** Run every registered flush. Never rejects: one that fails must not stop the others, nor the quit. */
export async function runQuitFlushes(): Promise<void> {
  await Promise.allSettled([...flushes].map((flush) => Promise.resolve().then(flush)))
}
