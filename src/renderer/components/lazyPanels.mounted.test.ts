/**
 * A code-split panel that nothing mounts.
 *
 * The debug log panel (issue #78) shipped with its state, its Settings "Open" button, its palette
 * command and its `lazyPanels` export, and with no `<LogPanel …/>` anywhere. Every path that
 * opened it set `logPanelOpen` to true and rendered nothing. The settings dialog closed, so the
 * click looked like it did something. It stayed that way for two months, because an unmounted
 * component compiles, typechecks and passes its own tests. The only signal was
 * `tsc --noUnusedLocals` reporting `logPanelOpen` as never read (found while answering #1252).
 *
 * So the guard is the pairing: every panel `lazyPanels.tsx` exports must appear as JSX somewhere
 * in the renderer. A panel that is genuinely retired should leave `lazyPanels.tsx` too.
 *
 * MUTATION: delete the `<LogPanel …/>` line in Canvas.tsx → red, naming LogPanel.
 */
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const RENDERER = path.join(__dirname, '..')
const LAZY = path.join(__dirname, 'lazyPanels.tsx')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('lazyPanels: every code-split panel is mounted somewhere', () => {
  const exported = [...fs.readFileSync(LAZY, 'utf8').matchAll(/^export const (\w+) = withSuspense\(/gm)].map(
    (m) => m[1]
  )
  const sources = walk(RENDERER)
    .filter((file) => file !== LAZY)
    .map((file) => fs.readFileSync(file, 'utf8'))

  it('finds the exports it is guarding', () => {
    // An empty list would make the check below pass vacuously.
    expect(exported.length).toBeGreaterThan(5)
    expect(exported).toContain('LogPanel')
  })

  it.each(exported)('%s is rendered as JSX', (name) => {
    const jsx = new RegExp(`<${name}[\\s/>]`)
    expect(sources.some((src) => jsx.test(src)), `<${name}> is exported by lazyPanels but never mounted`).toBe(true)
  })
})
