import { describe, expect, it } from 'vitest'
import { errorText } from './error-text'

describe('errorText', () => {
  it("returns an Error's message", () => {
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText(new TypeError('bad type'))).toBe('bad type')
  })

  it('stringifies anything else', () => {
    expect(errorText('plain')).toBe('plain')
    expect(errorText(42)).toBe('42')
    expect(errorText(undefined)).toBe('undefined')
    expect(errorText({ message: 'not an Error' })).toBe('[object Object]')
  })
})
