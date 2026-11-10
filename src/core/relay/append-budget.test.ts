// Security audit F3: a hosted Commenter could rotate a project's real board history out of its one
// rotated generation by appending fast. The budget is per peer key, rate- and byte-bounded.
import { describe, it, expect } from 'vitest'
import {
  BOARD_APPEND_BYTES_PER_WINDOW,
  BOARD_APPEND_MIN_INTERVAL_MS,
  BOARD_APPEND_WINDOW_MS,
  createAppendBudget,
  createAppendBudgets
} from './append-budget'

describe('createAppendBudget', () => {
  it('one comment per interval; a refused append spends nothing', () => {
    let t = 1_000_000
    const b = createAppendBudget({ now: () => t })
    expect(b.admit(100)).toBe(true)
    expect(b.admit(100)).toBe(false)
    t += BOARD_APPEND_MIN_INTERVAL_MS - 1
    expect(b.admit(100)).toBe(false)
    t += 1
    expect(b.admit(100)).toBe(true)
  })
  it('at most the byte budget per window, refilled as old appends leave it', () => {
    let t = 1_000_000
    const b = createAppendBudget({ now: () => t })
    const chunk = 16 * 1024
    expect(b.admit(chunk)).toBe(true)
    t += BOARD_APPEND_MIN_INTERVAL_MS
    expect(b.admit(chunk)).toBe(true)
    t += BOARD_APPEND_MIN_INTERVAL_MS
    expect(b.admit(1)).toBe(false) // the window holds BOARD_APPEND_BYTES_PER_WINDOW already
    expect(BOARD_APPEND_BYTES_PER_WINDOW).toBe(2 * chunk)
    t += BOARD_APPEND_WINDOW_MS
    expect(b.admit(chunk)).toBe(true)
  })
  it('the 8 MiB a flood needs to rotate history out takes hours, not seconds', () => {
    let t = 0
    const b = createAppendBudget({ now: () => t })
    let bytes = 0
    for (let i = 0; i < 100_000 && bytes < 8 * 1024 * 1024; i++) {
      if (b.admit(16 * 1024)) bytes += 16 * 1024
      t += BOARD_APPEND_MIN_INTERVAL_MS
    }
    expect(t / 3_600_000).toBeGreaterThan(4)
  })
  it('a nonsense size spends nothing rather than throwing', () => {
    const b = createAppendBudget({ now: () => 0 })
    expect(b.admit(Number.NaN)).toBe(true)
  })
})

describe('createAppendBudgets', () => {
  it('one budget per key, the same one on every ask (a reconnect does not reset it), bounded', () => {
    const forKey = createAppendBudgets(2, { now: () => 0 })
    expect(forKey('a').admit(1)).toBe(true)
    expect(forKey('a').admit(1)).toBe(false)
    expect(forKey('b').admit(1)).toBe(true)
    forKey('c')
    // 'a' was evicted by the bound: a fresh budget.
    expect(forKey('a').admit(1)).toBe(true)
  })
})
