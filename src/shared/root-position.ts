/**
 * A node's position in ROOT (canvas) space: its own `position` plus the origin of every ancestor
 * frame, because a grouped node's `position` is relative to its parent.
 *
 * This is the ONE parent walk. Seven copies used to exist (renderer workspace, cold-open planner,
 * project store, focus, glyph layer and two in the headless node factory). They agreed on a valid
 * canvas and drifted on a corrupt one: one did not count the node itself as visited, so a node
 * that names itself as its parent was offset by its own position once.
 *
 * The walk always stops: every id is visited at most once (`seen` starts with the node's own id),
 * and it stops at a missing parent. `lookup` is the caller's own, so a caller that resolves a
 * duplicated id to the first match (`Array.find`) or the last one (a `Map` built from the array)
 * keeps doing so. `maxDepth` keeps the cap two callers already had; a parent chain that long is a
 * data bug.
 */
export interface ParentedNode {
  position: { x: number; y: number }
  parentId?: string
}

export function rootPositionWith<T extends ParentedNode>(
  node: ParentedNode & { id?: string },
  lookup: (id: string) => T | undefined,
  maxDepth: number = Number.POSITIVE_INFINITY
): { x: number; y: number } {
  let x = node.position.x
  let y = node.position.y
  let parentId = node.parentId
  const seen = new Set<string>(node.id ? [node.id] : [])
  for (let depth = 0; parentId && depth < maxDepth && !seen.has(parentId); depth++) {
    seen.add(parentId)
    const parent = lookup(parentId)
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    parentId = parent.parentId
  }
  return { x, y }
}
