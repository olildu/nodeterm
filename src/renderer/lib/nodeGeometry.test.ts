import { describe, it, expect } from 'vitest'
import { geometryText, liveNodeGeometry, storedNodeGeometry } from './nodeGeometry'
import { COLLAPSED_HEIGHT } from './nodeSizing'

const live = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  position: { x: 0, y: 0 },
  data: {},
  ...extra
})

describe('liveNodeGeometry', () => {
  it('reports the MEASURED size first — what is on screen — then the persisted one', () => {
    const measured = live('a', { width: 600, height: 400, measured: { width: 612.4, height: 398.6 } })
    expect(liveNodeGeometry(measured, [measured])).toMatchObject({ width: 612, height: 399 })
    const fresh = live('b', { width: 600, height: 400 })
    expect(liveNodeGeometry(fresh, [fresh])).toMatchObject({ width: 600, height: 400 })
    const styleOnly = live('c', { style: { width: 300, height: 200 } })
    expect(liveNodeGeometry(styleOnly, [styleOnly])).toMatchObject({ width: 300, height: 200 })
  })

  it('adds every ancestor frame origin: x/y are canvas coordinates, the numbers `place` takes', () => {
    const outer = live('o', { position: { x: 100, y: 200 } })
    const inner = live('i', { position: { x: 10, y: 20 }, parentId: 'o' })
    const a = live('a', { position: { x: 1.4, y: -2.6 }, parentId: 'i', width: 50, height: 50 })
    expect(liveNodeGeometry(a, [outer, inner, a])).toEqual({ x: 111, y: 217, width: 50, height: 50, parent: 'i' })
  })

  it('a collapsed node reports its header bar and the height it opens to', () => {
    const a = live('a', { width: 600, height: COLLAPSED_HEIGHT, data: { collapsed: true, expandedHeight: 400 } })
    expect(liveNodeGeometry(a, [a])).toEqual({
      x: 0, y: 0, width: 600, height: COLLAPSED_HEIGHT, parent: null, collapsed: true, expandedHeight: 400
    })
  })
})

describe('storedNodeGeometry', () => {
  it('reads the persisted size; a collapsed node persists the height it EXPANDS to', () => {
    const f = { id: 'f', position: { x: 5, y: 5 }, size: { width: 900, height: 700 } }
    const a = { id: 'a', position: { x: 10, y: 10 }, size: { width: 600, height: 400 }, parentId: 'f', collapsed: true }
    expect(storedNodeGeometry(a, [f, a])).toEqual({
      x: 15, y: 15, width: 600, height: COLLAPSED_HEIGHT, parent: 'f', collapsed: true, expandedHeight: 400
    })
  })

  it('never throws on a self-parented node (hand-edited project.json)', () => {
    const a = { id: 'a', position: { x: 10, y: 10 }, size: { width: 600, height: 400 }, parentId: 'a' }
    expect(storedNodeGeometry(a, [a])).toMatchObject({ x: 10, y: 10 })
  })
})

describe('geometryText', () => {
  it('is the `list --geometry on` suffix', () => {
    expect(geometryText({ x: 0, y: -40, width: 540, height: 480, parent: null })).toBe(' @ 0,-40 540×480')
    expect(geometryText({ x: 1, y: 2, width: 3, height: 40, parent: 'g', collapsed: true, expandedHeight: 9 })).toBe(
      ' @ 1,2 3×40 in g collapsed (expands to 9)'
    )
  })
})
