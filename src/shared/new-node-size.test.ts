import { describe, it, expect } from 'vitest'
import { largestTerminalSize, resolveNewNodeSize } from './new-node-size'

const t = (width: number, height: number) => ({ kind: 'terminal' as const, size: { width, height } })

describe('resolveNewNodeSize', () => {
  it('only the literal matchLargest turns it on', () => {
    expect(resolveNewNodeSize('matchLargest')).toBe('matchLargest')
    for (const v of [undefined, null, 'default', 'MatchLargest', 1, true]) {
      expect(resolveNewNodeSize(v)).toBe('default')
    }
  })
})

describe('largestTerminalSize', () => {
  it('is null with no terminal nodes', () => {
    expect(largestTerminalSize([])).toBeNull()
    expect(largestTerminalSize([{ kind: 'browser', size: { width: 2000, height: 1500 } }])).toBeNull()
  })

  it('picks the largest AREA, never max width × max height from different nodes', () => {
    expect(largestTerminalSize([t(1200, 300), t(700, 700), t(400, 900)])).toEqual({
      width: 700,
      height: 700
    })
  })

  it('ignores non-terminal kinds however big they are', () => {
    expect(
      largestTerminalSize([t(640, 440), { kind: 'editor', size: { width: 2000, height: 1500 } }])
    ).toEqual({ width: 640, height: 440 })
  })

  it('skips sizes a hand-edited file can carry', () => {
    expect(largestTerminalSize([t(NaN, 500), t(0, 900), t(-5, 5), t(800, 500)])).toEqual({
      width: 800,
      height: 500
    })
  })

  it('keeps the first on a tie', () => {
    expect(largestTerminalSize([t(400, 600), t(600, 400)])).toEqual({ width: 400, height: 600 })
  })
})
