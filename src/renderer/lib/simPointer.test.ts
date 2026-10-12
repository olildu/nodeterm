import { describe, expect, it } from 'vitest'
import {
  BOTTOM_EDGE_MARGIN_PT,
  EDGE_MARGIN_PT,
  MOVE_INTERVAL_MS,
  PINCH_BASE_RADIUS_PT,
  clientToDevice,
  cornerRadiusFraction,
  createMoveThrottle,
  edgeFor,
  fitScreen,
  pinchFor,
  wheelSwipe
} from './simPointer'

const IPHONE = { width: 393, height: 852 }

describe('fitScreen', () => {
  it('letterboxes a wide box: full height, centred horizontally', () => {
    const r = fitScreen({ width: 1000, height: 852 }, IPHONE)
    expect(r.height).toBeCloseTo(852)
    expect(r.width).toBeCloseTo(393)
    expect(r.left).toBeCloseTo((1000 - 393) / 2)
    expect(r.top).toBeCloseTo(0)
  })
  it('letterboxes a tall box: full width, centred vertically', () => {
    const r = fitScreen({ width: 393, height: 2000 }, IPHONE)
    expect(r.width).toBeCloseTo(393)
    expect(r.top).toBeCloseTo((2000 - 852) / 2)
  })
  it('keeps the device aspect ratio at any size', () => {
    const r = fitScreen({ width: 301, height: 517 }, IPHONE)
    expect(r.width / r.height).toBeCloseTo(IPHONE.width / IPHONE.height)
    expect(r.width).toBeLessThanOrEqual(301 + 1e-9)
    expect(r.height).toBeLessThanOrEqual(517 + 1e-9)
  })
  it('degrades to the box itself for a zero device or box (no NaN rect)', () => {
    expect(fitScreen({ width: 100, height: 50 }, { width: 0, height: 0 })).toEqual({ left: 0, top: 0, width: 100, height: 50 })
    expect(fitScreen({ width: 0, height: 0 }, IPHONE)).toEqual({ left: 0, top: 0, width: 0, height: 0 })
  })
})

describe('clientToDevice', () => {
  // The drawn screen sits at (100, 50) on the page, 196.5 × 426 CSS px = exactly half scale.
  const screen = { left: 100, top: 50, width: 196.5, height: 426 }
  it('maps through the on-screen rect to device points', () => {
    expect(clientToDevice({ x: 100, y: 50 }, screen, IPHONE, { clamp: false })).toEqual({ x: 0, y: 0 })
    const mid = clientToDevice({ x: 100 + 98.25, y: 50 + 213 }, screen, IPHONE, { clamp: false })!
    expect(mid.x).toBeCloseTo(196.5)
    expect(mid.y).toBeCloseTo(426)
  })
  it('is correct under canvas zoom, because the rect already includes the transform', () => {
    // Same screen drawn at 2× zoom: the rect doubles, so does the pixel distance, the points do not change.
    const zoomed = { left: 0, top: 0, width: 393 * 2, height: 852 * 2 }
    expect(clientToDevice({ x: 393, y: 852 }, zoomed, IPHONE, { clamp: false })).toMatchObject({ x: 196.5, y: 426 })
  })
  it('refuses a point in the letterbox unless clamping (a touch must START on the glass)', () => {
    expect(clientToDevice({ x: 10, y: 10 }, screen, IPHONE, { clamp: false })).toBeNull()
    expect(clientToDevice({ x: 10, y: 10 }, screen, IPHONE, { clamp: true })).toEqual({ x: 0, y: 0 })
  })
  it('clamps a drag out of the far corner to just inside the last point', () => {
    const p = clientToDevice({ x: 9999, y: 9999 }, screen, IPHONE, { clamp: true })!
    expect(p.x).toBeLessThan(IPHONE.width)
    expect(p.y).toBeLessThan(IPHONE.height)
    expect(p.x).toBeGreaterThan(IPHONE.width - 0.1)
  })
  it('is null for a degenerate screen', () => {
    expect(clientToDevice({ x: 1, y: 1 }, { left: 0, top: 0, width: 0, height: 0 }, IPHONE, { clamp: true })).toBeNull()
  })
})

describe('edgeFor', () => {
  it('flags a touch within the margin of each side', () => {
    expect(edgeFor({ x: 3, y: 400 }, IPHONE)).toBe('left')
    expect(edgeFor({ x: IPHONE.width - 3, y: 400 }, IPHONE)).toBe('right')
    expect(edgeFor({ x: 200, y: 4 }, IPHONE)).toBe('top')
    expect(edgeFor({ x: 200, y: IPHONE.height - 4 }, IPHONE)).toBe('bottom')
  })
  it('flags the home-indicator zone a little higher than the other edges', () => {
    expect(edgeFor({ x: 200, y: IPHONE.height - (BOTTOM_EDGE_MARGIN_PT - 1) }, IPHONE)).toBe('bottom')
    expect(edgeFor({ x: 200, y: IPHONE.height - BOTTOM_EDGE_MARGIN_PT }, IPHONE)).toBeUndefined()
    expect(edgeFor({ x: EDGE_MARGIN_PT, y: 400 }, IPHONE)).toBeUndefined()
  })
  it('is undefined in the middle of the screen', () => {
    expect(edgeFor({ x: 200, y: 400 }, IPHONE)).toBeUndefined()
  })
  it('gives a corner to the nearest side', () => {
    expect(edgeFor({ x: 2, y: IPHONE.height - 15 }, IPHONE)).toBe('left')
    expect(edgeFor({ x: 9, y: IPHONE.height - 3 }, IPHONE)).toBe('bottom')
  })
})

describe('createMoveThrottle', () => {
  it('lets one move through per interval (~60 Hz) and resets on a new touch', () => {
    let t = 1000
    const th = createMoveThrottle(MOVE_INTERVAL_MS, () => t)
    expect(th.take()).toBe(true)
    t += 5
    expect(th.take()).toBe(false)
    t += MOVE_INTERVAL_MS
    expect(th.take()).toBe(true)
    th.reset()
    expect(th.take()).toBe(true)
  })
})

describe('pinchFor', () => {
  const start = { x: 100, y: 200 }
  it('spreads the fingers for an Alt-drag away from the start', () => {
    expect(pinchFor(start, { x: 160, y: 200 }, false)).toEqual({ cx: 100, cy: 200, r1: PINCH_BASE_RADIUS_PT, r2: PINCH_BASE_RADIUS_PT + 60 })
  })
  it('squeezes them with Shift, never below a floor', () => {
    expect(pinchFor(start, { x: 120, y: 200 }, true)!.r2).toBe(10)
    expect(pinchFor(start, { x: 400, y: 200 }, true)!.r2).toBe(8)
  })
  it('is nothing for a click', () => {
    expect(pinchFor(start, { x: 102, y: 201 }, false)).toBeNull()
  })
})

describe('wheelSwipe', () => {
  it('drags the finger opposite the wheel, as content follows the finger', () => {
    const s = wheelSwipe({ x: 200, y: 400 }, 0, 100, IPHONE)!
    expect(s).toMatchObject({ x1: 200, y1: 400, x2: 200, y2: 300 })
  })
  it('keeps the end inside the screen and caps one burst', () => {
    const s = wheelSwipe({ x: 5, y: 20 }, 1000, 1000, IPHONE)!
    expect(s.x2).toBeGreaterThanOrEqual(1)
    expect(s.y2).toBeGreaterThanOrEqual(1)
    expect(Math.abs(s.y2 - s.y1)).toBeLessThanOrEqual(300)
  })
  it('is null for a negligible delta', () => {
    expect(wheelSwipe({ x: 1, y: 1 }, 0.5, 0.5, IPHONE)).toBeNull()
  })
})

describe('cornerRadiusFraction', () => {
  it('rounds a modern iPhone, barely rounds a home-button phone or an iPad', () => {
    expect(cornerRadiusFraction(IPHONE)).toBeGreaterThan(0.1)
    expect(cornerRadiusFraction({ width: 375, height: 667 })).toBeLessThan(0.05)
    expect(cornerRadiusFraction({ width: 820, height: 1180 })).toBeLessThan(0.05)
    expect(cornerRadiusFraction({ width: 0, height: 0 })).toBeGreaterThan(0)
  })
})
