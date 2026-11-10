import { describe, expect, it } from 'vitest'
import { isRecord } from './is-record'

describe('isRecord', () => {
  it('accepts plain objects, including empty and null-prototype ones', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord(Object.create(null))).toBe(true)
  })

  it('rejects null, arrays and primitives', () => {
    for (const value of [null, undefined, [], [1], 0, 1, '', 'x', true, false, Symbol('s'), 1n]) {
      expect(isRecord(value), String(value)).toBe(false)
    }
  })
})
