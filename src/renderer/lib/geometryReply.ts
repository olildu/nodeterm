// The replies of `resize` and `place` (issue #1288), kept pure so the sentences an agent acts on are
// tested where Canvas.tsx — a component with no unit seam — cannot be.
//
// The rule both follow: say what was APPLIED, not what was asked. A clamped size, a node that was
// restored from maximized first, a collapsed node whose height waits for its expand, a framed child
// that rode along with its frame — each is a difference between the request and the canvas, and an
// agent that cannot see the difference builds its next call on the wrong numbers.

import type { PlaceApplied, ResizeApplied } from '../state/workspace'

const px = (v: number): number => Math.round(v) + 0

const skipped = (unknown: readonly string[]): string =>
  unknown.length ? ` (${unknown.length} unknown id(s) skipped: ${unknown.join(', ')})` : ''

/** One line for a `resize` call, plus the JSON `result` beside it. */
export function resizeReply(
  out: { applied: readonly ResizeApplied[]; unknown: readonly string[] },
  changed: boolean
): { message: string; result: Record<string, unknown> } {
  const notes = (a: ResizeApplied): string => {
    const n: string[] = []
    if (a.clamped) n.push('clamped to what this kind of node allows')
    if (a.collapsed) n.push('collapsed: the width applies now, the height when it is expanded')
    if (a.restored) n.push('was maximized: restored first')
    return n.length ? ` (${n.join('; ')})` : ''
  }
  const each = out.applied.map((a) => `${a.id} ${px(a.width)}×${px(a.height)}${notes(a)}`).join(', ')
  const message = changed
    ? `resized ${out.applied.length} node(s): ${each}${skipped(out.unknown)}`
    : `already that size — nothing changed: ${each}${skipped(out.unknown)}`
  return {
    message,
    result: {
      resized: out.applied.map((a) => ({ ...a, width: px(a.width), height: px(a.height) })),
      unknown: [...out.unknown],
      changed
    }
  }
}

/** One line for a `place` call, plus the JSON `result` beside it. */
export function placeReply(
  out: { placed: readonly PlaceApplied[]; unknown: readonly string[]; carried: readonly string[] },
  to: { x?: number; y?: number; dx?: number; dy?: number },
  changed: boolean
): { message: string; result: Record<string, unknown> } {
  const at = out.placed.map((p) => `${p.id} at ${px(p.x)},${px(p.y)}${p.restored ? ' (was maximized: restored first)' : ''}`).join(', ')
  const how =
    to.dx !== undefined || to.dy !== undefined
      ? `moved ${out.placed.length} node(s) by ${to.dx ?? 0},${to.dy ?? 0}`
      : out.placed.length > 1
        ? `placed ${out.placed.length} node(s) as one block`
        : `placed ${out.placed.length} node(s)`
  const carried = out.carried.length
    ? ` (${out.carried.join(', ')} moved with the frame that holds ${out.carried.length > 1 ? 'them' : 'it'})`
    : ''
  const message = changed
    ? `${how}: ${at}${carried}${skipped(out.unknown)}`
    : `already there — nothing moved: ${at}${carried}${skipped(out.unknown)}`
  return {
    message,
    result: {
      placed: out.placed.map((p) => ({ ...p, x: px(p.x), y: px(p.y) })),
      carried: [...out.carried],
      unknown: [...out.unknown],
      changed
    }
  }
}
