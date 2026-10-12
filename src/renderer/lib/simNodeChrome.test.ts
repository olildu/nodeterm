import { describe, expect, it } from 'vitest'
import {
  SIM_HEADER_H,
  chromePinnedOpen,
  clipPad,
  collapsedClip,
  deviceToScreenPx,
  expandedClip,
  rootBox
} from './simNodeChrome'

describe('collapsedClip', () => {
  const body = { width: 400, height: 800 }
  const screen = { left: 24, top: 10, width: 352, height: 780 }

  it('insets from the border box to the phone, header + borders included', () => {
    const root = rootBox(body)
    expect(root).toEqual({ width: 402, height: 800 + SIM_HEADER_H + 4 })
    // top = 3 (border) + 34 (header) + 10; left = 1 + 24; right/bottom mirror
    expect(collapsedClip(body, screen, 44, 0)).toBe(
      `inset(47px ${root.width - 25 - 352}px ${root.height - 47 - 780}px 25px round 44px)`
    )
  })

  it('the clip hugs the screen exactly: inset box == screen rect in root coordinates', () => {
    const c = collapsedClip(body, screen, 44, 0)!
    const [t, r, b, l] = /inset\(([\d.-]+)px ([\d.-]+)px ([\d.-]+)px ([\d.-]+)px/.exec(c)!.slice(1).map(Number)
    const root = rootBox(body)
    expect(l).toBe(1 + screen.left)
    expect(t).toBe(3 + SIM_HEADER_H + screen.top)
    expect(root.width - l - r).toBe(screen.width)
    expect(root.height - t - b).toBe(screen.height)
  })

  it('pad grows every side and the radius by the same amount', () => {
    const tight = collapsedClip(body, screen, 44, 0)!
    const loose = collapsedClip(body, screen, 44, 16)!
    expect(tight).toContain('round 44px')
    expect(loose).toContain('round 60px')
    expect(loose).toContain(`inset(${3 + SIM_HEADER_H + 10 - 16}px`)
  })

  it('is null until measured (never a NaN clip that hides the node)', () => {
    expect(collapsedClip({ width: 0, height: 0 }, screen, 44, 0)).toBeNull()
    expect(collapsedClip(body, { left: 0, top: 0, width: 0, height: 0 }, 44, 0)).toBeNull()
  })

  it('shares one shape function with the expanded clip so the transition interpolates', () => {
    expect(expandedClip()).toMatch(/^inset\(-40px -40px -40px -40px round 10px\)$/)
    expect(collapsedClip(body, screen, 44, 0)).toMatch(/^inset\(.+ round .+\)$/)
  })
})

describe('clipPad', () => {
  it('loosens most for a driving pulse, a little for a selection ring, none at rest', () => {
    expect(clipPad({ driving: true, ring: true })).toBe(16)
    expect(clipPad({ driving: false, ring: true })).toBe(3)
    expect(clipPad({ driving: false, ring: false })).toBe(0)
  })
})

describe('deviceToScreenPx (tap marker)', () => {
  const device = { width: 393, height: 852 }
  const screen = { width: 196.5, height: 426 }
  it('maps device points proportionally onto the drawn screen', () => {
    expect(deviceToScreenPx({ x: 0, y: 0 }, device, screen)).toEqual({ x: 0, y: 0 })
    expect(deviceToScreenPx({ x: 393, y: 852 }, device, screen)).toEqual({ x: 196.5, y: 426 })
    expect(deviceToScreenPx({ x: 196.5, y: 426 }, device, screen)).toEqual({ x: 98.25, y: 213 })
  })
  it('clamps to the glass and survives an unknown device size', () => {
    expect(deviceToScreenPx({ x: -50, y: 9999 }, device, screen)).toEqual({ x: 0, y: 426 })
    expect(deviceToScreenPx({ x: 5, y: 5 }, { width: 0, height: 0 }, screen)).toEqual({ x: 98.25, y: 213 })
  })
})

describe('chromePinnedOpen', () => {
  const idle = { selected: false, maximized: false, needsUser: false, menuOpen: false, editing: false, touching: false }
  it('is closed for an idle live node', () => expect(chromePinnedOpen(idle)).toBe(false))
  it.each(['selected', 'maximized', 'needsUser', 'menuOpen', 'editing', 'touching'] as const)('stays open for %s', (k) => {
    expect(chromePinnedOpen({ ...idle, [k]: true })).toBe(true)
  })
})
