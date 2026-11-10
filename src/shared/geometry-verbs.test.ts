import { describe, it, expect } from 'vitest'
import { NODE_SIZE_MAX } from './default-node-size'
import {
  LIST_GEOMETRY_VALUES,
  PLACE_COORD_MAX,
  geometryArgsRefusal,
  geometryGuidanceLines,
  moveArgsRefusal,
  listGeometryRequested,
  parseListGeometry,
  parsePlaceArgs,
  parseResizeArgs
} from './geometry-verbs'

describe('resize: the flag shape', () => {
  it('reads --nodes and one axis or both', () => {
    expect(parseResizeArgs({ nodes: 'a, b,', width: '540' })).toEqual({ ids: ['a', 'b'], width: 540 })
    expect(parseResizeArgs({ nodes: 'a', height: '480' })).toEqual({ ids: ['a'], height: 480 })
    expect(parseResizeArgs({ nodes: 'a', width: '540', height: '480' })).toEqual({ ids: ['a'], width: 540, height: 480 })
  })

  it('does NOT range-check the size — the canvas clamps it to the kind and reports it', () => {
    // A value above the canvas maximum is a size the transform holds to NODE_SIZE_MAX and SAYS so.
    expect(parseResizeArgs({ nodes: 'a', width: String(NODE_SIZE_MAX.width * 10) })).toEqual({
      ids: ['a'],
      width: NODE_SIZE_MAX.width * 10
    })
  })

  it('refuses what no canvas could act on', () => {
    expect(parseResizeArgs({ width: '10' })).toEqual({ error: 'resize requires --nodes <id,id>' })
    expect(parseResizeArgs({ nodes: ' , ' , width: '10' })).toEqual({ error: 'resize requires --nodes <id,id>' })
    expect(parseResizeArgs({ nodes: 'a' })).toEqual({ error: 'resize requires --width <px>, --height <px>, or both' })
    for (const raw of ['0', '-5', '1.5', '', 'wide', '1e3', '99999999999999999999']) {
      expect(parseResizeArgs({ nodes: 'a', width: raw }), raw).toEqual({
        error: `resize: --width must be a whole number of pixels above 0 (got "${raw}")`
      })
    }
  })

  it('refuses an unknown flag by name — a dropped `--heigth` would read as success', () => {
    expect(parseResizeArgs({ nodes: 'a', width: '500', heigth: '400' })).toEqual({ error: 'resize: unknown flag --heigth' })
    // The spelling the issue used, answered with the one that works.
    expect(parseResizeArgs({ node: 'a', width: '500' })).toEqual({
      error: 'resize: takes --nodes <id,id> (plural, like arrange and move), not --node'
    })
  })
})

describe('place: the flag shape', () => {
  it('reads absolute (one axis or both) or relative coordinates, negatives included', () => {
    expect(parsePlaceArgs({ nodes: 'a', x: '0', y: '-120' })).toEqual({ ids: ['a'], x: 0, y: -120 })
    expect(parsePlaceArgs({ nodes: 'a', x: '40' })).toEqual({ ids: ['a'], x: 40 })
    expect(parsePlaceArgs({ nodes: 'a,b', dx: '-8', dy: '16' })).toEqual({ ids: ['a', 'b'], dx: -8, dy: 16 })
    // A typed "-0" is 0, not a -0 that would ride out to project.json.
    expect(Object.is((parsePlaceArgs({ nodes: 'a', x: '-0' }) as { x: number }).x, 0)).toBe(true)
  })

  it('refuses mixing where with how-far, and a call naming neither', () => {
    expect(parsePlaceArgs({ nodes: 'a', x: '1', dy: '2' })).toEqual({
      error: 'place takes --x/--y (where) or --dx/--dy (how far), not both'
    })
    expect(parsePlaceArgs({ nodes: 'a' })).toMatchObject({ error: expect.stringMatching(/^place requires --x\/--y/) })
    expect(parsePlaceArgs({ x: '1' })).toEqual({ error: 'place requires --nodes <id,id>' })
  })

  it('refuses a coordinate that is not a whole number, or beyond the bound, by name', () => {
    for (const raw of ['1.5', '', '1e3', 'left', '--3']) {
      expect(parsePlaceArgs({ nodes: 'a', x: raw }), raw).toEqual({
        error: `place: --x must be a whole number of pixels (got "${raw}")`
      })
    }
    expect(parsePlaceArgs({ nodes: 'a', dy: String(-(PLACE_COORD_MAX + 1)) })).toEqual({
      error: `place: --dy ${-(PLACE_COORD_MAX + 1)} is beyond ±${PLACE_COORD_MAX} px — nothing was placed`
    })
    expect(parsePlaceArgs({ nodes: 'a', x: String(PLACE_COORD_MAX) })).toEqual({ ids: ['a'], x: PLACE_COORD_MAX })
  })

  it('refuses an unknown flag by name', () => {
    expect(parsePlaceArgs({ nodes: 'a', x: '1', group: 'g1' })).toEqual({ error: 'place: unknown flag --group' })
    expect(parsePlaceArgs({ node: 'a', x: '1' })).toMatchObject({ error: expect.stringContaining('not --node') })
  })
})

describe('list --geometry', () => {
  it('takes on or off, and is off when absent', () => {
    expect(parseListGeometry({})).toEqual({ geometry: false })
    expect(parseListGeometry({ geometry: 'on' })).toEqual({ geometry: true })
    expect(parseListGeometry({ geometry: ' OFF ' })).toEqual({ geometry: false })
  })

  it('refuses a valueless flag rather than guessing: every flag takes a value (the SSH shim-loop rule)', () => {
    expect(parseListGeometry({ geometry: '' })).toEqual({ error: 'list: --geometry takes on or off (got "")' })
    expect(parseListGeometry({ geometry: 'yes' })).toEqual({ error: 'list: --geometry takes on or off (got "yes")' })
  })

  it('listGeometryRequested is true only for on', () => {
    expect(listGeometryRequested({ geometry: 'on' })).toBe(true)
    expect(listGeometryRequested({ geometry: 'off' })).toBe(false)
    expect(listGeometryRequested({})).toBe(false)
  })
})

describe('move refuses coordinates and sizes', () => {
  // The issue proposed `move --node <id> --x <n> --y <n>`. Without `--group`, `move` means "out of
  // every frame": that call would pull a framed node to the top level and ignore the `--x`, and
  // answer ok. The transform half of that is pinned in workspace.geometry.test.ts.
  it('names the verb that does what was asked', () => {
    expect(moveArgsRefusal({ nodes: 'a' })).toBeNull()
    expect(moveArgsRefusal({ nodes: 'a', group: 'g1' })).toBeNull()
    for (const flag of ['x', 'y', 'dx', 'dy']) {
      const r = moveArgsRefusal({ nodes: 'a', [flag]: '10' })
      expect(r, flag).toContain(`move: --${flag} is not a move flag`)
      expect(r, flag).toContain('takes it OUT of its frame')
      expect(r, flag).toContain(`place --nodes <id> --${flag} <n>`)
    }
    expect(moveArgsRefusal({ nodes: 'a', width: '10' })).toContain('resize --nodes <id> --width <px>')
  })
})

describe('geometryArgsRefusal: one gate per verb', () => {
  it('routes each verb to its own parser and leaves the rest alone', () => {
    expect(geometryArgsRefusal('resize', { nodes: 'a' })).toMatch(/^resize requires --width/)
    expect(geometryArgsRefusal('place', { nodes: 'a' })).toMatch(/^place requires/)
    expect(geometryArgsRefusal('list', { geometry: 'maybe' })).toMatch(/^list: --geometry/)
    expect(geometryArgsRefusal('move', { nodes: 'a', x: '1' })).toMatch(/^move: --x/)
    expect(geometryArgsRefusal('list', {})).toBeNull()
    expect(geometryArgsRefusal('resize', { nodes: 'a', width: '300' })).toBeNull()
    // Not its verbs: `arrange --gap` is `arrangeArgsRefusal`'s, and `open-terminal` has no width.
    expect(geometryArgsRefusal('arrange', { nodes: 'a', gap: '-1' })).toBeNull()
    expect(geometryArgsRefusal('open-terminal', { width: 'x' })).toBeNull()
  })
})

describe('geometryGuidanceLines', () => {
  const text = geometryGuidanceLines().join('\n')

  it('renders every number from the constant the code checks', () => {
    expect(text).toContain(`${NODE_SIZE_MAX.width}×${NODE_SIZE_MAX.height}`)
    expect(text).toContain(`within ±${PLACE_COORD_MAX}`)
    expect(text).toContain(`list --geometry ${LIST_GEOMETRY_VALUES.join('|')}`)
  })

  it('states the contract an agent builds a layout on', () => {
    expect(text).toContain('resize --nodes <id,id> [--width <px>] [--height <px>]')
    expect(text).toContain('place --nodes <id> --x <n> --y <n>')
    expect(text).toContain('place --nodes <id,id> --dx <n> --dy <n>')
    expect(text).toMatch(/JSON result rows ALWAYS carry `x`, `y`, `width`, `height`\s+and `parent`/)
    expect(text).toMatch(/group frame\s+is refused/)
    expect(text).toMatch(/COLLAPSED node keeps its header-only look/)
    expect(text).toMatch(/MAXIMIZED node is restored first/)
    expect(text).toMatch(/framed node STAYS in its frame/)
    expect(text).toMatch(/move as ONE block/)
    expect(text).toMatch(/`move` takes none of these flags/)
  })

  it('carries the worked example the issue needs: two tight columns of four', () => {
    expect(text).toContain('resize --nodes a,b,c,d,e,f,g,h --width 540 --height 480')
    expect(text).toContain('arrange --nodes a,e,b,f,c,g,d,h --layout grid --cols 2 --gap 0')
    expect(text).toContain('place --nodes a,b,c,d,e,f,g,h --x 0 --y 0')
    // Every call in it passes its own gate.
    expect(geometryArgsRefusal('resize', { nodes: 'a,b,c,d,e,f,g,h', width: '540', height: '480' })).toBeNull()
    expect(geometryArgsRefusal('place', { nodes: 'a,b,c,d,e,f,g,h', x: '0', y: '0' })).toBeNull()
    expect(geometryArgsRefusal('list', { geometry: 'on' })).toBeNull()
  })
})
