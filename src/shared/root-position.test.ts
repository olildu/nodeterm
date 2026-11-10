import { describe, expect, it } from 'vitest'
import { rootPositionWith, type ParentedNode } from './root-position'

type TestNode = ParentedNode & { id: string }

const byIdLookup = (nodes: TestNode[]) => {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return (id: string) => byId.get(id)
}

describe('rootPositionWith', () => {
  it('returns a top-level node position unchanged', () => {
    const node = { id: 'a', position: { x: 3, y: 4 } }
    expect(rootPositionWith(node, byIdLookup([node]))).toEqual({ x: 3, y: 4 })
  })

  it('adds every ancestor frame origin through nested groups', () => {
    const outer = { id: 'outer', position: { x: 100, y: 200 } }
    const inner = { id: 'inner', position: { x: 10, y: 20 }, parentId: 'outer' }
    const leaf = { id: 'leaf', position: { x: 1, y: 2 }, parentId: 'inner' }
    expect(rootPositionWith(leaf, byIdLookup([outer, inner, leaf]))).toEqual({ x: 111, y: 222 })
  })

  it('stops at a missing parent with what it has accumulated', () => {
    const inner = { id: 'inner', position: { x: 10, y: 20 }, parentId: 'gone' }
    const leaf = { id: 'leaf', position: { x: 1, y: 2 }, parentId: 'inner' }
    expect(rootPositionWith(leaf, byIdLookup([inner, leaf]))).toEqual({ x: 11, y: 22 })
  })

  it('terminates on a parent cycle, visiting each frame once', () => {
    const a = { id: 'a', position: { x: 1, y: 1 }, parentId: 'b' }
    const b = { id: 'b', position: { x: 10, y: 10 }, parentId: 'a' }
    expect(rootPositionWith(a, byIdLookup([a, b]))).toEqual({ x: 11, y: 11 })
  })

  it('does not offset a node that names itself as its parent', () => {
    const self = { id: 'self', position: { x: 5, y: 7 }, parentId: 'self' }
    expect(rootPositionWith(self, byIdLookup([self]))).toEqual({ x: 5, y: 7 })
  })

  it('walks an id-less node (a not-yet-created placement) like any other', () => {
    const frame = { id: 'frame', position: { x: 50, y: 60 } }
    expect(rootPositionWith({ position: { x: 1, y: 2 }, parentId: 'frame' }, byIdLookup([frame]))).toEqual({
      x: 51,
      y: 62
    })
  })

  it('honors maxDepth', () => {
    const g1 = { id: 'g1', position: { x: 1000, y: 0 } }
    const g2 = { id: 'g2', position: { x: 100, y: 0 }, parentId: 'g1' }
    const leaf = { id: 'leaf', position: { x: 1, y: 0 }, parentId: 'g2' }
    const lookup = byIdLookup([g1, g2, leaf])
    expect(rootPositionWith(leaf, lookup, 1)).toEqual({ x: 101, y: 0 })
    expect(rootPositionWith(leaf, lookup, 0)).toEqual({ x: 1, y: 0 })
  })

  it("uses the caller's lookup, so first-match and last-match callers keep their answer", () => {
    const first = { id: 'dup', position: { x: 10, y: 0 } }
    const last = { id: 'dup', position: { x: 20, y: 0 } }
    const leaf = { id: 'leaf', position: { x: 1, y: 0 }, parentId: 'dup' }
    const all = [first, last, leaf]
    expect(rootPositionWith(leaf, (id) => all.find((node) => node.id === id))).toEqual({ x: 11, y: 0 })
    expect(rootPositionWith(leaf, byIdLookup(all))).toEqual({ x: 21, y: 0 })
  })
})
