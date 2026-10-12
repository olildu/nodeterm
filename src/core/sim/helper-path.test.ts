import { describe, expect, it } from 'vitest'
import { androidHelperPath, simHelperPath } from './helper-path'

describe('simHelperPath', () => {
  const has = (...files: string[]) => (p: string) => files.includes(p)
  it('prefers the packaged copy', () => {
    expect(
      simHelperPath({ resourcesPath: '/App/Resources', repoRoot: '/repo', exists: has('/App/Resources/bin/sim-helper', '/repo/resources/bin/sim-helper') })
    ).toBe('/App/Resources/bin/sim-helper')
  })
  it('falls back to the dev build under the repo', () => {
    expect(simHelperPath({ resourcesPath: undefined, repoRoot: '/repo', exists: has('/repo/resources/bin/sim-helper') })).toBe('/repo/resources/bin/sim-helper')
  })
  it('is null when neither exists, and a throwing probe reads as absent', () => {
    expect(simHelperPath({ resourcesPath: '/App/Resources', repoRoot: '/repo', exists: () => false })).toBeNull()
    expect(
      simHelperPath({ resourcesPath: '/App/Resources', repoRoot: '/repo', exists: (p) => { if (p.startsWith('/App')) throw new Error('EACCES'); return true } })
    ).toBe('/repo/resources/bin/sim-helper')
  })
})

describe('androidHelperPath', () => {
  it('prefers the packaged script, then the dev build, never PATH', () => {
    const have = new Set(['/repo/resources/bin/android-helper.cjs'])
    expect(androidHelperPath({ resourcesPath: '/R', repoRoot: '/repo', exists: (p) => have.has(p) })).toBe('/repo/resources/bin/android-helper.cjs')
    have.add('/R/bin/android-helper.cjs')
    expect(androidHelperPath({ resourcesPath: '/R', repoRoot: '/repo', exists: (p) => have.has(p) })).toBe('/R/bin/android-helper.cjs')
    expect(androidHelperPath({ resourcesPath: null, repoRoot: null, exists: () => true })).toBeNull()
  })
})
