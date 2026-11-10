import { describe, it, expect } from 'vitest'
import { placeReply, resizeReply } from './geometryReply'

describe('resizeReply', () => {
  it('says what was APPLIED — clamped, collapsed and restored nodes each say so', () => {
    const { message, result } = resizeReply(
      {
        applied: [
          { id: 'a', width: 540, height: 480, clamped: false, collapsed: false, restored: false },
          { id: 'b', width: 260, height: 480, clamped: true, collapsed: false, restored: false },
          { id: 'c', width: 540, height: 480, clamped: false, collapsed: true, restored: true }
        ],
        unknown: ['ghost']
      },
      true
    )
    expect(message).toBe(
      'resized 3 node(s): a 540×480, b 260×480 (clamped to what this kind of node allows), ' +
        'c 540×480 (collapsed: the width applies now, the height when it is expanded; was maximized: restored first)' +
        ' (1 unknown id(s) skipped: ghost)'
    )
    expect(result).toMatchObject({ changed: true, unknown: ['ghost'] })
    expect((result.resized as unknown[])[1]).toMatchObject({ id: 'b', width: 260, clamped: true })
  })

  it('an unchanged call is an answer, not a failure', () => {
    const { message, result } = resizeReply(
      { applied: [{ id: 'a', width: 540.2, height: 480, clamped: false, collapsed: false, restored: false }], unknown: [] },
      false
    )
    expect(message).toBe('already that size — nothing changed: a 540×480')
    expect(result).toMatchObject({ changed: false, resized: [{ width: 540 }] })
  })
})

describe('placeReply', () => {
  const placed = [
    { id: 'a', x: 0, y: 0, restored: false },
    { id: 'b', x: 540.4, y: 0, restored: true }
  ]

  it('names the form: one node, a block, or an offset', () => {
    expect(placeReply({ placed: placed.slice(0, 1), unknown: [], carried: [] }, { x: 0, y: 0 }, true).message).toBe(
      'placed 1 node(s): a at 0,0'
    )
    expect(placeReply({ placed, unknown: [], carried: ['k'] }, { x: 0, y: 0 }, true).message).toBe(
      'placed 2 node(s) as one block: a at 0,0, b at 540,0 (was maximized: restored first) (k moved with the frame that holds it)'
    )
    expect(placeReply({ placed, unknown: ['z'], carried: [] }, { dx: 8 }, true).message).toBe(
      'moved 2 node(s) by 8,0: a at 0,0, b at 540,0 (was maximized: restored first) (1 unknown id(s) skipped: z)'
    )
  })

  it('an unchanged call says nothing moved, and the result carries whole-px positions', () => {
    const { message, result } = placeReply({ placed: placed.slice(0, 1), unknown: [], carried: [] }, { x: 0 }, false)
    expect(message).toBe('already there — nothing moved: a at 0,0')
    expect(result).toEqual({ placed: [{ id: 'a', x: 0, y: 0, restored: false }], carried: [], unknown: [], changed: false })
  })
})
