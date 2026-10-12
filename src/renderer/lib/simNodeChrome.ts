import type { Box, Point, Rect } from './simPointer'

/**
 * Geometry for the Simulator node's collapse-to-the-phone chrome. Pure, so the numbers the CSS
 * transitions animate between are tested instead of eyeballed.
 *
 * The node is `root` (a bordered box) holding a header strip (absolutely positioned, ALWAYS
 * reserved so opening it never moves the screen) above a body; the phone is the body's letterboxed
 * `screen`. Collapsed, the root is clipped to the phone's rounded shape; expanded, the clip grows
 * past the root so the shadow is not cut.
 */

/** Header strip height (22px buttons + 6px padding either side). */
export const SIM_HEADER_H = 34
/** Border widths of `.sim-node` (the top one is the node colour edge). */
export const SIM_BORDER_TOP = 3
export const SIM_BORDER_X = 1
export const SIM_BORDER_BOTTOM = 1
/** Expanded clip overshoot, so the frame's shadow is not cut. */
export const SIM_CLIP_BLEED = 40
export const SIM_NODE_RADIUS = 10

/** How far the collapsed clip loosens around the phone so a ring is not cut off. */
export function clipPad(state: { driving: boolean; ring: boolean }): number {
  if (state.driving) return 16
  if (state.ring) return 3
  return 0
}

/** The border-box size of the node for a given measured body (the body excludes header + borders). */
export function rootBox(body: Box): Box {
  return {
    width: body.width + 2 * SIM_BORDER_X,
    height: body.height + SIM_HEADER_H + SIM_BORDER_TOP + SIM_BORDER_BOTTOM
  }
}

/**
 * `clip-path` value that hugs the phone: insets from the root's border box to the screen's rect
 * (screen is relative to the BODY, which starts below the top border and the header), grown by
 * `pad`, with the phone's corner radius grown by the same amount. Null until the body is measured.
 */
export function collapsedClip(body: Box, screen: Rect, radius: number, pad: number): string | null {
  if (!(body.width > 0 && body.height > 0 && screen.width > 0 && screen.height > 0)) return null
  const root = rootBox(body)
  const left = SIM_BORDER_X + screen.left - pad
  const top = SIM_BORDER_TOP + SIM_HEADER_H + screen.top - pad
  const right = root.width - (SIM_BORDER_X + screen.left + screen.width) - pad
  const bottom = root.height - (SIM_BORDER_TOP + SIM_HEADER_H + screen.top + screen.height) - pad
  const r = Math.max(0, radius + pad)
  const px = (n: number): string => `${Math.round(n * 10) / 10}px`
  return `inset(${px(top)} ${px(right)} ${px(bottom)} ${px(left)} round ${px(r)})`
}

/** The expanded clip: past the box on every side so the shadow shows. Same shape function as the collapsed one. */
export function expandedClip(): string {
  const b = `-${SIM_CLIP_BLEED}px`
  return `inset(${b} ${b} ${b} ${b} round ${SIM_NODE_RADIUS}px)`
}

/**
 * A device point → pixels inside the drawn screen (the tap marker's position). Out-of-range input
 * is clamped to the glass; a device with no size maps to the centre rather than NaN.
 */
export function deviceToScreenPx(p: Point, device: Box, screen: Box): Point {
  if (!(device.width > 0 && device.height > 0)) return { x: screen.width / 2, y: screen.height / 2 }
  const fx = Math.min(1, Math.max(0, p.x / device.width))
  const fy = Math.min(1, Math.max(0, p.y / device.height))
  return { x: fx * screen.width, y: fy * screen.height }
}

/**
 * Whether the chrome must stay open regardless of the pointer: the user is working in it (selected,
 * a menu/rename/colour picker up, a touch in flight, maximized) or the node needs the user (no
 * device, shut down, connecting, error). Hover and focus-within are CSS (:hover / :focus-within).
 */
export function chromePinnedOpen(s: {
  selected: boolean
  maximized: boolean
  needsUser: boolean
  menuOpen: boolean
  editing: boolean
  touching: boolean
  dragging?: boolean
}): boolean {
  return !!(s.selected || s.maximized || s.needsUser || s.menuOpen || s.editing || s.touching || s.dragging)
}
