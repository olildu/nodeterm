import type { SimEdge } from '@shared/sim'

/**
 * Pointer → device-touch geometry for the simulator node. Pure: the component feeds it client
 * rects and coordinates, and everything the helper receives is in device POINTS (an iPhone 15 is
 * 393×852), origin top-left — never CSS pixels, never canvas zoom.
 *
 * Canvas zoom is a CSS transform, so `getBoundingClientRect()` of the drawn screen already
 * includes it: mapping a client point through that rect is zoom-correct with no extra factor.
 */

export interface Box {
  width: number
  height: number
}
export interface Rect extends Box {
  left: number
  top: number
}
export interface Point {
  x: number
  y: number
}

/** The largest rect of the device's aspect ratio that fits `box`, centred (the letterbox). */
export function fitScreen(box: Box, device: Box): Rect {
  if (!(box.width > 0 && box.height > 0 && device.width > 0 && device.height > 0)) {
    return { left: 0, top: 0, width: Math.max(0, box.width), height: Math.max(0, box.height) }
  }
  const scale = Math.min(box.width / device.width, box.height / device.height)
  const width = device.width * scale
  const height = device.height * scale
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height }
}

/**
 * A client point → device points through the on-screen rect of the drawn screen. `clamp: false`
 * returns null outside the rect (a touch must START on the glass); `clamp: true` pins to the edge,
 * for the moves and the release of a touch that began inside and was dragged out.
 */
export function clientToDevice(
  client: Point,
  screen: Rect,
  device: Box,
  opts: { clamp: boolean }
): Point | null {
  if (!(screen.width > 0 && screen.height > 0)) return null
  const fx = (client.x - screen.left) / screen.width
  const fy = (client.y - screen.top) / screen.height
  const inside = fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1
  if (!inside && !opts.clamp) return null
  const cx = Math.min(1, Math.max(0, fx))
  const cy = Math.min(1, Math.max(0, fy))
  // Stay strictly inside the last point: the helper rejects a down exactly on the far edge.
  return {
    x: Math.min(cx * device.width, device.width - 0.01),
    y: Math.min(cy * device.height, device.height - 0.01)
  }
}

/** A touch that starts within this many points of a side is a system edge gesture there. */
export const EDGE_MARGIN_PT = 10
/** The home-indicator swipe starts a little higher than the other edges (measured with the spike viewer). */
export const BOTTOM_EDGE_MARGIN_PT = 20

/**
 * Which system-gesture edge a touch-down belongs to, or undefined. The edge nearest the point wins
 * when two margins overlap (a corner), so a touch near the bottom-left reads as whichever side it
 * is actually closest to.
 */
export function edgeFor(p: Point, device: Box): SimEdge | undefined {
  const candidates: Array<[SimEdge, number, number]> = [
    ['left', p.x, EDGE_MARGIN_PT],
    ['right', device.width - p.x, EDGE_MARGIN_PT],
    ['top', p.y, EDGE_MARGIN_PT],
    ['bottom', device.height - p.y, BOTTOM_EDGE_MARGIN_PT]
  ]
  let best: SimEdge | undefined
  let bestDist = Infinity
  for (const [edge, dist, margin] of candidates) {
    if (dist >= 0 && dist < margin && dist < bestDist) {
      best = edge
      bestDist = dist
    }
  }
  return best
}

/** Moves are sent at most this often: 60 Hz is the screen's own rate and more only floods the pipe. */
export const MOVE_INTERVAL_MS = 16

/** Leading-edge throttle with an injectable clock. */
export function createMoveThrottle(interval = MOVE_INTERVAL_MS, now: () => number = () => performance.now()) {
  let last = -Infinity
  return {
    /** True when a move may be sent now. */
    take(): boolean {
      const t = now()
      if (t - last < interval) return false
      last = t
      return true
    },
    reset(): void {
      last = -Infinity
    }
  }
}

/** Alt-drag pinch: the fingers' starting radius, in points. */
export const PINCH_BASE_RADIUS_PT = 30

/**
 * Alt+drag is a pinch around the point where the drag began: dragging AWAY from it spreads the
 * fingers (zoom in), and with Shift held the same drag squeezes them (zoom out). One `pinch`
 * command on release — no live preview, which is the simple version the brief allows.
 */
export function pinchFor(
  start: Point,
  end: Point,
  squeeze: boolean
): { cx: number; cy: number; r1: number; r2: number } | null {
  const d = Math.hypot(end.x - start.x, end.y - start.y)
  if (d < 6) return null // a click, not a gesture
  const r1 = PINCH_BASE_RADIUS_PT
  const r2 = squeeze ? Math.max(8, r1 - d) : r1 + d
  return { cx: start.x, cy: start.y, r1, r2 }
}

/**
 * A wheel/trackpad delta over the screen → a short swipe from the pointer, in the direction the
 * content should move. Content follows the fingers, so scrolling DOWN (positive deltaY) drags the
 * finger UP. Returns null for a negligible delta.
 */
export function wheelSwipe(
  at: Point,
  deltaX: number,
  deltaY: number,
  device: Box
): { x1: number; y1: number; x2: number; y2: number } | null {
  const clampStep = (v: number): number => Math.max(-300, Math.min(300, v))
  const dx = clampStep(-deltaX)
  const dy = clampStep(-deltaY)
  if (Math.hypot(dx, dy) < 2) return null
  const inside = (v: number, max: number): number => Math.min(max - 1, Math.max(1, v))
  return {
    x1: at.x,
    y1: at.y,
    x2: inside(at.x + dx, device.width),
    y2: inside(at.y + dy, device.height)
  }
}

/**
 * The screen's corner radius as a fraction of its width. A modern iPhone (aspect > 2) has ~55 pt
 * corners on a 393 pt screen; a home-button iPhone or an iPad is nearly square-cornered, and
 * rounding THOSE by the iPhone amount would clip real UI at the corners.
 */
export function cornerRadiusFraction(device: Box, platform: 'ios' | 'android' = 'ios'): number {
  if (!(device.width > 0 && device.height > 0)) return 0.12
  const aspect = Math.max(device.width, device.height) / Math.min(device.width, device.height)
  // Android phones round their corners far less than a notched iPhone does.
  if (aspect > 2) return platform === 'android' ? 0.07 : 0.13
  return aspect > 1.6 ? 0.03 : 0.045
}
