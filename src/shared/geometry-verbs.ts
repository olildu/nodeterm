/**
 * The geometry half of canvas control (issue #1288): `resize`, `place` and `list --geometry` — the
 * verbs that let an agent rebuild an exact layout (two tight columns of four sessions filling a
 * vertical monitor, say) every time a session is replaced, instead of a human dragging windows.
 *
 * In `src/shared` for the same reason as `arrange-verb.ts`: the shape gate has three readers that
 * cannot import each other — desktop main refuses a malformed call before it is forwarded (that
 * handler never runs `parseControlRequest`), core's `parseControlRequest` (the Server Edition's
 * parser), and the renderer's dispatch belt — and the generated agent docs render their numbers
 * from the constants here. A limit typed once per reader is how the docs come to advertise a value
 * the parser refuses.
 *
 * What is decided HERE is only what no canvas could act on: a missing flag, a value that is not a
 * whole number, a flag the verb does not read. Whether an id exists, is a frame, is collapsed or
 * is maximized is the canvas's question (`resizeNodes` / `placeNodes` in renderer/state/workspace).
 *
 * EVERY FLAG TAKES A VALUE — the SSH shim-loop rule: an older shim on an SSH host takes the token
 * after any flag as its value, so a valueless `--geometry` would swallow whatever follows it.
 */

import { NODE_SIZE_MAX } from './default-node-size'

/**
 * The farthest from the canvas origin `place` puts anything, in px, on either axis. A canvas has no
 * edge, so this is not a bound on the canvas: it is a bound on a TYPO — 100 000 px is over forty
 * 2400 px-wide nodes side by side, and a node sent past it would take a zoom-out to find. Refused
 * above it, never clamped (a clamped coordinate is a placement the caller did not ask for).
 */
export const PLACE_COORD_MAX = 100_000

/** The values `list --geometry` reads. Absent = off, so the default text answer stays one short line per node. */
export const LIST_GEOMETRY_VALUES = ['on', 'off'] as const

/** The flags each geometry verb reads. Anything else is refused by name (#539: a silently dropped
 *  `--heigth 400` is indistinguishable from success to the agent that typed it). */
const RESIZE_FLAGS: ReadonlySet<string> = new Set(['nodes', 'width', 'height'])
const PLACE_FLAGS: ReadonlySet<string> = new Set(['nodes', 'x', 'y', 'dx', 'dy'])

/** The coordinate/size flags `move` must refuse — see `moveArgsRefusal`. */
const MOVE_GEOMETRY_FLAGS = ['x', 'y', 'dx', 'dy', 'width', 'height'] as const

/** The ids a `--nodes` list names, in order, blanks dropped. */
export function geometryIds(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

/** A whole, positive px count, or the refusal. The ceiling is NOT checked here: `resize` clamps to
 *  the kind's minimum and the canvas maximum and reports what it applied (`resizeNodes`). */
function parseSize(flag: 'width' | 'height', raw: string): number | string {
  const s = raw.trim()
  const n = /^\d+$/.test(s) ? Number(s) : NaN
  if (!Number.isSafeInteger(n) || n <= 0) {
    return `resize: --${flag} must be a whole number of pixels above 0 (got "${raw}")`
  }
  return n
}

/** A whole, signed px coordinate within ±PLACE_COORD_MAX, or the refusal. */
function parseCoord(flag: 'x' | 'y' | 'dx' | 'dy', raw: string): number | string {
  const s = raw.trim()
  if (!/^-?\d+$/.test(s)) return `place: --${flag} must be a whole number of pixels (got "${raw}")`
  const n = Number(s) + 0 // `+ 0` turns a typed "-0" into 0
  if (Math.abs(n) > PLACE_COORD_MAX) {
    return `place: --${flag} ${n} is beyond ±${PLACE_COORD_MAX} px — nothing was placed`
  }
  return n
}

function unknownFlag(verb: string, args: Record<string, string>, allowed: ReadonlySet<string>): string | null {
  const unknown = Object.keys(args).find((key) => !allowed.has(key))
  if (unknown === undefined) return null
  if (unknown === 'node') return `${verb}: takes --nodes <id,id> (plural, like arrange and move), not --node`
  return `${verb}: unknown flag --${unknown}`
}

export interface ResizeRequest {
  ids: string[]
  width?: number
  height?: number
}

/** `resize --nodes <id,id> [--width <px>] [--height <px>]`, parsed, or the sentence that refuses it. */
export function parseResizeArgs(args: Record<string, string>): ResizeRequest | { error: string } {
  const flag = unknownFlag('resize', args, RESIZE_FLAGS)
  if (flag) return { error: flag }
  const ids = geometryIds(args.nodes)
  if (ids.length === 0) return { error: 'resize requires --nodes <id,id>' }
  if (args.width === undefined && args.height === undefined) {
    return { error: 'resize requires --width <px>, --height <px>, or both' }
  }
  const out: ResizeRequest = { ids }
  for (const axis of ['width', 'height'] as const) {
    if (args[axis] === undefined) continue
    const v = parseSize(axis, args[axis])
    if (typeof v === 'string') return { error: v }
    out[axis] = v
  }
  return out
}

export interface PlaceRequest {
  ids: string[]
  /** Absolute: where the top-left goes, in canvas (root) coordinates — the numbers `list` reports. */
  x?: number
  y?: number
  /** Relative: how far to shift, in px. Never mixed with `x`/`y` (`parsePlaceArgs` refuses it). */
  dx?: number
  dy?: number
}

/** `place --nodes <id,id> (--x <n> | --y <n> | --dx <n> | --dy <n>)…`, parsed, or the refusal. */
export function parsePlaceArgs(args: Record<string, string>): PlaceRequest | { error: string } {
  const flag = unknownFlag('place', args, PLACE_FLAGS)
  if (flag) return { error: flag }
  const ids = geometryIds(args.nodes)
  if (ids.length === 0) return { error: 'place requires --nodes <id,id>' }
  const absolute = args.x !== undefined || args.y !== undefined
  const relative = args.dx !== undefined || args.dy !== undefined
  if (!absolute && !relative) {
    return { error: 'place requires --x/--y (canvas coordinates, as `list` reports them) or --dx/--dy (an offset)' }
  }
  // Two answers to "where": a silent precedence would be a half-honoured call the agent cannot see.
  if (absolute && relative) {
    return { error: 'place takes --x/--y (where) or --dx/--dy (how far), not both' }
  }
  const out: PlaceRequest = { ids }
  for (const axis of ['x', 'y', 'dx', 'dy'] as const) {
    if (args[axis] === undefined) continue
    const v = parseCoord(axis, args[axis])
    if (typeof v === 'string') return { error: v }
    out[axis] = v
  }
  return out
}

/** Whether `list` was asked for its geometry, or the refusal for a value it does not read. */
export function parseListGeometry(args: Record<string, string>): { geometry: boolean } | { error: string } {
  const raw = args.geometry
  if (raw === undefined) return { geometry: false }
  const v = raw.trim().toLowerCase()
  if (!(LIST_GEOMETRY_VALUES as readonly string[]).includes(v)) {
    return { error: `list: --geometry takes ${LIST_GEOMETRY_VALUES.join(' or ')} (got "${raw}")` }
  }
  return { geometry: v === 'on' }
}

/** `list --geometry on`, for a request the gate already passed — a refused value never gets here. */
export function listGeometryRequested(args: Record<string, string>): boolean {
  const r = parseListGeometry(args)
  return 'geometry' in r && r.geometry
}

/**
 * `move` with a coordinate or a size flag, refused by name. The issue that asked for placement
 * spelled it `move --node <id> --x <n> --y <n>`, and that is the one spelling that must NOT work:
 * `move` without `--group` means "out of every frame, to the top level", so `move --nodes a --x 10`
 * would pull a framed node out of its frame and then ignore the `--x` — a structural change nobody
 * asked for, reported as a success. `place` keeps the parent.
 */
export function moveArgsRefusal(args: Record<string, string>): string | null {
  const flag = MOVE_GEOMETRY_FLAGS.find((f) => args[f] !== undefined)
  if (flag === undefined) return null
  return flag === 'width' || flag === 'height'
    ? `move: --${flag} is not a move flag — move only changes which frame a node is in; size it with \`resize --nodes <id> --${flag} <px>\``
    : `move: --${flag} is not a move flag — move only changes which frame a node is in (and without --group takes it OUT of its frame); put it at coordinates with \`place --nodes <id> --${flag} <n>\`, which keeps its frame`
}

/**
 * The shape gate for every geometry-bearing verb, or `null`. `arrange --gap` is checked by
 * `arrangeArgsRefusal` with the rest of `arrange`'s flags; this covers the verbs this file owns.
 */
export function geometryArgsRefusal(verb: string, args: Record<string, string>): string | null {
  if (verb === 'resize') {
    const r = parseResizeArgs(args)
    return 'error' in r ? r.error : null
  }
  if (verb === 'place') {
    const r = parsePlaceArgs(args)
    return 'error' in r ? r.error : null
  }
  if (verb === 'list') {
    const r = parseListGeometry(args)
    return 'error' in r ? r.error : null
  }
  if (verb === 'move') return moveArgsRefusal(args)
  return null
}

/**
 * The agent-facing description of the geometry verbs, rendered into BOTH generated bodies (the
 * SKILL.md and the marker block) with every number taken from the constants the parser and the
 * transforms check — so the two bodies cannot describe different products, and neither can name a
 * limit the code does not hold.
 */
export function geometryGuidanceLines(): string[] {
  return [
    `- \`list --geometry ${LIST_GEOMETRY_VALUES.join('|')}\` — the text form adds each node's place and size:`,
    '  `@ x,y w×h` in canvas coordinates (whole px), plus `in <frameId>` for a framed node and',
    '  `collapsed` for a header-only one. The JSON result rows ALWAYS carry `x`, `y`, `width`, `height`',
    '  and `parent` (the frame id, or null), so a script reads them without the flag. `x`/`y` are the',
    '  numbers `place` takes; `width`/`height` the ones `resize` takes.',
    '- `resize --nodes <id,id> [--width <px>] [--height <px>]` — set the size of existing nodes (give',
    '  one axis or both; the other is kept). Each value is held between that node kind\'s minimum (the',
    `  smallest the user can drag it to) and ${NODE_SIZE_MAX.width}×${NODE_SIZE_MAX.height}, and applied exactly (no grid snapping); the reply`,
    '  reports the size actually applied and says when it was clamped. A terminal\'s rows and columns',
    '  follow by themselves. A group frame',
    '  is refused — a frame sizes itself to what it holds, so resize or `arrange` its contents. A',
    '  COLLAPSED node keeps its header-only look: the width applies now, the height when it is',
    '  expanded. A MAXIMIZED node is restored first, then sized. A framed node\'s frames re-fit around it.',
    '- `place --nodes <id> --x <n> --y <n>` — put a node\'s top-left at canvas coordinates (the numbers',
    '  `list` reports; give one axis to move along it only). `place --nodes <id,id> --dx <n> --dy <n>`',
    '  shifts nodes by an offset instead; the two forms do not mix. With several ids and `--x`/`--y`',
    '  the nodes move as ONE block: they keep their places relative to each other and the block\'s',
    `  top-left lands on (x, y). Whole px, within ±${PLACE_COORD_MAX}. A framed node STAYS in its frame, which`,
    '  grows or shrinks to hold it (to take it out, `move` it first); a frame moves with everything in',
    '  it. A MAXIMIZED node is restored first. Values are applied exactly — no grid snapping.',
    '  `move` takes none of these flags: it only changes which frame a node is in, and without',
    '  `--group` it takes a node OUT of its frame — so it refuses `--x`/`--y`/`--width` rather than',
    '  doing that silently.',
    '- Worked example — two tight columns of four sessions on a 1080×1920 vertical screen (at 100%',
    '  zoom a canvas px is a screen px): `resize --nodes a,b,c,d,e,f,g,h --width 540 --height 480`, then',
    '  `arrange --nodes a,e,b,f,c,g,d,h --layout grid --cols 2 --gap 0` (ids are laid out row by row,',
    '  so pair each row\'s left and right node), then `place --nodes a,b,c,d,e,f,g,h --x 0 --y 0` to pin',
    '  the block to the corner, and `list --geometry on` to check. Rerun the same calls after a session',
    '  is replaced, with the new id in its slot.'
  ]
}
