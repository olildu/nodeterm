// "Match the largest terminal" sizing for NEW terminal/agent nodes (`Settings.newNodeSize`) — ONE
// definition, used by the renderer's `terminalNodeSize` and the server's headless canvas control.
// Pure: no DOM, no fs.

import type { NodeKind } from './types'

/** How a NEW terminal/agent node is sized (`Settings.newNodeSize`). `'default'` = the Default node
 *  size setting. `'matchLargest'` = the size of the largest terminal/agent node already on the
 *  canvas, falling back to the default when there is none. */
export type NewNodeSize = 'default' | 'matchLargest'

/** Reads `Settings.newNodeSize` from a hand-editable settings.json: only the literal
 *  `'matchLargest'` yields it; anything else (absent, misspelled, wrong type) is `'default'`. */
export function resolveNewNodeSize(v: unknown): NewNodeSize {
  return v === 'matchLargest' ? 'matchLargest' : 'default'
}

/** The fields the pick reads, normalized from either node shape (a persisted `CanvasNodeState`
 *  or a live React Flow node). `size` is the node's NORMAL size: a collapsed node's expanded size,
 *  a maximized node's pre-maximize size — a viewport-filling node must not set the size of every
 *  node opened after it. */
export interface SizedNode {
  kind: NodeKind
  size: { width: number; height: number }
}

/**
 * The size of the largest-AREA terminal/agent node (agents are `kind: 'terminal'` too), or `null`
 * when there is none. Area, not max-width × max-height: the result is always a size some node on
 * the canvas actually has. Ties keep the first in array order. Non-finite or non-positive sizes
 * (hand-edited workspace files) are skipped; the caller clamps the result to its own bounds.
 */
export function largestTerminalSize(
  nodes: readonly SizedNode[]
): { width: number; height: number } | null {
  let best: { width: number; height: number } | null = null
  for (const n of nodes) {
    if (n.kind !== 'terminal') continue
    const { width, height } = n.size
    if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) continue
    if (!best || width * height > best.width * best.height) best = { width, height }
  }
  return best
}
