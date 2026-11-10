// Source-level pin: `ssh2` and `electron-updater` are never
// VALUE-imported by shipped main/core/shared/server code. Main's module scope runs before Chromium's
// `ready`, and the two used to cost every launch 14–25 ms (ssh2) + 32–47 ms (electron-updater) warm
// there. Each now loads at first use — `ssh2()` in native-mux.ts, `UpdaterDeps.loadUpdater` in
// updater.ts — and a value import anywhere on the graph would quietly put the cost back. `import
// type` is fine (erased). The behavioural half is native-mux.lazy.test.ts and the "loaded lazily"
// block of updater.no-channel.test.ts.
import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const SRC = path.join(__dirname, '..')
const ROOTS = ['main', 'core', 'shared', 'server']
const LAZY = ['ssh2', 'electron-updater']

function shippedSources(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...shippedSources(p))
    // Tests (and test-keys.ts, a test-only helper) may import ssh2 directly.
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && e.name !== 'test-keys.ts') out.push(p)
  }
  return out
}

describe('lazily loaded main-process dependencies', () => {
  const files = ROOTS.flatMap((r) => shippedSources(path.join(SRC, r)))

  it('scans the real tree', () => {
    expect(files.some((f) => f.endsWith(path.join('remote-ssh', 'native', 'native-mux.ts')))).toBe(true)
    expect(files.some((f) => f.endsWith(path.join('main', 'updater.ts')))).toBe(true)
  })

  for (const dep of LAZY) {
    it(`no shipped module value-imports '${dep}'`, () => {
      const esc = dep.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
      // `import x from`, `import { a } from`, `import 'dep'`, `export … from` — but not `import type`.
      // `[^'"]` (not `[^;]`: this codebase has no semicolons) keeps a match inside one statement —
      // it cannot run past an earlier import's own specifier — while still spanning a multi-line `{ … }`.
      const value = new RegExp(`^[ \\t]*(?:import\\s+(?!type\\b)[^'"]*?from\\s*|import\\s*|export\\s+(?!type\\b)[^'"]*?from\\s*)['"]${esc}['"]`, 'm')
      const offenders = files.filter((f) => value.test(readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f))
      expect(offenders).toEqual([])
    })
  }
})
