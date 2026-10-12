/**
 * `uiautomator dump` XML → the element shape the iOS helper's `describe` returns
 * (native/sim-helper/PROTOCOL.md: `label, identifier, role, value, enabled, frame, depth, offscreen,
 * clipped, visibleFrame, center`), so `src/core/sim/verb.ts` renders both platforms with one reader.
 *
 * Bounds arrive in device PIXELS as `[l,t][r,b]`; everything here is divided by `scale` into points.
 * The dump's format is fixed and machine-written (every attribute double-quoted, five XML entities),
 * so this is a tokenizer over `<node …>` / `</node>` / `<node …/>`, not a general XML parser — and it
 * is linear: no backtracking regex runs over attribute text the app controls.
 */

export interface UiFrame {
  x: number
  y: number
  width: number
  height: number
}

export interface UiElement {
  label: string
  identifier: string
  role: string
  value: string
  enabled: boolean
  clickable: boolean
  checked?: boolean
  focused?: boolean
  scrollable?: boolean
  password?: boolean
  frame: UiFrame
  depth: number
  offscreen: boolean
  clipped: boolean
  visibleFrame?: UiFrame
  center?: { x: number; y: number }
  children?: UiElement[]
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    }
    return ENTITIES[e]
  })
}

/** `name="value"` pairs of one start tag (the text between `<node` and `>`). */
export function parseAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  const n = tag.length
  while (i < n) {
    while (i < n && (tag[i] === ' ' || tag[i] === '\n' || tag[i] === '\t' || tag[i] === '\r')) i++
    const nameStart = i
    while (i < n && tag[i] !== '=' && tag[i] !== ' ' && tag[i] !== '/') i++
    const name = tag.slice(nameStart, i)
    if (tag[i] !== '=') {
      i++
      continue
    }
    i++ // '='
    const quote = tag[i]
    if (quote !== '"' && quote !== "'") continue
    const end = tag.indexOf(quote, i + 1)
    if (end < 0) break
    if (name) out[name] = decodeEntities(tag.slice(i + 1, end))
    i = end + 1
  }
  return out
}

/** `[l,t][r,b]` → pixel rectangle, or null. */
export function parseBounds(b: string | undefined): { l: number; t: number; r: number; b: number } | null {
  const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(b ?? '')
  if (!m) return null
  return { l: Number(m[1]), t: Number(m[2]), r: Number(m[3]), b: Number(m[4]) }
}

/** `android.widget.Button` → `Button`; Android's generic containers read as `Element` like iOS's. */
export function roleOf(cls: string, clickable: boolean): string {
  const short = cls.slice(cls.lastIndexOf('.') + 1) || 'Element'
  if (short === 'EditText' || short === 'AutoCompleteTextView') return 'TextField'
  const generic = short === 'View' || short === 'ViewGroup' || short === 'FrameLayout' || short === 'LinearLayout' || short === 'RelativeLayout'
  if (generic) return clickable ? 'Button' : 'Element'
  return short
}

export interface ParsedDump {
  tree: UiElement | null
  flat: UiElement[]
}

const round2 = (v: number): number => Math.round(v * 100) / 100

/**
 * Parses a whole dump. `screen` is the display size in POINTS (for offscreen/clipped); `scale` is
 * pixels per point. Unparseable input yields an empty result, never a throw.
 */
export function parseDump(xml: string, scale: number, screen: { width: number; height: number }): ParsedDump {
  const flat: UiElement[] = []
  const root: UiElement = {
    label: '',
    identifier: '',
    role: 'Application',
    value: '',
    enabled: true,
    clickable: false,
    frame: { x: 0, y: 0, width: screen.width, height: screen.height },
    depth: 0,
    offscreen: false,
    clipped: false,
    children: []
  }
  const stack: UiElement[] = [root]
  let i = 0
  for (;;) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) break
    const gt = xml.indexOf('>', lt)
    if (gt < 0) break
    const tag = xml.slice(lt + 1, gt)
    i = gt + 1
    if (tag.startsWith('/node')) {
      if (stack.length > 1) stack.pop()
      continue
    }
    if (!tag.startsWith('node')) continue
    const selfClosing = tag.endsWith('/')
    const attrs = parseAttributes(tag.slice(4, selfClosing ? -1 : undefined))
    const bounds = parseBounds(attrs.bounds)
    const s = scale > 0 ? scale : 1
    const frame: UiFrame = bounds
      ? { x: round2(bounds.l / s), y: round2(bounds.t / s), width: round2(Math.max(0, bounds.r - bounds.l) / s), height: round2(Math.max(0, bounds.b - bounds.t) / s) }
      : { x: 0, y: 0, width: 0, height: 0 }
    const desc = attrs['content-desc'] ?? ''
    const text = attrs.text ?? ''
    const clickable = attrs.clickable === 'true'
    const password = attrs.password === 'true'
    const role = roleOf(attrs.class ?? '', clickable)
    // A text field's `text` is what was typed (iOS `value`), never its name; its name is content-desc
    // or the hint (newer dumps only — API 30 writes neither for a Flutter field, which then has no label).
    const field = role === 'TextField'
    const parent = stack[stack.length - 1]
    // Visible part: the frame cut to the screen AND to the parent's visible part (a scrolled row).
    const clip = parent.visibleFrame ?? parent.frame
    const vx1 = Math.max(frame.x, clip.x, 0)
    const vy1 = Math.max(frame.y, clip.y, 0)
    const vx2 = Math.min(frame.x + frame.width, clip.x + clip.width, screen.width)
    const vy2 = Math.min(frame.y + frame.height, clip.y + clip.height, screen.height)
    const visible = vx2 > vx1 && vy2 > vy1
    const offscreen = !visible || frame.width === 0 || frame.height === 0
    const clipped = !offscreen && (vx1 > frame.x || vy1 > frame.y || vx2 < frame.x + frame.width || vy2 < frame.y + frame.height)
    const el: UiElement = {
      // content-desc is what TalkBack reads; text is the value when both exist.
      label: field ? desc || (attrs.hint ?? '') : desc || (password ? '' : text),
      identifier: attrs['resource-id'] ?? '',
      role,
      value: password ? '' : field ? text : desc && text ? text : '',
      enabled: attrs.enabled !== 'false',
      clickable,
      ...(attrs.checkable === 'true' ? { checked: attrs.checked === 'true' } : {}),
      ...(attrs.focused === 'true' ? { focused: true } : {}),
      ...(attrs.scrollable === 'true' ? { scrollable: true } : {}),
      ...(password ? { password: true } : {}),
      frame,
      depth: stack.length - 1,
      offscreen,
      clipped,
      ...(offscreen
        ? {}
        : {
            visibleFrame: { x: round2(vx1), y: round2(vy1), width: round2(vx2 - vx1), height: round2(vy2 - vy1) },
            center: { x: round2((vx1 + vx2) / 2), y: round2((vy1 + vy2) / 2) }
          })
    }
    flat.push(el)
    ;(parent.children ??= []).push(el)
    if (!selfClosing) {
      el.children = []
      stack.push(el)
    }
  }
  return { tree: flat.length ? root : null, flat }
}

/** The deepest element whose visible part contains the point (`describe-point`). */
export function hitTest(flat: UiElement[], x: number, y: number): UiElement | null {
  let best: UiElement | null = null
  for (const e of flat) {
    const f = e.visibleFrame
    if (!f || x < f.x || y < f.y || x > f.x + f.width || y > f.y + f.height) continue
    if (!best || e.depth >= best.depth) best = e
  }
  return best
}

/** An element without its children (the flat list and `describe-point` carry no subtree). */
export function stripChildren(e: UiElement): UiElement {
  const { children: _c, ...rest } = e
  return rest
}
