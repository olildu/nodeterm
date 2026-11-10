import { describe, expect, it } from 'vitest'
import { CONTROL_LOCK_MAX_MS, readControlEvent, readTypingNames, isWatchEndReason, TYPING_NAMES_MAX } from './protocol'

describe('control protocol readers', () => {
  it('accepts only known states and reasons', () => {
    expect(readControlEvent({ state: 'controlling' })).toEqual({ state: 'controlling' })
    expect(readControlEvent({ state: 'available', reason: 'wrong' })).toEqual({ state: 'available', reason: 'wrong' })
    expect(readControlEvent({ state: 'god' })).toBeNull()
    expect(readControlEvent({ state: 'off', reason: 'nope' })).toEqual({ state: 'off' })
    expect(readControlEvent(null)).toBeNull()
  })
  it('sanitizes and bounds typing names', () => {
    const many = Array.from({ length: 30 }, (_, i) => `n${i}`)
    expect(readTypingNames({ names: many })).toHaveLength(TYPING_NAMES_MAX)
    expect(readTypingNames({ names: ['a\u202eb', 'a\u202eb', 7, '  '] })).toEqual(['ab'])
    expect(readTypingNames('x')).toEqual([])
  })
  it('keeps how long a lock lasts only beside `locked`, and only a duration a host can mean', () => {
    expect(readControlEvent({ state: 'locked', reason: 'locked', lockedForMs: 900_000 })).toEqual({ state: 'locked', reason: 'locked', lockedForMs: 900_000 })
    expect(readControlEvent({ state: 'locked', lockedForMs: 0 })).toEqual({ state: 'locked', lockedForMs: 0 })
    expect(readControlEvent({ state: 'locked', lockedForMs: CONTROL_LOCK_MAX_MS })).toEqual({ state: 'locked', lockedForMs: CONTROL_LOCK_MAX_MS })
    // Past the cap, negative, fractional, not a number: "until the sharer lifts it" — never a promise.
    for (const lockedForMs of [CONTROL_LOCK_MAX_MS + 1, -1, 1.5, '900000', Number.NaN, Infinity, null]) {
      expect(readControlEvent({ state: 'locked', lockedForMs })).toEqual({ state: 'locked' })
    }
    // Beside any other state it means nothing.
    expect(readControlEvent({ state: 'available', lockedForMs: 1000 })).toEqual({ state: 'available' })
  })
  it('knows the new end reason', () => {
    expect(isWatchEndReason('attempts')).toBe(true)
  })
})
