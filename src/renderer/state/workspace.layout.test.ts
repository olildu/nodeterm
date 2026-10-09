import { describe, it, expect } from 'vitest'
import {
  arrangeNodes,
  alignNodes,
  arrangeByLineage,
  arrangeGroupChildren,
  fitGroupToChildren,
  groupArrangeRefusal,
  lineageLayers,
  tidyCanvas,
  crossLayout,
  crossUnits,
  tidyCanvasCross,
  CROSS_MAX_UNITS,
  GROUP_PAD,
  GROUP_HEADER,
  type CanvasNode
} from './workspace'
import { markLegacyWaitRopes, pruneRopes, waitRopeId } from '../lib/edgeModel'

// Minimal node stub: only the fields the layout fns read (id, position, width/height, parentId).
const n = (id: string, x: number, y: number, w = 100, h = 50): CanvasNode =>
  ({ id, type: 'terminal', position: { x, y }, width: w, height: h, data: { title: id, color: '#fff', group: null } }) as CanvasNode

describe('arrangeNodes', () => {
  it('lays out a row left-to-right from the bounding-box origin with the gap', () => {
    const out = arrangeNodes([n('a', 50, 90), n('b', 10, 200)], ['a', 'b'], { layout: 'row', gap: 20 })
    const a = out.find((x) => x.id === 'a')!
    const b = out.find((x) => x.id === 'b')!
    // origin = bounding-box top-left of current positions = (10, 90)
    expect(a.position).toEqual({ x: 10, y: 90 })
    expect(b.position).toEqual({ x: 10 + 100 + 20, y: 90 })
  })

  it('lays out a column top-to-bottom', () => {
    const out = arrangeNodes([n('a', 0, 0), n('b', 300, 300)], ['a', 'b'], { layout: 'column', gap: 10 })
    expect(out.find((x) => x.id === 'a')!.position).toEqual({ x: 0, y: 0 })
    expect(out.find((x) => x.id === 'b')!.position).toEqual({ x: 0, y: 50 + 10 })
  })

  it('grid wraps at cols and rows advance by the tallest node in the row', () => {
    const out = arrangeNodes(
      [n('a', 0, 0, 100, 50), n('b', 0, 0, 100, 80), n('c', 0, 0, 100, 50)],
      ['a', 'b', 'c'],
      { layout: 'grid', cols: 2, gap: 10, origin: { x: 0, y: 0 } }
    )
    expect(out.find((x) => x.id === 'a')!.position).toEqual({ x: 0, y: 0 })
    expect(out.find((x) => x.id === 'b')!.position).toEqual({ x: 110, y: 0 })
    // row 2 starts below the tallest of row 1 (80) + gap
    expect(out.find((x) => x.id === 'c')!.position).toEqual({ x: 0, y: 90 })
  })

  it('refuses a set mixing containers, and no-ops an empty/ghost selection', () => {
    // A top-level node + a group child cannot be co-arranged (their coordinate spaces differ),
    // so a MIXED set is a deliberate no-op — NOT "silently arrange the top-level ones" (that
    // silent subset-arrange was the surprise this replaced). Same for unknown ids.
    const child = { ...n('kid', 5, 5), parentId: 'g1' } as CanvasNode
    const nodes = [n('a', 7, 7), child]
    expect(arrangeNodes(nodes, ['a', 'kid', 'ghost'], { layout: 'row', origin: { x: 0, y: 0 } })).toBe(nodes)
    expect(arrangeNodes(nodes, ['ghost'])).toBe(nodes) // nothing resolvable → same array
    // Same-container sets still arrange: two children of one frame lay out in frame space.
    const framed = [
      { ...n('c1', 40, 40), parentId: 'g1' } as CanvasNode,
      { ...n('c2', 300, 5), parentId: 'g1' } as CanvasNode
    ]
    const laid = arrangeNodes(framed, ['c1', 'c2'], { layout: 'row', gap: 20 })
    expect(laid.find((x) => x.id === 'c1')!.position).toEqual({ x: 40, y: 5 })
    expect(laid.find((x) => x.id === 'c2')!.position).toEqual({ x: 40 + 100 + 20, y: 5 })
  })
})

describe('alignNodes', () => {
  const pair = () => [n('a', 10, 20, 100, 50), n('b', 200, 300, 60, 80)]
  it('left aligns x to the min x', () => {
    const out = alignNodes(pair(), ['a', 'b'], 'left')
    expect(out.map((x) => x.position.x)).toEqual([10, 10])
  })
  it('right aligns right edges to the max right edge', () => {
    const out = alignNodes(pair(), ['a', 'b'], 'right')
    // max right = 200+60=260 → a.x=260-100=160, b.x=200
    expect(out.find((x) => x.id === 'a')!.position.x).toBe(160)
    expect(out.find((x) => x.id === 'b')!.position.x).toBe(200)
  })
  it('vcenter aligns vertical centers; hcenter aligns horizontal centers', () => {
    const v = alignNodes(pair(), ['a', 'b'], 'vcenter')
    // bbox y: 20..380 → center 200 → a.y=200-25=175, b.y=200-40=160
    expect(v.find((x) => x.id === 'a')!.position.y).toBe(175)
    expect(v.find((x) => x.id === 'b')!.position.y).toBe(160)
    const h = alignNodes(pair(), ['a', 'b'], 'hcenter')
    // bbox x: 10..260 → center 135 → a.x=85, b.x=105
    expect(h.find((x) => x.id === 'a')!.position.x).toBe(85)
    expect(h.find((x) => x.id === 'b')!.position.x).toBe(105)
  })
  it('unknown ids only → same array', () => {
    const nodes = pair()
    expect(alignNodes(nodes, ['ghost'], 'left')).toBe(nodes)
  })
})

// A frame and its children: a rope routinely ends on a node INSIDE a frame, and the frame is the
// top-level object a layer layout has to place.
const frame = (id: string, x: number, y: number, w = 300, h = 200): CanvasNode =>
  ({ id, type: 'group', position: { x, y }, width: w, height: h, data: { title: id, color: '#fff', group: null } }) as CanvasNode
const child = (id: string, parentId: string, x = 10, y = 10): CanvasNode =>
  ({ id, type: 'terminal', position: { x, y }, width: 100, height: 50, parentId, data: { title: id, color: '#fff', group: null } }) as CanvasNode

describe('lineageLayers', () => {
  it('layers by who opened whom, roots first', () => {
    const nodes = [n('coord', 0, 0), n('arch', 500, 0), n('coder', 500, 200), n('rev', 900, 0)]
    const { layers, loose } = lineageLayers(nodes, [
      { source: 'coord', target: 'arch' },
      { source: 'coord', target: 'coder' },
      { source: 'arch', target: 'rev' }
    ])
    expect(layers).toEqual([['coord'], ['arch', 'coder'], ['rev']])
    expect(loose).toEqual([])
  })

  it('lifts a rope that lands inside a frame up to the frame itself', () => {
    // The coordinator opens a team into a group: the rope ends on `a1`, but `g1` is what moves.
    const nodes = [n('coord', 0, 0), frame('g1', 500, 0), child('a1', 'g1'), child('a2', 'g1')]
    const { layers, loose } = lineageLayers(nodes, [{ source: 'coord', target: 'a1' }])
    expect(layers).toEqual([['coord'], ['g1']])
    expect(loose).toEqual([])
  })

  it('drops a rope internal to one frame', () => {
    // a1 opened a2 inside the same group: both lift to g1, which cannot be its own opener.
    const nodes = [n('other', 0, 0), frame('g1', 500, 0), child('a1', 'g1'), child('a2', 'g1')]
    const { layers, loose } = lineageLayers(nodes, [{ source: 'a1', target: 'a2' }])
    expect(layers).toEqual([])
    expect(loose).toEqual(['other', 'g1'])
  })

  // c is opened by a AND by b: the shortest path would put c in layer 1 beside b, and the
  // a-to-c rope would then run sideways instead of down. Asserted in BOTH edge orders on
  // purpose: ropes arrive in creation order out of project.json, and a reducer that keeps the
  // LAST opener instead of the deepest one happens to be right in one of the two orders.
  it.each([
    ['deepest opener last', [{ source: 'a', target: 'c' }, { source: 'b', target: 'c' }]],
    ['deepest opener first', [{ source: 'b', target: 'c' }, { source: 'a', target: 'c' }]]
  ])('uses the LONGEST path, so every rope points downward (%s)', (_label, tail) => {
    const nodes = [n('a', 0, 0), n('b', 300, 0), n('c', 600, 0)]
    const { layers } = lineageLayers(nodes, [{ source: 'a', target: 'b' }, ...tail])
    expect(layers).toEqual([['a'], ['b'], ['c']])
  })

  it('keeps untouched nodes out of layer 0, in their own loose band', () => {
    const nodes = [n('coord', 0, 0), n('agent', 300, 0), n('note', 0, 400), n('editor', 300, 400)]
    const { layers, loose } = lineageLayers(nodes, [{ source: 'coord', target: 'agent' }])
    expect(layers).toEqual([['coord'], ['agent']])
    expect(loose).toEqual(['note', 'editor'])
  })

  it('orders a layer by the slot of its opener above, so siblings sit together', () => {
    // Two roots with two children each, interleaved on the canvas: without the slot ordering the
    // children alternate p1,p2,p1,p2 and every rope crosses.
    const nodes = [
      n('p1', 0, 0),
      n('p2', 400, 0),
      n('b1', 600, 300),
      n('a1', 0, 300),
      n('b2', 900, 300),
      n('a2', 300, 300)
    ]
    const { layers } = lineageLayers(nodes, [
      { source: 'p1', target: 'a1' },
      { source: 'p2', target: 'b1' },
      { source: 'p1', target: 'a2' },
      { source: 'p2', target: 'b2' }
    ])
    expect(layers[0]).toEqual(['p1', 'p2'])
    expect(layers[1]).toEqual(['a1', 'a2', 'b1', 'b2'])
  })

  it('does not hang on a cycle', () => {
    const nodes = [n('a', 0, 0), n('b', 300, 0), n('c', 600, 0)]
    const { layers, loose } = lineageLayers(nodes, [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' }
    ])
    // Every node is still placed exactly once and nothing is lost.
    expect([...layers.flat(), ...loose].sort()).toEqual(['a', 'b', 'c'])
  })

  it('ignores a rope whose endpoint is no longer on the canvas', () => {
    const nodes = [n('a', 0, 0), n('b', 300, 0)]
    const { layers, loose } = lineageLayers(nodes, [{ source: 'ghost', target: 'b' }])
    expect(layers).toEqual([])
    expect(loose).toEqual(['a', 'b'])
  })
})

describe('arrangeByLineage', () => {
  const edges = [
    { source: 'coord', target: 'arch' },
    { source: 'coord', target: 'coder' }
  ]

  it('stacks each layer as a row, growing downward from the bounding-box origin', () => {
    const nodes = [n('coord', 100, 50), n('arch', 900, 400), n('coder', 500, 900)]
    const out = arrangeByLineage(nodes, edges, { gap: 20 })
    const at = (id: string) => out.find((x) => x.id === id)!.position
    // origin = (100, 50); layer 0 holds one 50-high node, so layer 1 starts at 50 + 50 + 20.
    expect(at('coord')).toEqual({ x: 100, y: 50 })
    expect(at('arch')).toEqual({ x: 100, y: 120 })
    expect(at('coder')).toEqual({ x: 100 + 100 + 20, y: 120 })
  })

  it('puts the loose band last', () => {
    const nodes = [n('coord', 0, 0), n('arch', 300, 0), n('coder', 600, 0), n('note', 0, 500)]
    const out = arrangeByLineage(nodes, edges, { gap: 20 })
    const y = (id: string) => out.find((x) => x.id === id)!.position.y
    expect(y('note')).toBeGreaterThan(y('arch'))
  })

  it('advances by the TALLEST member of a band', () => {
    // The frame in layer 0 is 200 high; the next band must clear it, not the 50 of a terminal.
    const nodes = [frame('g1', 0, 0), child('a1', 'g1'), n('other', 400, 0), n('kid', 0, 900)]
    const out = arrangeByLineage(nodes, [{ source: 'a1', target: 'kid' }], { gap: 20 })
    expect(out.find((x) => x.id === 'kid')!.position.y).toEqual(0 + 200 + 20)
  })

  it('moves a frame as one unit and leaves its children alone', () => {
    const nodes = [n('coord', 0, 0), frame('g1', 800, 600), child('a1', 'g1', 10, 10)]
    const out = arrangeByLineage(nodes, [{ source: 'coord', target: 'a1' }], { gap: 20 })
    expect(out.find((x) => x.id === 'g1')!.position).toEqual({ x: 0, y: 70 })
    // A child position is relative to its frame and must not be rewritten.
    expect(out.find((x) => x.id === 'a1')!.position).toEqual({ x: 10, y: 10 })
  })

  it('returns the SAME array when no rope is usable', () => {
    // The caller skips the undo entry and the project.json write rather than rewriting every
    // position to where it already was.
    const nodes = [n('a', 0, 0), n('b', 300, 0)]
    expect(arrangeByLineage(nodes, [])).toBe(nodes)
  })

  it('returns the SAME array below two top-level nodes', () => {
    const one = [n('a', 0, 0)]
    expect(arrangeByLineage(one, edges)).toBe(one)
  })
})

describe('placement order', () => {
  // `arrangeNodes` used to fill its slots in ARRAY order and ignore the order of the ids it was
  // handed, which silently discarded every caller's sort: Tidy canvas's reading order, and the
  // slot order `lineageLayers` computes so siblings sit under their opener.
  it('arrangeNodes fills its slots in the order of the ids, not in array order', () => {
    const out = arrangeNodes([n('a', 0, 0), n('b', 300, 0)], ['b', 'a'], {
      layout: 'row',
      gap: 10,
      origin: { x: 0, y: 0 }
    })
    expect(out.find((x) => x.id === 'b')!.position).toEqual({ x: 0, y: 0 })
    expect(out.find((x) => x.id === 'a')!.position).toEqual({ x: 110, y: 0 })
    // The array itself is not reordered: persistence order is not the layout's to change.
    expect(out.map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('a repeated id takes one slot', () => {
    const out = arrangeNodes([n('a', 0, 0), n('b', 300, 0)], ['a', 'a', 'b'], {
      layout: 'row',
      gap: 10,
      origin: { x: 0, y: 0 }
    })
    expect(out.find((x) => x.id === 'b')!.position.x).toBe(110)
  })

  it('arrangeByLineage PLACES siblings under their opener, not in array order', () => {
    // The same interleaved canvas as the lineageLayers slot test, asserted on positions: the
    // layer order is only worth computing if the placement honours it.
    const nodes = [
      n('p1', 0, 0),
      n('p2', 400, 0),
      n('b1', 600, 300),
      n('a1', 0, 300),
      n('b2', 900, 300),
      n('a2', 300, 300)
    ]
    const out = arrangeByLineage(
      nodes,
      [
        { source: 'p1', target: 'a1' },
        { source: 'p2', target: 'b1' },
        { source: 'p1', target: 'a2' },
        { source: 'p2', target: 'b2' }
      ],
      { gap: 10 }
    )
    const row = out
      .filter((x) => x.position.y > 0)
      .sort((x, y) => x.position.x - y.position.x)
      .map((x) => x.id)
    expect(row).toEqual(['a1', 'a2', 'b1', 'b2'])
  })
})

// A frame nested in another frame.
const inner = (id: string, parentId: string, x: number, y: number, w = 300, h = 200): CanvasNode =>
  ({ ...frame(id, x, y, w, h), parentId }) as CanvasNode
const at = (nodes: CanvasNode[], id: string) => nodes.find((x) => x.id === id)!
/** `kid` lies fully inside `parent` (kid positions are parent-relative). */
const holds = (nodes: CanvasNode[], parent: string, kid: string): boolean => {
  const p = at(nodes, parent)
  const k = at(nodes, kid)
  return (
    k.position.x >= 0 &&
    k.position.y >= 0 &&
    k.position.x + (k.width as number) <= (p.width as number) &&
    k.position.y + (k.height as number) <= (p.height as number)
  )
}

describe('lineageLayers inside a frame', () => {
  it('layers the frame\'s direct children and ignores a rope from outside it', () => {
    // `coord` opened the whole team from outside the frame: that says nothing about the order
    // INSIDE it, so only a1→a2 / a1→a3 count.
    const nodes = [n('coord', 0, 0), frame('g1', 500, 0), child('a1', 'g1'), child('a2', 'g1', 200), child('a3', 'g1', 400), child('note', 'g1', 0, 300)]
    const { layers, loose } = lineageLayers(
      nodes,
      [
        { source: 'coord', target: 'a1' },
        { source: 'a1', target: 'a2' },
        { source: 'a1', target: 'a3' }
      ],
      'g1'
    )
    expect(layers).toEqual([['a1'], ['a2', 'a3']])
    expect(loose).toEqual(['note'])
  })

  it('lifts a rope that lands inside a NESTED frame up to that frame', () => {
    const nodes = [frame('g1', 0, 0), child('a1', 'g1'), inner('in', 'g1', 200, 0), child('k', 'in')]
    const { layers } = lineageLayers(nodes, [{ source: 'a1', target: 'k' }], 'g1')
    expect(layers).toEqual([['a1'], ['in']])
  })

  it('the top level is unchanged by the container parameter', () => {
    const nodes = [n('coord', 0, 0), frame('g1', 500, 0), child('a1', 'g1'), child('a2', 'g1')]
    const edges = [{ source: 'coord', target: 'a1' }]
    expect(lineageLayers(nodes, edges)).toEqual(lineageLayers(nodes, edges, null))
  })
})

describe('arrangeGroupChildren', () => {
  // g1 sits at (500, 300); its three children are scattered, one of them outside the frame.
  const scattered = () => [
    frame('g1', 500, 300, 300, 200),
    child('c1', 'g1', 200, 150),
    child('c2', 'g1', 10, 20),
    child('c3', 'g1', 400, 400)
  ]

  it('packs the children in reading order from the frame\'s content origin', () => {
    const out = arrangeGroupChildren(scattered(), 'g1')
    // 3 children → 2 columns; reading order is c2 (y 20), c1 (y 150), c3 (y 400).
    expect(at(out, 'c2').position).toEqual({ x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER })
    expect(at(out, 'c1').position).toEqual({ x: GROUP_PAD + 100 + 40, y: GROUP_PAD + GROUP_HEADER })
    expect(at(out, 'c3').position).toEqual({ x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER + 50 + 40 })
  })

  it('keeps the frame\'s own top-left where it was and sizes it to the content', () => {
    const out = arrangeGroupChildren(scattered(), 'g1')
    const g = at(out, 'g1')
    expect(g.position).toEqual({ x: 500, y: 300 })
    // 2 columns of 100 + one 40 gap, 2 rows of 50 + one 40 gap, padded on every side + header.
    expect(g.width).toBe(240 + GROUP_PAD * 2)
    expect(g.height).toBe(140 + GROUP_PAD * 2 + GROUP_HEADER)
    expect(g.style).toMatchObject({ width: g.width, height: g.height })
    for (const id of ['c1', 'c2', 'c3']) expect(holds(out, 'g1', id)).toBe(true)
  })

  it('GROWS a frame whose content does not fit it', () => {
    // Six children in a column are far taller than the 200-high frame.
    const nodes = [frame('g1', 0, 0, 300, 200), ...[0, 1, 2, 3, 4, 5].map((i) => child(`c${i}`, 'g1', 10, 10 + i * 5))]
    const out = arrangeGroupChildren(nodes, 'g1', { layout: 'column' })
    expect(at(out, 'g1').height).toBe(6 * 50 + 5 * 40 + GROUP_PAD * 2 + GROUP_HEADER)
    expect((at(out, 'g1').height as number) > 200).toBe(true)
    for (let i = 0; i < 6; i++) expect(holds(out, 'g1', `c${i}`)).toBe(true)
  })

  it('SHRINKS a frame that was sized to where its children used to be', () => {
    const nodes = [frame('g1', 0, 0, 2000, 1500), child('c1', 'g1', 1700, 1300), child('c2', 'g1', 50, 80)]
    const out = arrangeGroupChildren(nodes, 'g1', { layout: 'row' })
    expect(at(out, 'g1').width).toBe(240 + GROUP_PAD * 2)
    expect(at(out, 'g1').position).toEqual({ x: 0, y: 0 })
  })

  it('honours --cols', () => {
    const nodes = [frame('g1', 0, 0), ...[0, 1, 2, 3].map((i) => child(`c${i}`, 'g1', 10 + i * 5, 10))]
    const out = arrangeGroupChildren(nodes, 'g1', { layout: 'grid', cols: 4 })
    expect(new Set(['c0', 'c1', 'c2', 'c3'].map((id) => at(out, id).position.y)).size).toBe(1)
  })

  it('moves a nested frame as one rigid unit', () => {
    const nodes = [frame('g1', 0, 0, 900, 700), child('t', 'g1', 600, 400), inner('in', 'g1', 500, 20), child('k', 'in', 33, 44)]
    const out = arrangeGroupChildren(nodes, 'g1', { layout: 'row' })
    // `in` is a member and is placed; what is inside it is not the outer frame's to touch.
    expect(at(out, 'in').position).toEqual({ x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER })
    expect(at(out, 'in').width).toBe(300)
    expect(at(out, 'k').position).toEqual({ x: 33, y: 44 })
    expect(at(out, 't').position.x).toBe(GROUP_PAD + 300 + 40)
  })

  it('re-fits EVERY ancestor frame, so a nested frame never overflows its parent', () => {
    // top ⊃ mid ⊃ g1. Arranging g1's six children as a row makes it far wider than both.
    const nodes = [
      frame('top', 100, 100, 500, 400),
      inner('mid', 'top', GROUP_PAD, GROUP_PAD + GROUP_HEADER, 400, 300),
      inner('g1', 'mid', GROUP_PAD, GROUP_PAD + GROUP_HEADER, 300, 200),
      ...[0, 1, 2, 3, 4, 5].map((i) => child(`c${i}`, 'g1', 10, 10 + i * 5))
    ]
    const out = arrangeGroupChildren(nodes, 'g1', { layout: 'row' })
    expect(at(out, 'g1').width).toBe(6 * 100 + 5 * 40 + GROUP_PAD * 2)
    expect(holds(out, 'mid', 'g1')).toBe(true)
    expect(holds(out, 'top', 'mid')).toBe(true)
    // Nothing jumped: the outermost frame is where it was, and so is everything's root position.
    expect(at(out, 'top').position).toEqual({ x: 100, y: 100 })
    expect(at(out, 'mid').position).toEqual({ x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER })
    expect(at(out, 'g1').position).toEqual({ x: GROUP_PAD, y: GROUP_PAD + GROUP_HEADER })
  })

  it('fitting only the frame itself is NOT enough (the mutation this guards)', () => {
    // The same tree, fitted without the walk up: g1 ends up wider than the frame holding it.
    const nodes = [
      frame('top', 100, 100, 500, 400),
      inner('g1', 'top', GROUP_PAD, GROUP_PAD + GROUP_HEADER, 300, 200),
      ...[0, 1, 2, 3, 4, 5].map((i) => child(`c${i}`, 'g1', 10, 10 + i * 5))
    ]
    const ids = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']
    const onlyOwn = fitGroupToChildren(arrangeNodes(nodes, ids, { layout: 'row' }), 'g1')
    expect(holds(onlyOwn, 'top', 'g1')).toBe(false)
    expect(holds(arrangeGroupChildren(nodes, 'g1', { layout: 'row' }), 'top', 'g1')).toBe(true)
  })

  it('lays the children out as lineage bands and sizes the frame to them', () => {
    const nodes = [frame('g1', 40, 40, 300, 200), child('a2', 'g1', 250, 10), child('a1', 'g1', 10, 300), child('a3', 'g1', 400, 10)]
    const out = arrangeGroupChildren(nodes, 'g1', {
      layout: 'lineage',
      edges: [
        { source: 'a1', target: 'a2' },
        { source: 'a1', target: 'a3' }
      ]
    })
    const top = GROUP_PAD + GROUP_HEADER
    expect(at(out, 'a1').position).toEqual({ x: GROUP_PAD, y: top })
    expect(at(out, 'a2').position).toEqual({ x: GROUP_PAD, y: top + 50 + 40 })
    expect(at(out, 'a3').position).toEqual({ x: GROUP_PAD + 100 + 40, y: top + 50 + 40 })
    expect(at(out, 'g1').position).toEqual({ x: 40, y: 40 })
    for (const id of ['a1', 'a2', 'a3']) expect(holds(out, 'g1', id)).toBe(true)
  })

  it('with snapping on, keeps a frame that is on the grid on it', () => {
    const GRID = 40
    const nodes = [frame('g1', 400, 200, 320, 200), child('c1', 'g1', 200, 150), child('c2', 'g1', 10, 20)]
    const out = arrangeGroupChildren(nodes, 'g1', { layout: 'row', grid: GRID })
    const g = at(out, 'g1')
    expect(g.position).toEqual({ x: 400, y: 200 })
    expect((g.width as number) % GRID).toBe(0)
    expect((g.height as number) % GRID).toBe(0)
    expect(holds(out, 'g1', 'c1') && holds(out, 'g1', 'c2')).toBe(true)
  })

  describe('returns the SAME array when there is nothing to do', () => {
    it('a missing id, a non-group id and an empty frame', () => {
      const nodes = [frame('g1', 0, 0), n('t', 500, 0)]
      expect(arrangeGroupChildren(nodes, 'ghost')).toBe(nodes)
      expect(arrangeGroupChildren(nodes, 't')).toBe(nodes)
      expect(arrangeGroupChildren(nodes, 'g1')).toBe(nodes)
    })

    it('a lineage layout with no rope joining two of the children', () => {
      const nodes = [n('coord', 0, 0), frame('g1', 500, 0), child('a1', 'g1'), child('a2', 'g1', 200)]
      // The only rope comes from outside the frame.
      expect(
        arrangeGroupChildren(nodes, 'g1', { layout: 'lineage', edges: [{ source: 'coord', target: 'a1' }] })
      ).toBe(nodes)
    })

    it('a frame that is already arranged — a second run moves nothing', () => {
      // No undo entry and no project.json write for a click that visibly did nothing.
      const once = arrangeGroupChildren(
        [frame('g1', 500, 300, 300, 200), child('c1', 'g1', 200, 150), child('c2', 'g1', 10, 20)],
        'g1'
      )
      expect(arrangeGroupChildren(once, 'g1')).toBe(once)
    })
  })
})

describe('groupArrangeRefusal', () => {
  const nodes = [n('t', 0, 0), frame('empty', 0, 0), frame('g1', 500, 0), child('a1', 'g1'), child('a2', 'g1', 200)]
  it('names each reason, and is null when the layout can run', () => {
    expect(groupArrangeRefusal(nodes, 'ghost', 'grid')).toBe('no group frame has the id ghost')
    expect(groupArrangeRefusal(nodes, 't', 'grid')).toBe('no group frame has the id t')
    expect(groupArrangeRefusal(nodes, 'empty', 'grid')).toBe('this group is empty')
    expect(groupArrangeRefusal(nodes, 'g1', 'grid')).toBeNull()
    expect(groupArrangeRefusal(nodes, 'g1', 'lineage')).toBe('nothing in this group was opened by another node in it')
    expect(groupArrangeRefusal(nodes, 'g1', 'lineage', [{ source: 'a1', target: 'a2' }])).toBeNull()
  })

  it('agrees with the transform: a refusal is exactly a same-array result', () => {
    for (const id of ['ghost', 't', 'empty']) expect(arrangeGroupChildren(nodes, id)).toBe(nodes)
    expect(arrangeGroupChildren(nodes, 'g1')).not.toBe(nodes)
  })
})

// Ropes as the canvas mints them: an opener is `ctrl-<source>-<target>`, a wait `ctrl-after-…`.
const opens = (source: string, target: string) => ({ id: `ctrl-${source}-${target}`, source, target })
const waits = (dep: string, node: string) => ({ id: waitRopeId(dep, node), source: dep, target: node })
const withOpenedBy = (nd: CanvasNode, openedBy: string): CanvasNode =>
  ({ ...nd, data: { ...nd.data, openedBy } }) as CanvasNode
/** Today's Tidy canvas, verbatim: the reading-order grid over every top-level node. */
const plainTidy = (nodes: CanvasNode[]) =>
  arrangeNodes(
    nodes,
    nodes
      .filter((x) => !x.parentId)
      .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
      .map((x) => x.id),
    { layout: 'grid' }
  )
const positions = (nodes: CanvasNode[]) => nodes.map((x) => [x.id, x.position.x, x.position.y])

describe('tidyCanvas', () => {
  // The orchestrator reads LAST (bottom-right) and a loose note sits between its stations, which
  // is exactly where the plain grid lost it: packed after everything else, away from its team.
  const team = () => [n('s1', 0, 0), n('s2', 500, 0), n('note', 200, 300), n('orch', 1000, 800)]
  const teamRopes = [opens('orch', 's1'), opens('orch', 's2')]

  it('with no lineage, is exactly the plain reading-order grid', () => {
    const nodes = [n('a', 300, 0), n('b', 0, 0), frame('g', 0, 400), child('k', 'g'), n('c', 900, 100)]
    expect(positions(tidyCanvas(nodes, []))).toEqual(positions(plainTidy(nodes)))
    // Waits alone are not lineage: sequencing between peers does not make anyone an orchestrator.
    expect(positions(tidyCanvas(nodes, [waits('a', 'b'), waits('b', 'c')]))).toEqual(positions(plainTidy(nodes)))
  })

  it('puts the orchestrator first, at its cluster\'s top-left, with its team right beside it', () => {
    const out = tidyCanvas(team(), teamRopes)
    // origin = the units' bounding-box top-left = (0, 0)
    expect(at(out, 'orch').position).toEqual({ x: 0, y: 0 })
    // two stations → a 2-column team grid starting one gap right of the orchestrator
    expect(at(out, 's1').position).toEqual({ x: 140, y: 0 })
    expect(at(out, 's2').position).toEqual({ x: 280, y: 0 })
    // the node nobody opened is packed after the cluster, below it
    expect(at(out, 'note').position).toEqual({ x: 0, y: 90 })
    // and the old grid did put the orchestrator last — what this test exists to catch
    expect(at(plainTidy(team()), 'orch').position).not.toEqual({ x: 0, y: 0 })
  })

  it('clusters a nested team under its own orchestrator, inside the parent\'s team', () => {
    // coord opened lead + solo; lead opened w1 + w2.
    const nodes = [n('w1', 0, 0), n('w2', 900, 0), n('solo', 0, 500), n('lead', 400, 400), n('coord', 800, 800)]
    const out = tidyCanvas(nodes, [opens('coord', 'lead'), opens('coord', 'solo'), opens('lead', 'w1'), opens('lead', 'w2')])
    expect(at(out, 'coord').position).toEqual({ x: 0, y: 0 })
    // coord's team, in reading order: lead (y 400) then solo (y 500), 2 columns.
    expect(at(out, 'lead').position).toEqual({ x: 140, y: 0 })
    // lead's own block: lead, then its team (w1, w2) to its right
    expect(at(out, 'w1').position).toEqual({ x: 280, y: 0 })
    expect(at(out, 'w2').position).toEqual({ x: 420, y: 0 })
    // solo follows lead's whole block in coord's team row
    expect(at(out, 'solo').position).toEqual({ x: 560, y: 0 })
  })

  it('keeps a frame as one rigid unit and lifts a rope into it to the frame', () => {
    // The #1114 shape: a coordinator opens a lead INSIDE a frame; the frame is what moves.
    const nodes = [frame('g', 0, 0, 300, 200), child('lead', 'g', 30, 70), child('w', 'g', 150, 70), n('coord', 600, 600)]
    const out = tidyCanvas(nodes, [opens('coord', 'lead'), opens('lead', 'w')])
    expect(at(out, 'coord').position).toEqual({ x: 0, y: 0 })
    expect(at(out, 'g').position).toEqual({ x: 140, y: 0 })
    // children keep their frame-relative spots
    expect(at(out, 'lead').position).toEqual({ x: 30, y: 70 })
    expect(at(out, 'w').position).toEqual({ x: 150, y: 70 })
  })

  it('follows openers, not waits: a verify panel stays the orchestrator\'s team', () => {
    // orch opened the target and both reviewers; the reviewers WAIT on the target.
    const nodes = [n('t', 0, 0), n('r1', 0, 300), n('r2', 300, 300), n('orch', 900, 900)]
    const out = tidyCanvas(nodes, [opens('orch', 't'), waits('t', 'r1'), opens('orch', 'r1'), waits('t', 'r2'), opens('orch', 'r2')])
    expect(at(out, 'orch').position).toEqual({ x: 0, y: 0 })
    // one team of three (2 columns), in reading order — the target does not lead its reviewers
    expect(at(out, 't').position).toEqual({ x: 140, y: 0 })
    expect(at(out, 'r1').position).toEqual({ x: 280, y: 0 })
    expect(at(out, 'r2').position).toEqual({ x: 140, y: 90 })
  })

  it('reads a legacy canvas (no openedBy, waits unmarked) through the load-time mark', () => {
    // Saved before waits had their own id: the second rope into `x` is p's wait, minted as an opener.
    const legacy = [opens('o', 'x'), opens('p', 'x')]
    const nodes = [n('x', 0, 0), n('p', 400, 0), n('o', 800, 800)]
    const out = tidyCanvas(nodes, markLegacyWaitRopes(legacy))
    expect(at(out, 'o').position).toEqual({ x: 0, y: 0 })
    expect(at(out, 'x').position).toEqual({ x: 140, y: 0 })
  })

  it('honours a recorded openedBy over a surviving rope that is not the opener\'s', () => {
    // x records `o` as its opener; o is gone and its rope with it. p's surviving rope (an unmarked
    // wait from an old file) must not promote p to x's orchestrator.
    const nodes = [withOpenedBy(n('x', 0, 0), 'o'), n('p', 400, 0)]
    expect(positions(tidyCanvas(nodes, [opens('p', 'x')]))).toEqual(positions(plainTidy(nodes)))
    // Without the record, the legacy rope rule makes p the opener.
    const unrecorded = [n('x', 0, 0), n('p', 400, 0)]
    expect(at(tidyCanvas(unrecorded, [opens('p', 'x')]), 'p').position).toEqual({ x: 0, y: 0 })
  })

  it('drops a deleted station and lets a deleted orchestrator\'s team fall loose', () => {
    const live = team().filter((x) => x.id !== 's2')
    const ropes = pruneRopes(teamRopes, new Set(live.map((x) => x.id)))
    const out = tidyCanvas(live, ropes)
    expect(at(out, 'orch').position).toEqual({ x: 0, y: 0 })
    expect(at(out, 's1').position).toEqual({ x: 140, y: 0 })
    // orchestrator deleted: nothing leads anything, so it is the plain grid again — even with the
    // dead rope still in hand (a stored file is not pruned).
    const orphaned = team().filter((x) => x.id !== 'orch')
    expect(positions(tidyCanvas(orphaned, teamRopes))).toEqual(positions(plainTidy(orphaned)))
  })

  it('survives an opener cycle, led by the member that reads first', () => {
    const nodes = [n('b', 500, 0), n('a', 0, 0), n('c', 0, 500)]
    const out = tidyCanvas(nodes, [opens('a', 'b'), opens('b', 'a')])
    expect(at(out, 'a').position).toEqual({ x: 0, y: 0 })
    expect(at(out, 'b').position).toEqual({ x: 140, y: 0 })
    // A cycle that only exists once ropes are lifted to frames: a (in g) opens b, b opens a2 (in g).
    const lifted = [frame('g', 0, 0), child('a', 'g'), child('a2', 'g'), n('b', 600, 0)]
    const out2 = tidyCanvas(lifted, [opens('a', 'b'), opens('b', 'a2')])
    expect(at(out2, 'g').position).toEqual({ x: 0, y: 0 })
    expect(at(out2, 'b').position).toEqual({ x: 340, y: 0 })
  })

  it('gives a frame to the unit that opened most of its contents', () => {
    const nodes = [frame('g', 0, 600), child('k1', 'g'), child('k2', 'g'), child('k3', 'g'), n('x', 0, 0), n('y', 400, 0)]
    const out = tidyCanvas(nodes, [opens('x', 'k1'), opens('y', 'k2'), opens('y', 'k3')])
    // y opened two of g's three children, so g is y's team; x leads nothing and packs loose.
    expect(at(out, 'g').position.x).toBe(at(out, 'y').position.x + 100 + 40)
    expect(at(out, 'g').position.y).toBe(at(out, 'y').position.y)
    // A tie goes to the earliest rope: x opened k1 first, y opened k2 after.
    const tied = tidyCanvas(nodes, [opens('x', 'k1'), opens('y', 'k2')])
    expect(at(tied, 'g').position.x).toBe(at(tied, 'x').position.x + 100 + 40)
    expect(at(tied, 'g').position.y).toBe(at(tied, 'x').position.y)
  })

  it('returns the SAME array when nothing moves', () => {
    const once = tidyCanvas(team(), teamRopes)
    expect(tidyCanvas(once, teamRopes)).toBe(once)
    const single = [n('a', 5, 5)]
    expect(tidyCanvas(single, [])).toBe(single)
    const plain = plainTidy([n('a', 300, 0), n('b', 0, 0), n('c', 0, 300)])
    expect(tidyCanvas(plain, [])).toBe(plain)
  })
})

describe('lineageLayers slots siblings under their OPENER first', () => {
  it('places a node opened by B under B even when it also waits on A', () => {
    // o opened a and b; d was opened by a; c was opened by b but waits on a. c reads before d.
    const nodes = [n('o', 0, 0), n('a', 0, 200), n('b', 300, 200), n('c', 0, 400), n('d', 300, 400)]
    const { layers } = lineageLayers(nodes, [opens('o', 'a'), opens('o', 'b'), opens('a', 'd'), opens('b', 'c'), waits('a', 'c')])
    expect(layers).toEqual([['o'], ['a', 'b'], ['d', 'c']])
  })
})

// ── Cross layout ────────────────────────────────────────────────────────────────────────────────
// Ids carry the opening time the way `nextId` mints them: `term-<Date.now() base36>-<hex token>`.
const tid = (i: number) => `term-${(1.8e12 + i * 1000).toString(36)}-abcd1234`
const A = tid(1), B = tid(2), C = tid(3), D = tid(4), E = tid(5), F = tid(6)
const posOf = (out: CanvasNode[], id: string) => out.find((x) => x.id === id)!.position
const rect = (nd: CanvasNode) => ({ x: nd.position.x, y: nd.position.y, w: nd.width as number, h: nd.height as number })
const overlaps = (p: ReturnType<typeof rect>, q: ReturnType<typeof rect>) =>
  p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h
const expectNoOverlap = (out: CanvasNode[], ids: string[]) => {
  const rs = ids.map((id) => rect(out.find((x) => x.id === id)!))
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) expect(overlaps(rs[i], rs[j])).toBe(false)
}

describe('crossLayout', () => {
  it('the cap is five units', () => {
    expect(CROSS_MAX_UNITS).toBe(5)
  })

  it('orders units by the timestamp in the id, not by array position', () => {
    const nodes = [n(D, 0, 0), n(B, 0, 0), n(E, 0, 0), n(A, 0, 0), n(C, 0, 0)]
    expect(crossUnits(nodes).map((u) => u.id)).toEqual([A, B, C, D, E])
  })

  it('ids without a timestamp sort after stamped ones, by array order', () => {
    const nodes = [n('zeta', 0, 0), n(B, 0, 0), n('alpha', 0, 0), n(A, 0, 0)]
    expect(crossUnits(nodes).map((u) => u.id)).toEqual([A, B, 'zeta', 'alpha'])
    // and they land in the row after the stamped ones
    const out = crossLayout(nodes, { gap: 10 })
    const a = posOf(out, A)
    expect(posOf(out, B)).toEqual({ x: a.x + 110, y: a.y })
    expect(posOf(out, 'zeta')).toEqual({ x: a.x + 220, y: a.y })
    expect(posOf(out, 'alpha')).toEqual({ x: posOf(out, B).x, y: a.y - 10 - 50 }) // 4th → on top
  })

  it('n=1 is a no-op (same array)', () => {
    const nodes = [n(A, 30, 40)]
    expect(crossLayout(nodes)).toBe(nodes)
    expect(tidyCanvasCross(nodes)).toBe(nodes)
  })

  it('n=2: A B in a row at A, default gap 40', () => {
    const out = crossLayout([n(B, 999, -300), n(A, 100, 200)])
    expect(posOf(out, A)).toEqual({ x: 100, y: 200 })
    expect(posOf(out, B)).toEqual({ x: 240, y: 200 })
  })

  it('n=3: A B C in a row', () => {
    const out = crossLayout([n(C, 5, 5), n(A, 100, 200), n(B, -50, 900)])
    expect(posOf(out, A)).toEqual({ x: 100, y: 200 })
    expect(posOf(out, B)).toEqual({ x: 240, y: 200 })
    expect(posOf(out, C)).toEqual({ x: 380, y: 200 })
  })

  it('n=4: D centred over B, one gap above the row', () => {
    const out = crossLayout([n(D, 0, 0), n(C, 5, 5), n(A, 100, 200), n(B, -50, 900)])
    expect(posOf(out, A)).toEqual({ x: 100, y: 200 })
    expect(posOf(out, B)).toEqual({ x: 240, y: 200 })
    expect(posOf(out, C)).toEqual({ x: 380, y: 200 })
    expect(posOf(out, D)).toEqual({ x: 240, y: 200 - 40 - 50 })
    expectNoOverlap(out, [A, B, C, D])
  })

  it('n=5: E centred under B, one gap below the row', () => {
    const out = crossLayout([n(E, 7, 7), n(D, 0, 0), n(C, 5, 5), n(A, 100, 200), n(B, -50, 900)])
    expect(posOf(out, D)).toEqual({ x: 240, y: 110 })
    expect(posOf(out, E)).toEqual({ x: 240, y: 200 + 50 + 40 })
    expectNoOverlap(out, [A, B, C, D, E])
  })

  it('respects opts.gap', () => {
    const out = crossLayout([n(A, 0, 0), n(B, 0, 0), n(C, 0, 0), n(D, 0, 0), n(E, 0, 0)], { gap: 10 })
    expect(posOf(out, B)).toEqual({ x: 110, y: 0 })
    expect(posOf(out, C)).toEqual({ x: 220, y: 0 })
    expect(posOf(out, D)).toEqual({ x: 110, y: -60 })
    expect(posOf(out, E)).toEqual({ x: 110, y: 60 })
  })

  it('unequal sizes: row top-aligned, D/E centred on B, E below the TALLEST row node', () => {
    const nodes = [
      n(E, 0, 0, 60, 30),
      n(C, 0, 0, 80, 300), // tallest in the row
      n(A, 0, 0, 200, 100),
      n(D, 0, 0, 400, 70), // wider than B
      n(B, 0, 0, 120, 150)
    ]
    const out = crossLayout(nodes, { gap: 20 })
    expect(posOf(out, A)).toEqual({ x: 0, y: 0 })
    expect(posOf(out, B)).toEqual({ x: 220, y: 0 })
    expect(posOf(out, C)).toEqual({ x: 360, y: 0 })
    expect(posOf(out, D)).toEqual({ x: 220 + (120 - 400) / 2, y: -20 - 70 })
    expect(posOf(out, E)).toEqual({ x: 220 + (120 - 60) / 2, y: 300 + 20 })
    expectNoOverlap(out, [A, B, C, D, E])
  })

  it('anchor A stays put even when it is not the top-left node', () => {
    const nodes = [n(B, -500, -500), n(C, -900, 0), n(A, 600, 400), n(D, 0, -1000)]
    const out = crossLayout(nodes)
    expect(posOf(out, A)).toEqual({ x: 600, y: 400 })
    expect(out.find((x) => x.id === A)).toBe(nodes[2]) // not even copied
    expect(posOf(out, B)).toEqual({ x: 740, y: 400 })
    expect(posOf(out, C)).toEqual({ x: 880, y: 400 })
    expect(posOf(out, D)).toEqual({ x: 740, y: 310 })
  })

  it('closing B re-flows A, C, D — the same picture as a fresh A, C, D', () => {
    const laid = crossLayout([n(A, 0, 0), n(B, 0, 0), n(C, 0, 0), n(D, 0, 0)])
    expect(posOf(laid, D)).toEqual({ x: 140, y: -90 }) // D on top of B while there are four
    const afterClose = crossLayout(laid.filter((x) => x.id !== B))
    // Three units are a row (1–3: A B C), so D drops into the row's third slot.
    expect(posOf(afterClose, A)).toEqual({ x: 0, y: 0 })
    expect(posOf(afterClose, C)).toEqual({ x: 140, y: 0 })
    expect(posOf(afterClose, D)).toEqual({ x: 280, y: 0 })
    const fresh = crossLayout([n(D, 77, 77), n(C, -3, 9), n(A, 0, 0)])
    for (const id of [A, C, D]) expect(posOf(afterClose, id)).toEqual(posOf(fresh, id))
    expectNoOverlap(afterClose, [A, C, D])
  })

  it('is idempotent: a second call returns the SAME array', () => {
    for (const ids of [[A, B], [A, B, C], [A, B, C, D], [A, B, C, D, E]]) {
      const once = crossLayout(ids.map((id, i) => n(id, i * 13, -i * 7)))
      expect(crossLayout(once)).toBe(once)
      expect(tidyCanvasCross(once)).toBe(once)
    }
  })

  it('returns untouched nodes by reference', () => {
    const nodes = [n(A, 0, 0), n(B, 140, 0), n(C, 9, 9)]
    const out = crossLayout(nodes)
    expect(out).not.toBe(nodes)
    expect(out[0]).toBe(nodes[0])
    expect(out[1]).toBe(nodes[1])
    expect(out[2]).not.toBe(nodes[2])
  })

  it('ignores subagent/loop cards and grouped children', () => {
    const sub = { ...n(tid(0), 3, 3), type: 'subagent' } as CanvasNode // older than A
    const loop = { ...n('loop-x', 4, 4), type: 'loop' } as CanvasNode
    const frame = { ...n(B, 500, 500, 300, 200), type: 'group' } as CanvasNode
    const kid = { ...n(tid(-5), 20, 60), parentId: B } as CanvasNode // older than A, but grouped
    const nodes = [sub, kid, frame, loop, n(C, 1, 1), n(A, 0, 0)]
    expect(crossUnits(nodes).map((u) => u.id)).toEqual([A, B, C])
    const out = crossLayout(nodes)
    expect(out.find((x) => x.id === sub.id)).toBe(sub)
    expect(out.find((x) => x.id === loop.id)).toBe(loop)
    expect(out.find((x) => x.id === kid.id)).toBe(kid)
    expect(posOf(out, A)).toEqual({ x: 0, y: 0 })
    expect(posOf(out, B)).toEqual({ x: 140, y: 0 })
    expect(posOf(out, C)).toEqual({ x: 480, y: 0 })
  })

  it('n=6 is out of range: same array', () => {
    const nodes = [A, B, C, D, E, F].map((id, i) => n(id, i * 300, 0))
    expect(crossLayout(nodes)).toBe(nodes)
  })
})

describe('tidyCanvasCross', () => {
  it('uses the cross for five units or fewer', () => {
    const nodes = [n(E, 0, 0), n(D, 0, 0), n(C, 0, 0), n(B, 0, 0), n(A, 10, 20)]
    expect(tidyCanvasCross(nodes)).toEqual(crossLayout(nodes))
  })

  it('falls back to the stock tidyCanvas above five units', () => {
    const nodes = [F, E, D, C, B, A].map((id, i) => n(id, (i % 3) * 400 + 7, Math.floor(i / 3) * 300 + 3))
    expect(tidyCanvasCross(nodes)).toEqual(tidyCanvas(nodes))
    expect(tidyCanvasCross(nodes)).not.toBe(nodes) // the fallback actually moved something
  })

  it('counts subagent cards out when choosing (5 units + a card = cross)', () => {
    const sub = { ...n('sub-x', 0, 0), type: 'subagent' } as CanvasNode
    const nodes = [sub, n(A, 0, 0), n(B, 0, 0), n(C, 0, 0), n(D, 0, 0), n(E, 0, 0)]
    expect(tidyCanvasCross(nodes)).toEqual(crossLayout(nodes))
  })
})
