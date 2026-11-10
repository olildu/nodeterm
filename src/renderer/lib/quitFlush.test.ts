import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { addQuitFlush, runQuitFlushes } from './quitFlush'

describe('quit flush registry', () => {
  it('runs every registered flush, and one that fails does not stop the others', async () => {
    const a = vi.fn(async () => {
      throw new Error('disk full')
    })
    const b = vi.fn(async () => true)
    const offA = addQuitFlush(a)
    const offB = addQuitFlush(b)
    await expect(runQuitFlushes()).resolves.toBeUndefined()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    offB()
    await runQuitFlushes()
    expect(b).toHaveBeenCalledTimes(1)
  })

  // Main takes ONE answer to its flush request, so the registry only works if Canvas's single
  // `onFlushRequest` handler waits for it before answering. Canvas is too large to mount here.
  it('Canvas answers main\'s flush request only after the registered flushes ran', () => {
    const src = readFileSync(join(__dirname, '../canvas/Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
    const at = src.indexOf('api.workspace.onFlushRequest(')
    expect(at).toBeGreaterThan(-1)
    expect(src.slice(at, at + 400)).toMatch(/await Promise\.allSettled\(\[[\s\S]*runQuitFlushes\(\)/)
    expect(src.split('onFlushRequest(').length - 1).toBe(1)
  })
})
