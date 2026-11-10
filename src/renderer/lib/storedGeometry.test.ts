import { describe, it, expect } from 'vitest'
import type { CanvasNodeState } from '@shared/types'
import {
  applyOwnCanvasMutation,
  arrangeNodes,
  groupSelectedNodes,
  nodeStatesToFlow,
  placeNodes,
  resizeNodes,
  ungroupNodes
} from '../state/workspace'
import { groupsFirst } from '@shared/node-order'
import { geometryMutations } from './storedGeometry'

const term = (id: string, x: number, extra: Partial<CanvasNodeState> = {}): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    position: { x, y: 0 },
    size: { width: 600, height: 400 },
    title: id,
    color: '#0a84ff',
    group: null,
    tags: [],
    collapsed: false,
    ...extra
  }) as CanvasNodeState

// The stored project, as the store holds it: one node carries a held launch the serializers must
// never be trusted to round-trip.
const stored: CanvasNodeState[] = [
  term('a', 0, { pendingLaunch: { after: [], command: 'claude' } } as Partial<CanvasNodeState>),
  term('b', 700),
  term('c', 1400)
]

const apply = (nodes: CanvasNodeState[], ms: ReturnType<typeof geometryMutations>) =>
  groupsFirst(ms.reduce(applyOwnCanvasMutation, nodes))

describe('geometryMutations — a structural verb run off screen', () => {
  it('groups from persisted sizes: a new frame, children re-parented, nothing else rewritten', () => {
    const next = groupSelectedNodes(nodeStatesToFlow(stored), ['a', 'b'], 0, 0)
    const ms = geometryMutations(stored, next)
    const after = apply(stored, ms)
    const frame = after.find((n) => n.kind === 'group')!
    expect(frame).toBeTruthy()
    expect(after[0].id).toBe(frame.id) // parents first
    expect(after.find((n) => n.id === 'a')!.parentId).toBe(frame.id)
    expect(after.find((n) => n.id === 'b')!.parentId).toBe(frame.id)
    // The frame wraps both 600-wide nodes laid out from their persisted size.
    expect(frame.size.width).toBeGreaterThanOrEqual(1300)
    // The untouched node is not rewritten, and the held launch survives on the moved one.
    expect(ms.some((m) => m.op === 'upsert' && m.node.id === 'c')).toBe(false)
    expect(after.find((n) => n.id === 'a')!.pendingLaunch).toEqual({ after: [], command: 'claude' })
  })

  it('ungroup removes only the frame and frees its children', () => {
    const grouped = apply(stored, geometryMutations(stored, groupSelectedNodes(nodeStatesToFlow(stored), ['a', 'b'], 0, 0)))
    const frameId = grouped.find((n) => n.kind === 'group')!.id
    const ms = geometryMutations(grouped, ungroupNodes(nodeStatesToFlow(grouped), frameId))
    const after = apply(grouped, ms)
    expect(after.map((n) => n.id).sort()).toEqual(['a', 'b', 'c'])
    expect(after.every((n) => n.parentId === undefined)).toBe(true)
    expect(ms.filter((m) => m.op === 'remove')).toEqual([{ op: 'remove', id: frameId }])
  })

  it('never removes a non-frame the hydration did not return', () => {
    const ms = geometryMutations(stored, nodeStatesToFlow(stored.slice(0, 2)))
    expect(ms).toEqual([])
  })

  // Issue #1288: `resize` / `place` run off screen through the same write. Their whole effect is
  // geometry, so the patch must carry it and nothing else.
  it('resize writes the new persisted size, and leaves every other stored field alone', () => {
    const out = resizeNodes(nodeStatesToFlow(stored), ['a', 'b'], { width: 540, height: 480 })
    if (!out.ok) throw new Error(out.error)
    const after = apply(stored, geometryMutations(stored, out.nodes))
    expect(after.find((n) => n.id === 'a')!.size).toEqual({ width: 540, height: 480 })
    expect(after.find((n) => n.id === 'b')!.size).toEqual({ width: 540, height: 480 })
    expect(after.find((n) => n.id === 'c')!.size).toEqual({ width: 600, height: 400 })
    expect(after.find((n) => n.id === 'a')!.pendingLaunch).toEqual({ after: [], command: 'claude' })
  })

  it('a collapsed stored node keeps collapsed, and stores the height it will expand to', () => {
    const folded = [term('f', 0, { collapsed: true })]
    const out = resizeNodes(nodeStatesToFlow(folded), ['f'], { height: 500 })
    if (!out.ok) throw new Error(out.error)
    const [f] = apply(folded, geometryMutations(folded, out.nodes))
    expect(f.collapsed).toBe(true)
    expect(f.size).toEqual({ width: 600, height: 500 })
  })

  it('place writes the position; a maximized stored node loses its restore rect (premaxRect is geometry)', () => {
    const premaxRect = { x: 50, y: 60, width: 600, height: 400 }
    const maxed = [term('m', 0, { premaxRect, size: { width: 1900, height: 1000 } } as Partial<CanvasNodeState>), term('o', 2000)]
    const out = placeNodes(nodeStatesToFlow(maxed), ['m'], { x: 10, y: 20 })
    if (!out.ok) throw new Error(out.error)
    const [m] = apply(maxed, geometryMutations(maxed, out.nodes))
    expect(m.position).toEqual({ x: 10, y: 20 })
    expect(m.size).toEqual({ width: 600, height: 400 })
    expect(m.premaxRect).toBeUndefined()
  })

  it('an arrange over a maximized stored node clears its restore rect too (it was left behind before)', () => {
    const premaxRect = { x: 50, y: 60, width: 600, height: 400 }
    const maxed = [term('m', 0, { premaxRect, size: { width: 1900, height: 1000 } } as Partial<CanvasNodeState>), term('o', 2000)]
    const next = arrangeNodes(nodeStatesToFlow(maxed), ['m', 'o'], { layout: 'row', gap: 0 })
    const [m] = apply(maxed, geometryMutations(maxed, next))
    expect(m.premaxRect).toBeUndefined()
  })
})

