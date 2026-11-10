import { describe, it, expect } from 'vitest'
import {
  arrangeByLineage,
  arrangeGroupChildren,
  arrangeNodes,
  COLLAPSED_HEIGHT,
  flowToNodeStates,
  GROUP_HEADER,
  GROUP_PAD,
  placeNodes,
  reparentNode,
  resizeNodes,
  rootPosition,
  tidyCanvas,
  type CanvasNode
} from './workspace'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import { NODE_SIZE_MAX } from '@shared/default-node-size'
import { geometryArgsRefusal } from '@shared/geometry-verbs'

// Issue #1288 — the geometry an agent could not set: the arrange gap, an existing node's size, and
// a node's place. Pure transforms, so every rule is pinned here; Canvas only parses and writes.

const n = (id: string, x: number, y: number, w = 100, h = 50, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({
    id,
    type: 'terminal',
    position: { x, y },
    width: w,
    height: h,
    style: { width: w, height: h },
    data: { title: id, color: '#fff', group: null },
    ...extra
  }) as CanvasNode
const frame = (id: string, x: number, y: number, w: number, h: number, parentId?: string): CanvasNode =>
  n(id, x, y, w, h, { type: 'group', ...(parentId ? { parentId, extent: 'parent' as const } : {}) })
const kid = (id: string, parentId: string, x: number, y: number, w = 100, h = 50): CanvasNode =>
  n(id, x, y, w, h, { parentId, extent: 'parent' as const })
const get = (nodes: CanvasNode[], id: string): CanvasNode => nodes.find((x) => x.id === id)!

describe('arrange --gap reaches every packing', () => {
  it('--nodes: gap 0 packs the nodes touching, 8 leaves 8 px', () => {
    const nodes = [n('a', 0, 0), n('b', 500, 0), n('c', 900, 900), n('d', 50, 700)]
    const tight = arrangeNodes(nodes, ['a', 'b', 'c', 'd'], { layout: 'grid', cols: 2, gap: 0 })
    expect(get(tight, 'b').position).toEqual({ x: 100, y: 0 })
    expect(get(tight, 'c').position).toEqual({ x: 0, y: 50 })
    expect(get(tight, 'd').position).toEqual({ x: 100, y: 50 })
    const eight = arrangeNodes(nodes, ['a', 'b', 'c', 'd'], { layout: 'grid', cols: 2, gap: 8 })
    expect(get(eight, 'd').position).toEqual({ x: 108, y: 58 })
    // Absent = the default 40, which is what every caller got before the flag existed.
    expect(get(arrangeNodes(nodes, ['a', 'b'], { layout: 'row' }), 'b').position).toEqual({ x: 140, y: 0 })
  })

  it('--group <frameId>: grid snapping does NOT undo a small gap — only the frame padding snaps', () => {
    const nodes = [frame('g', 0, 0, 900, 900), kid('a', 'g', 300, 300), kid('b', 'g', 40, 500)]
    const grid = 20
    const out = arrangeGroupChildren(nodes, 'g', { layout: 'row', gap: 0, grid })
    const a = rootPosition(get(out, 'a'), out)
    const b = rootPosition(get(out, 'b'), out)
    // Reading order (y, x): a then b. Touching, although 0 and 100 are not both "nice" grid numbers.
    expect(b.x - a.x).toBe(100)
    expect(b.y).toBe(a.y)
    const eight = arrangeGroupChildren(nodes, 'g', { layout: 'row', gap: 8, grid })
    expect(rootPosition(get(eight, 'b'), eight).x - rootPosition(get(eight, 'a'), eight).x).toBe(108)
    // The frame still keeps its OWN margin around the children: padding is not the gap.
    const pad = Math.max(GROUP_PAD, grid)
    expect(get(out, 'a').position).toEqual({ x: pad, y: pad + GROUP_HEADER })
  })

  it('--group top: Tidy canvas and lineage bands take it too', () => {
    const nodes = [n('a', 0, 0), n('b', 400, 0)]
    expect(get(tidyCanvas(nodes, [], { gap: 0 }), 'b').position).toEqual({ x: 100, y: 0 })
    const banded = arrangeByLineage([n('o', 0, 0), n('s', 0, 300)], [{ source: 'o', target: 's' }], { gap: 0 })
    expect(get(banded, 's').position).toEqual({ x: 0, y: 50 })
  })
})

describe('resizeNodes', () => {
  it('sets both axes, or one and keeps the other, and drops the stale measurement', () => {
    const nodes = [n('a', 0, 0, 600, 400, { measured: { width: 600, height: 400 } })]
    const both = resizeNodes(nodes, ['a'], { width: 540, height: 480 })
    if (!both.ok) throw new Error(both.error)
    const a = get(both.nodes, 'a')
    expect([a.width, a.height, a.style?.width, a.style?.height]).toEqual([540, 480, 540, 480])
    // flowToNodeStates prefers `measured`; a save racing the re-measure would persist the OLD size.
    expect(a.measured).toBeUndefined()
    expect(flowToNodeStates(both.nodes)[0].size).toEqual({ width: 540, height: 480 })
    expect(both.applied).toEqual([{ id: 'a', width: 540, height: 480, clamped: false, collapsed: false, restored: false }])

    const widthOnly = resizeNodes(nodes, ['a'], { width: 700 })
    if (!widthOnly.ok) throw new Error(widthOnly.error)
    expect([get(widthOnly.nodes, 'a').width, get(widthOnly.nodes, 'a').height]).toEqual([700, 400])
  })

  it('clamps to the kind minimum and the canvas maximum, and says so', () => {
    const nodes = [n('a', 0, 0, 600, 400), n('s', 0, 0, 240, 200, { type: 'sticky' })]
    const small = resizeNodes(nodes, ['a', 's'], { width: 10, height: 10 })
    if (!small.ok) throw new Error(small.error)
    const t = NODE_MIN_SIZES.terminal
    const st = NODE_MIN_SIZES.sticky
    expect(small.applied).toEqual([
      { id: 'a', width: t.width, height: t.height, clamped: true, collapsed: false, restored: false },
      { id: 's', width: st.width, height: st.height, clamped: true, collapsed: false, restored: false }
    ])
    expect(get(small.nodes, 'a').width).toBe(t.width)
    const big = resizeNodes(nodes, ['a'], { width: 99_999 })
    if (!big.ok) throw new Error(big.error)
    expect(big.applied[0]).toMatchObject({ width: NODE_SIZE_MAX.width, height: 400, clamped: true })
  })

  it('applies the size exactly — no grid snapping', () => {
    const out = resizeNodes([n('a', 0, 0, 600, 400)], ['a'], { width: 545, height: 333 }, 20)
    if (!out.ok) throw new Error(out.error)
    expect([get(out.nodes, 'a').width, get(out.nodes, 'a').height]).toEqual([545, 333])
  })

  it('refuses a group frame by name and changes NOTHING, even beside valid ids', () => {
    const nodes = [frame('g', 0, 0, 400, 300), n('a', 500, 0)]
    expect(resizeNodes(nodes, ['a', 'g'], { width: 300 })).toEqual({
      ok: false,
      error: 'resize: g is a group frame — a frame sizes itself to what it holds; resize the nodes inside it, or `arrange --group g`'
    })
  })

  it('skips unknown ids, and refuses when none resolve', () => {
    const nodes = [n('a', 0, 0, 600, 400)]
    const out = resizeNodes(nodes, ['ghost', 'a'], { width: 300 })
    expect(out.ok && out.unknown).toEqual(['ghost'])
    expect(resizeNodes(nodes, ['ghost'], { width: 300 })).toEqual({ ok: false, error: 'resize: none of the given node ids exist' })
  })

  it('returns the SAME array when every node already has that size', () => {
    const nodes = [n('a', 0, 0, 540, 480, { measured: { width: 540.3, height: 480 } })]
    const out = resizeNodes(nodes, ['a'], { width: 540, height: 480 })
    expect(out.ok && out.nodes).toBe(nodes)
  })

  it('a COLLAPSED node keeps its header-only look: width now, height when it is expanded', () => {
    const folded = n('a', 0, 0, 600, COLLAPSED_HEIGHT, { data: { title: 'a', color: '#fff', group: null, collapsed: true, expandedHeight: 400 } })
    const out = resizeNodes([folded], ['a'], { width: 540, height: 480 })
    if (!out.ok) throw new Error(out.error)
    const a = get(out.nodes, 'a')
    expect(a.width).toBe(540)
    expect(a.height).toBe(COLLAPSED_HEIGHT)
    expect(a.data.collapsed).toBe(true)
    expect(a.data.expandedHeight).toBe(480)
    // Persisted as the height it opens to — the collapsed-node rule of flowToNodeStates.
    expect(flowToNodeStates(out.nodes)[0].size).toEqual({ width: 540, height: 480 })
    expect(out.applied[0]).toMatchObject({ collapsed: true, height: 480 })
    // Unchanged expand height ⇒ only the width counts as a change.
    const same = resizeNodes(out.nodes, ['a'], { height: 480 })
    expect(same.ok && same.nodes).toBe(out.nodes)
  })

  it('a MAXIMIZED node is restored first, then sized — never left holding its restore rect', () => {
    const premaxRect = { x: 50, y: 60, width: 600, height: 400 }
    const maxed = n('a', 0, 0, 1900, 1000, { data: { title: 'a', color: '#fff', group: null, premaxRect } })
    const out = resizeNodes([maxed], ['a'], { width: 540 })
    if (!out.ok) throw new Error(out.error)
    const a = get(out.nodes, 'a')
    expect(a.data.premaxRect).toBeUndefined()
    // Back at its own spot, with its own height (the axis not named), at the new width.
    expect(a.position).toEqual({ x: 50, y: 60 })
    expect([a.width, a.height]).toEqual([540, 400])
    expect(out.applied[0]).toMatchObject({ restored: true })
    expect(flowToNodeStates(out.nodes)[0].premaxRect).toBeUndefined()
  })

  it('re-fits the frame — and every frame around it — around a resized child', () => {
    const nodes = [
      frame('outer', 0, 0, 400, 300),
      frame('inner', GROUP_PAD, GROUP_PAD + GROUP_HEADER, 200, 150, 'outer'),
      kid('a', 'inner', GROUP_PAD, GROUP_PAD + GROUP_HEADER, 100, 50)
    ]
    const before = rootPosition(get(nodes, 'a'), nodes)
    const out = resizeNodes(nodes, ['a'], { width: 900, height: 600 })
    if (!out.ok) throw new Error(out.error)
    const inner = get(out.nodes, 'inner')
    const outer = get(out.nodes, 'outer')
    expect(inner.width).toBe(900 + GROUP_PAD * 2)
    expect(outer.width as number).toBeGreaterThanOrEqual((inner.width as number) + GROUP_PAD * 2)
    // Resizing grows to the right and down; the node itself did not move.
    expect(rootPosition(get(out.nodes, 'a'), out.nodes)).toEqual(before)
  })
})

describe('placeNodes', () => {
  it('puts a top-level node at canvas coordinates, one axis or both', () => {
    const nodes = [n('a', 300, 300), n('b', 0, 0)]
    const out = placeNodes(nodes, ['a'], { x: 0, y: -40 })
    if (!out.ok) throw new Error(out.error)
    expect(get(out.nodes, 'a').position).toEqual({ x: 0, y: -40 })
    expect(get(out.nodes, 'b')).toBe(nodes[1])
    const xOnly = placeNodes(nodes, ['a'], { x: 10 })
    expect(xOnly.ok && get(xOnly.nodes, 'a').position).toEqual({ x: 10, y: 300 })
  })

  it('a framed node STAYS in its frame, lands exactly on the root coordinates, and the frames re-fit', () => {
    const nodes = [
      frame('outer', 1000, 1000, 400, 300),
      frame('inner', GROUP_PAD, GROUP_PAD + GROUP_HEADER, 200, 150, 'outer'),
      kid('a', 'inner', GROUP_PAD, GROUP_PAD + GROUP_HEADER),
      kid('b', 'inner', GROUP_PAD + 120, GROUP_PAD + GROUP_HEADER)
    ]
    const out = placeNodes(nodes, ['a'], { x: 200, y: 150 }, 20)
    if (!out.ok) throw new Error(out.error)
    const a = get(out.nodes, 'a')
    expect(a.parentId).toBe('inner')
    expect(rootPosition(a, out.nodes)).toEqual({ x: 200, y: 150 })
    // Its sibling did not move on the canvas, and both frames grew to hold the pair.
    expect(rootPosition(get(out.nodes, 'b'), out.nodes)).toEqual(rootPosition(get(nodes, 'b'), nodes))
    const inner = get(out.nodes, 'inner')
    const innerRoot = rootPosition(inner, out.nodes)
    expect(innerRoot.x).toBeLessThanOrEqual(200 - GROUP_PAD)
    expect(get(out.nodes, 'outer').position.x).toBeLessThanOrEqual(innerRoot.x)
    expect(out.placed).toEqual([{ id: 'a', x: 200, y: 150, restored: false }])
  })

  it('several ids with --x/--y move as ONE block: shape kept, top-left on (x, y)', () => {
    const nodes = [n('a', 100, 100), n('b', 200, 100), n('c', 100, 150)]
    const out = placeNodes(nodes, ['a', 'b', 'c'], { x: 0, y: 0 })
    if (!out.ok) throw new Error(out.error)
    expect(['a', 'b', 'c'].map((id) => get(out.nodes, id).position)).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 50 }
    ])
    // The BLOCK's top-left, not the first id's: listing order does not change where the block lands.
    for (const order of [['b', 'c', 'a'], ['c', 'b', 'a']]) {
      const reordered = placeNodes(nodes, order, { x: 0, y: 0 })
      if (!reordered.ok) throw new Error(reordered.error)
      expect(reordered.nodes.map((x) => x.position), order.join()).toEqual(out.nodes.map((x) => x.position))
    }
  })

  it('--dx/--dy shifts every node by the offset, framed or not', () => {
    const nodes = [frame('g', 0, 0, 300, 200), kid('k', 'g', 30, 70), n('a', 500, 500)]
    const before = rootPosition(get(nodes, 'k'), nodes)
    const out = placeNodes(nodes, ['k', 'a'], { dx: 8, dy: -8 })
    if (!out.ok) throw new Error(out.error)
    expect(rootPosition(get(out.nodes, 'k'), out.nodes)).toEqual({ x: before.x + 8, y: before.y - 8 })
    expect(get(out.nodes, 'a').position).toEqual({ x: 508, y: 492 })
  })

  it('a frame carries its subtree, and a listed descendant is not moved twice', () => {
    const nodes = [frame('g', 0, 0, 300, 200), kid('k', 'g', 30, 70)]
    const out = placeNodes(nodes, ['g', 'k'], { dx: 100, dy: 0 })
    if (!out.ok) throw new Error(out.error)
    expect(get(out.nodes, 'g').position).toEqual({ x: 100, y: 0 })
    expect(get(out.nodes, 'k').position).toEqual({ x: 30, y: 70 })
    expect(out.carried).toEqual(['k'])
  })

  it('a MAXIMIZED node is restored first, then placed', () => {
    const premaxRect = { x: 50, y: 60, width: 600, height: 400 }
    const maxed = n('a', 0, 0, 1900, 1000, { data: { title: 'a', color: '#fff', group: null, premaxRect } })
    const out = placeNodes([maxed], ['a'], { x: 10, y: 20 })
    if (!out.ok) throw new Error(out.error)
    const a = get(out.nodes, 'a')
    expect(a.data.premaxRect).toBeUndefined()
    expect(a.position).toEqual({ x: 10, y: 20 })
    expect([a.width, a.height]).toEqual([600, 400])
    expect(out.placed[0].restored).toBe(true)
  })

  it('places exactly — grid snapping on or off', () => {
    const out = placeNodes([n('a', 0, 0)], ['a'], { x: 13, y: 7 }, 20)
    expect(out.ok && get(out.nodes, 'a').position).toEqual({ x: 13, y: 7 })
  })

  it('returns the SAME array when nothing moves, and refuses when no id resolves', () => {
    const nodes = [n('a', 10, 20)]
    const out = placeNodes(nodes, ['a', 'ghost'], { x: 10, y: 20 })
    expect(out.ok && out.nodes).toBe(nodes)
    expect(out.ok && out.unknown).toEqual(['ghost'])
    expect(placeNodes(nodes, ['ghost'], { x: 0 })).toEqual({ ok: false, error: 'place: none of the given node ids exist' })
  })
})

describe('why placement is not a flag on move', () => {
  it('move without --group takes a framed node OUT of its frame — so move refuses --x/--y', () => {
    const nodes = [frame('g', 100, 100, 300, 200), kid('k', 'g', 30, 70)]
    // What `move --nodes k` does: reparent to the top level. An `--x` riding along would be ignored,
    // and the agent would read "moved" while the node left the frame it was arranged in.
    expect(get(reparentNode(nodes, 'k', null), 'k').parentId).toBeUndefined()
    expect(geometryArgsRefusal('move', { nodes: 'k', x: '10' })).toMatch(/takes it OUT of its frame/)
    // `place` keeps the frame.
    const placed = placeNodes(nodes, ['k'], { x: 10 })
    expect(placed.ok && get(placed.nodes, 'k').parentId).toBe('g')
  })
})
