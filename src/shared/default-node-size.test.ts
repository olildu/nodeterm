import { describe, expect, it } from 'vitest'
import {
  NODE_SIZE_MAX,
  SIZABLE_NODE_KINDS,
  resolveDefaultNodeSize,
  type SizableNodeKind
} from './default-node-size'

const BUILTIN = { width: 240, height: 200 }
const MIN = { width: 160, height: 120 }

describe('resolveDefaultNodeSize', () => {
  it('answers the built-in size when the user never set one', () => {
    expect(resolveDefaultNodeSize(undefined, BUILTIN, MIN)).toEqual(BUILTIN)
    expect(resolveDefaultNodeSize({}, BUILTIN, MIN)).toEqual(BUILTIN)
  })

  it('answers the stored size, rounded', () => {
    expect(resolveDefaultNodeSize({ width: 401.4, height: 299.6 }, BUILTIN, MIN)).toEqual({
      width: 401,
      height: 300
    })
  })

  it('clamps to the kind minimum, so a hand-edited 0×0 never makes an ungrabbable node', () => {
    expect(resolveDefaultNodeSize({ width: 0, height: -5 }, BUILTIN, MIN)).toEqual(MIN)
  })

  it('clamps to the canvas maximum', () => {
    expect(resolveDefaultNodeSize({ width: 99999, height: 99999 }, BUILTIN, MIN)).toEqual(NODE_SIZE_MAX)
  })

  it('falls back per axis on garbage, keeping the half that is valid', () => {
    expect(resolveDefaultNodeSize({ width: 'wide', height: 300 }, BUILTIN, MIN)).toEqual({
      width: BUILTIN.width,
      height: 300
    })
    expect(resolveDefaultNodeSize({ width: 500, height: Number.NaN }, BUILTIN, MIN)).toEqual({
      width: 500,
      height: BUILTIN.height
    })
    expect(resolveDefaultNodeSize('600x400', BUILTIN, MIN)).toEqual(BUILTIN)
    expect(resolveDefaultNodeSize(null, BUILTIN, MIN)).toEqual(BUILTIN)
  })
})

describe('SIZABLE_NODE_KINDS', () => {
  it('excludes the kinds whose size is not a user default', () => {
    // terminal/agent keep their own long-standing defaultNodeWidth/Height pair; group frames are
    // sized to what they hold; subagent/loop cards are ephemeral and laid out by the canvas.
    const excluded = ['terminal', 'group', 'subagent', 'loop']
    for (const k of excluded) expect(SIZABLE_NODE_KINDS).not.toContain(k as SizableNodeKind)
  })

  it('lists each kind once', () => {
    expect(new Set(SIZABLE_NODE_KINDS).size).toBe(SIZABLE_NODE_KINDS.length)
  })
})
