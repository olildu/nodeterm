import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Source-level guards for the Simulator node's folded-chrome design. The component cannot be run
 * under vitest (canvas, WebGL-free but React Flow + IPC), and the failure modes here are all
 * "compiles, typechecks, looks wrong": a toolbar that came back, a clip that nothing drives, an
 * infinite animation, a hex colour.
 */
const read = (rel: string): string => fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')
const tsx = read('SimulatorNode.tsx')
const css = read('../styles.css')
const block = css.slice(css.indexOf('/* ── Simulator node ──'), css.indexOf('/* ==== Liquid Glass appearance'))

describe('SimulatorNode header', () => {
  it('uses the terminal header and its 22px icon buttons, not text buttons', () => {
    expect(tsx).toContain('sim-node__header term-node__header')
    expect(tsx).toContain('term-node__collapse')
    expect(tsx).toContain('term-node__refresh sim-node__tool')
    expect(tsx).not.toContain('files-node__btn')
  })
  it('has no bottom toolbar any more', () => {
    expect(tsx).not.toContain('sim-node__toolbar')
    expect(block).not.toContain('.sim-node__toolbar')
  })
  it('every header icon button has an accessible name', () => {
    expect(tsx).toMatch(/aria-label=\{b\.title\}/)
    expect(tsx).toMatch(/aria-label="Screenshot"/)
    expect(tsx).toMatch(/aria-label="Choose device"/)
  })
})

describe('folded chrome', () => {
  it('drives the clip from measured geometry, not hard-coded numbers', () => {
    expect(tsx).toContain('collapsedClip(bodySize, screenBox')
    expect(block).toContain('clip-path: var(--sim-clip-folded)')
    expect(block).toContain('clip-path: var(--sim-clip-open)')
  })
  it('opens on hover, focus-within or the pinned class, and pins for states that need the user', () => {
    expect(block).toMatch(/\.sim-node:hover,\s*\.sim-node:focus-within,\s*\.sim-node\.is-open/)
    expect(tsx).toContain('needsUser: !isLive || collapsed')
  })
  it('keeps the header strip reserved so the screen never moves', () => {
    expect(block).toMatch(/\.sim-node__header \{[^}]*position: absolute/)
    expect(block).toMatch(/\.sim-node__body \{[^}]*top: var\(--sim-header-h\)/)
  })
  it('keeps link handles and the driving chip outside the clipped root', () => {
    const rootEnd = tsx.indexOf('{/* Who is driving')
    expect(tsx.indexOf('<Handle', rootEnd)).toBeGreaterThan(rootEnd)
    expect(tsx.indexOf('sim-node__drivechip"', 0)).toBeGreaterThan(0)
    expect(tsx.slice(0, tsx.indexOf('{/* Who is driving'))).not.toContain('<Handle')
  })
})

describe('motion and colour discipline', () => {
  it('has no infinite animation and gates every keyframe animation', () => {
    expect(block).not.toMatch(/animation:[^;]*infinite/)
    const lines = block.split('\n')
    const anims = lines.filter((l) => /^\s*animation:/.test(l) && !/animation: none/.test(l))
    expect(anims.length).toBeGreaterThan(5)
    for (const [i, l] of lines.entries()) {
      if (/^\s*animation:/.test(l) && !/animation: none/.test(l)) {
        expect(lines[i + 1]).toMatch(/animation-play-state: var\(--nt-anim-state\)/)
      }
    }
  })
  it('turns motion off under Reduce Motion', () => {
    expect(block).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none !important/)
    expect(block).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/)
  })
  it('paints status with the semantic roles, not hexes', () => {
    const noComments = block.replace(/\/\*[\s\S]*?\*\//g, '')
    const hexes = noComments.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
    // the device's own black screen is content, the one allowed literal
    expect(hexes.filter((h) => h.toLowerCase() !== '#000')).toEqual([])
    expect(noComments).toContain('var(--state-working)')
  })
})
