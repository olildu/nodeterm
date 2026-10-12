// Where an edge should meet a node when the node's visible body is smaller than its React Flow box.
// The Simulator node folds into its phone while not hovered, and a link line that ends at the
// (invisible) frame side reads as floating beside the device. The node publishes the phone's
// insets from its own box here; FloatingEdge shrinks that node's rectangle by them. Transient,
// renderer-only, never persisted. A node with no entry is drawn exactly as before.
import { create } from 'zustand'

export interface EdgeInsets {
  left: number
  top: number
  right: number
  bottom: number
}

interface EdgeAnchorInsetsState {
  byId: Record<string, EdgeInsets>
  set: (id: string, insets: EdgeInsets | null) => void
}

const same = (a: EdgeInsets | undefined, b: EdgeInsets | null): boolean =>
  !!a && !!b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom

export const useEdgeAnchorInsets = create<EdgeAnchorInsetsState>((setState) => ({
  byId: {},
  set: (id, insets) =>
    setState((s) => {
      if (insets === null) {
        if (!(id in s.byId)) return s
        const next = { ...s.byId }
        delete next[id]
        return { byId: next }
      }
      if (same(s.byId[id], insets)) return s
      return { byId: { ...s.byId, [id]: insets } }
    })
}))
