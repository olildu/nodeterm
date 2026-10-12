// The simulator node's contract: what the renderer may ask the host's `sim-helper` to do, what comes
// back, and the pure rules both sides share. The helper's own protocol is
// native/sim-helper/PROTOCOL.md; this file is the SUBSET nodeterm exposes and the validation that
// stands between a renderer (or, one day, an agent) and that helper's stdin.
//
// Everything here is pure and runs in the renderer, the main process and tests alike.
import { SIMULATOR_UDID } from './run-config'

/** A UUID the way CoreSimulator spells a device id; anything else is "no device". */
export function normalizeSimUdid(value: unknown): string | undefined {
  if (typeof value !== 'string' || !SIMULATOR_UDID.test(value)) return undefined
  return value.toUpperCase()
}

/** A device name is display text read from `simctl` output or a hand-editable project file. */
export function normalizeSimName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').trim()
  return clean ? clean.slice(0, 80) : undefined
}

// ─── Closed vocabularies ─────────────────────────────────────────────────────────────────────

export const SIM_BUTTONS = ['home', 'lock', 'side', 'siri', 'volup', 'voldown', 'playpause'] as const
export type SimButton = (typeof SIM_BUTTONS)[number]
export const SIM_MODIFIERS = ['shift', 'ctrl', 'alt', 'cmd'] as const
export type SimModifier = (typeof SIM_MODIFIERS)[number]
export const SIM_EDGES = ['none', 'top', 'left', 'bottom', 'right'] as const
export type SimEdge = (typeof SIM_EDGES)[number]
export const SIM_TOUCH_PHASES = ['down', 'move', 'up'] as const
export type SimTouchPhase = (typeof SIM_TOUCH_PHASES)[number]

/** Bounds. Points are device points (an iPhone is ~400×900); the cap only has to stop nonsense. */
export const SIM_COORD_MAX = 10_000
export const SIM_TEXT_MAX = 4_000
export const SIM_HOLD_MS_MAX = 5_000
export const SIM_GESTURE_MS_MAX = 5_000
/** HID keyboard usage page 7: 0x04 (A) … 0xE7 (right GUI). */
export const SIM_HID_USAGE_MIN = 0x04
export const SIM_HID_USAGE_MAX = 0xe7

// ─── Status ──────────────────────────────────────────────────────────────────────────────────

export interface SimDeviceInfo {
  udid: string
  name: string
  runtime?: string
  state?: string
  deviceType?: string
  pixelWidth: number
  pixelHeight: number
  pointWidth: number
  pointHeight: number
  scale: number
  ready: boolean
  streaming?: boolean
}

/** Why a device cannot be shown. Each has its own sentence in the node (`lib/simulatorView.ts`). */
export type SimErrorCode =
  | 'unsupported' //       not macOS
  | 'no-helper' //         resources/bin/sim-helper is missing
  | 'no-xcode' //          the helper could not load the Simulator frameworks
  | 'already-attached' //  another controller (a second nodeterm, a spike viewer) holds the device
  | 'device-not-found'
  | 'spawn-failed'
  | 'helper-exited' //     died after it was running
  | 'setup-failed'
  | 'stream-failed'

export type SimPhase =
  /** The helper is starting, or waiting for the device to finish booting. */
  | 'connecting'
  | 'live'
  /** The device is not booted; the node offers Boot. */
  | 'shutdown'
  | 'error'

export interface SimStatus {
  phase: SimPhase
  device?: SimDeviceInfo
  error?: { code: SimErrorCode; message: string }
}

export type SimAvailability =
  | { ok: true }
  | { ok: false; code: 'unsupported' | 'no-helper'; message: string }

export interface SimDeviceEntry {
  udid: string
  name: string
  /** "iOS 26.5" */
  runtime: string
  booted: boolean
}

export interface SimDevicesResult {
  devices: SimDeviceEntry[]
  error?: string
}

// ─── Commands ────────────────────────────────────────────────────────────────────────────────

export type SimReply =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; code: string; error: string }

/** What a screenshot reply carries on top of the helper's own fields: the image itself. */
export type SimScreenshotReply =
  | { ok: true; format: 'png' | 'jpeg'; width: number; height: number; data: Uint8Array }
  | { ok: false; code: string; error: string }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const inRange = (v: unknown, lo: number, hi: number): v is number => finite(v) && v >= lo && v <= hi
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v)

export type SimSanitized = { ok: true; cmd: Record<string, unknown> } | { ok: false; error: string }

const bad = (error: string): SimSanitized => ({ ok: false, error })

/**
 * Validates one renderer request and returns a FRESH object holding only the fields this build
 * knows. Nothing the caller sent that is not named here reaches the helper, and nothing is ever
 * interpolated into a shell: the helper takes JSON on stdin and `simctl` is only ever run by core
 * with fixed argv. `id`/`quiet` are the transport's, never the caller's: `quiet` is set by core for
 * the fire-and-forget channel only.
 */
export function sanitizeSimCommand(raw: unknown): SimSanitized {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('request must be an object')
  const r = raw as Record<string, unknown>
  const cmd = r.cmd
  const coord = (key: string): number | null => (inRange(r[key], -SIM_COORD_MAX, SIM_COORD_MAX) ? (r[key] as number) : null)
  switch (cmd) {
    case 'touch': {
      if (!oneOf(SIM_TOUCH_PHASES, r.phase)) return bad('touch: phase must be down, move or up')
      const x = coord('x')
      const y = coord('y')
      if (x === null || y === null) return bad('touch: x and y must be finite numbers')
      const out: Record<string, unknown> = { cmd, phase: r.phase, x, y }
      if (r.edge !== undefined) {
        if (!oneOf(SIM_EDGES, r.edge)) return bad('touch: unknown edge')
        out.edge = r.edge
      }
      return { ok: true, cmd: out }
    }
    case 'tap': {
      const x = coord('x')
      const y = coord('y')
      if (x === null || y === null) return bad('tap: x and y must be finite numbers')
      const out: Record<string, unknown> = { cmd, x, y }
      if (r.holdMs !== undefined) {
        if (!inRange(r.holdMs, 0, SIM_HOLD_MS_MAX)) return bad('tap: holdMs out of range')
        out.holdMs = r.holdMs
      }
      return { ok: true, cmd: out }
    }
    case 'swipe': {
      const x1 = coord('x1')
      const y1 = coord('y1')
      const x2 = coord('x2')
      const y2 = coord('y2')
      if (x1 === null || y1 === null || x2 === null || y2 === null) return bad('swipe: x1,y1,x2,y2 must be finite numbers')
      const out: Record<string, unknown> = { cmd, x1, y1, x2, y2 }
      if (r.ms !== undefined) {
        if (!inRange(r.ms, 1, SIM_GESTURE_MS_MAX)) return bad('swipe: ms out of range')
        out.ms = r.ms
      }
      if (r.steps !== undefined) {
        if (!inRange(r.steps, 1, 200)) return bad('swipe: steps out of range')
        out.steps = Math.round(r.steps as number)
      }
      if (r.edge !== undefined) {
        if (!oneOf(SIM_EDGES, r.edge)) return bad('swipe: unknown edge')
        out.edge = r.edge
      }
      return { ok: true, cmd: out }
    }
    case 'pinch': {
      const cx = coord('cx')
      const cy = coord('cy')
      if (cx === null || cy === null) return bad('pinch: cx and cy must be finite numbers')
      if (!inRange(r.r1, 0, SIM_COORD_MAX) || !inRange(r.r2, 0, SIM_COORD_MAX)) return bad('pinch: r1 and r2 must be non-negative numbers')
      const out: Record<string, unknown> = { cmd, cx, cy, r1: r.r1, r2: r.r2 }
      if (r.ms !== undefined) {
        if (!inRange(r.ms, 1, SIM_GESTURE_MS_MAX)) return bad('pinch: ms out of range')
        out.ms = r.ms
      }
      if (r.steps !== undefined) {
        if (!inRange(r.steps, 1, 200)) return bad('pinch: steps out of range')
        out.steps = Math.round(r.steps as number)
      }
      if (r.angleDeg !== undefined) {
        if (!inRange(r.angleDeg, -360, 360)) return bad('pinch: angleDeg out of range')
        out.angleDeg = r.angleDeg
      }
      return { ok: true, cmd: out }
    }
    case 'button': {
      if (!oneOf(SIM_BUTTONS, r.name)) return bad('button: unknown button')
      const out: Record<string, unknown> = { cmd, name: r.name }
      if (r.holdMs !== undefined) {
        if (!inRange(r.holdMs, 0, SIM_HOLD_MS_MAX)) return bad('button: holdMs out of range')
        out.holdMs = r.holdMs
      }
      return { ok: true, cmd: out }
    }
    case 'key': {
      if (!inRange(r.usage, SIM_HID_USAGE_MIN, SIM_HID_USAGE_MAX) || !Number.isInteger(r.usage)) {
        return bad('key: usage must be a HID keyboard usage (7-page, 0x04–0xE7)')
      }
      const out: Record<string, unknown> = { cmd, usage: r.usage }
      if (r.down !== undefined) {
        if (typeof r.down !== 'boolean') return bad('key: down must be a boolean')
        out.down = r.down
      }
      if (r.mods !== undefined) {
        if (!Array.isArray(r.mods) || r.mods.length > 4 || !r.mods.every((m) => oneOf(SIM_MODIFIERS, m))) {
          return bad('key: mods must be a list of shift, ctrl, alt, cmd')
        }
        out.mods = [...new Set(r.mods as string[])]
      }
      return { ok: true, cmd: out }
    }
    case 'text': {
      if (typeof r.text !== 'string' || r.text.length === 0) return bad('text: text must be a non-empty string')
      if (r.text.length > SIM_TEXT_MAX) return bad(`text: longer than ${SIM_TEXT_MAX} characters`)
      const out: Record<string, unknown> = { cmd, text: r.text }
      if (r.paste !== undefined) {
        if (typeof r.paste !== 'boolean') return bad('text: paste must be a boolean')
        out.paste = r.paste
      }
      return { ok: true, cmd: out }
    }
    case 'describe': {
      const out: Record<string, unknown> = { cmd }
      if (r.flat !== undefined) {
        if (typeof r.flat !== 'boolean') return bad('describe: flat must be a boolean')
        out.flat = r.flat
      }
      return { ok: true, cmd: out }
    }
    case 'describe-point': {
      const x = coord('x')
      const y = coord('y')
      if (x === null || y === null) return bad('describe-point: x and y must be finite numbers')
      return { ok: true, cmd: { cmd, x, y } }
    }
    case 'screenshot': {
      const out: Record<string, unknown> = { cmd }
      if (r.format !== undefined) {
        if (r.format !== 'png' && r.format !== 'jpeg') return bad('screenshot: format must be png or jpeg')
        out.format = r.format
      }
      if (r.scale !== undefined) {
        if (!inRange(r.scale, 0.05, 1)) return bad('screenshot: scale must be between 0.05 and 1')
        out.scale = r.scale
      }
      return { ok: true, cmd: out }
    }
    case 'info':
      return { ok: true, cmd: { cmd } }
    default:
      return bad('unknown command')
  }
}

/** Commands that are fire-and-forget on the pointer channel (the helper gets `quiet: true`). */
export function isQuietEligible(cmd: unknown): boolean {
  return cmd === 'touch' || cmd === 'tap' || cmd === 'swipe' || cmd === 'pinch' || cmd === 'key' || cmd === 'text' || cmd === 'button'
}

// ─── Per-viewer stream policy ────────────────────────────────────────────────────────────────

/**
 * How hard a viewer wants the stream pushed.
 *  - `active`     node on screen and window focused: full rate.
 *  - `background` node on screen, window not focused (a second monitor): a trickle, so it stays
 *                 roughly current without holding the GPU at 60 fps for nobody.
 *  - `off`        offscreen, collapsed, or window hidden: no frames at all. The helper sends a
 *                 first frame at once when the stream is switched back on.
 */
export type SimViewLevel = 'active' | 'background' | 'off'

export const SIM_FPS: Record<SimViewLevel, number> = { active: 60, background: 8, off: 0 }
export const SIM_SCALE_DEFAULT = 0.5
export const SIM_SCALE_MIN = 0.2
export const SIM_QUALITY = 0.7

export interface SimViewOptions {
  level: SimViewLevel
  /** Fraction of the device's pixel size the node wants to draw. Clamped on receipt. */
  scale?: number
}

export function normalizeSimViewOptions(raw: unknown): SimViewOptions {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const level: SimViewLevel = oneOf(['active', 'background', 'off'] as const, r.level) ? r.level : 'off'
  const scale = finite(r.scale) ? Math.min(1, Math.max(SIM_SCALE_MIN, r.scale)) : undefined
  return { level, ...(scale !== undefined ? { scale } : {}) }
}

/** The stream a device should run given everyone watching it: the busiest viewer decides. */
export function combineSimViews(views: readonly SimViewOptions[]): { maxFps: number; scale: number } {
  let maxFps = 0
  let scale = 0
  for (const v of views) {
    const fps = SIM_FPS[v.level]
    if (fps > maxFps) maxFps = fps
    if (fps > 0) scale = Math.max(scale, v.scale ?? SIM_SCALE_DEFAULT)
  }
  return { maxFps, scale: scale || SIM_SCALE_DEFAULT }
}

// ─── Frames ──────────────────────────────────────────────────────────────────────────────────

/** `u64be captureMicros | u16be w | u16be h | JPEG` — the helper's type-1 payload, forwarded as is. */
export const SIM_FRAME_HEADER_BYTES = 12

export interface SimFrame {
  captureMicros: number
  width: number
  height: number
  jpeg: Uint8Array
}

export function parseSimFrame(bytes: Uint8Array): SimFrame | null {
  if (bytes.byteLength <= SIM_FRAME_HEADER_BYTES) return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = v.getUint16(8)
  const height = v.getUint16(10)
  if (width === 0 || height === 0) return null
  return {
    captureMicros: v.getUint32(0) * 0x1_0000_0000 + v.getUint32(4),
    width,
    height,
    jpeg: bytes.subarray(SIM_FRAME_HEADER_BYTES)
  }
}

// ─── The renderer-facing API ─────────────────────────────────────────────────────────────────

type Unsub = () => void

/**
 * `window.nodeTerminal.sim`. Desktop-macOS only: the Server Edition and relay tabs get a stub that
 * answers `unsupported` (see `renderer/bridge/stubs.ts`). A viewer is one mounted node; the same
 * window may mount several for one device and the host keeps ONE helper process for all of them.
 */
/** Main → renderer, over `sim:agent-event`. */
export type SimAgentEvent =
  | {
      kind: 'drive'
      ownerNodeId: string
      /** The Simulator nodes the call acted on. */
      simNodeIds: string[]
      /** Highlight until this epoch-ms (same machine, same clock). Always bounded. */
      until: number
      /**
       * A short, sanitized description of the call for the "driving" chip (`sim --tap-label "General"`,
       * `typing 8 characters`, `waiting for the screen to settle`). Never the text of a `--type`:
       * it can be a password. Absent from an event that carries no new wording.
       */
      action?: string
      /** Where a tap landed, in device POINTS (the node maps it onto its drawn screen). */
      tap?: { x: number; y: number }
      /** A swipe's endpoints, in device POINTS. */
      swipe?: { x1: number; y1: number; x2: number; y2: number }
    }
  | { kind: 'auto-link'; projectId: string; ownerNodeId: string; simNodeId: string }

export interface SimApi {
  availability(): Promise<SimAvailability>
  devices(refresh?: boolean): Promise<SimDevicesResult>
  /** Start (or join) the helper for `udid`. Resolves with the current status; later changes arrive on `onStatus`. */
  attach(udid: string, viewerId: string, view: SimViewOptions): Promise<SimStatus>
  detach(udid: string, viewerId: string): void
  setView(udid: string, viewerId: string, view: SimViewOptions): void
  /** Boot a shut-down device WITHOUT opening Simulator.app. */
  boot(udid: string): Promise<{ ok: boolean; error?: string }>
  command(udid: string, cmd: Record<string, unknown>): Promise<SimReply>
  screenshot(udid: string): Promise<SimScreenshotReply>
  /** Fire-and-forget (pointer moves, keys): never replies, errors are dropped by core. */
  input(udid: string, cmd: Record<string, unknown>): void
  onFrame(udid: string, listener: (frame: Uint8Array) => void): Unsub
  /** The renderer decoded a frame; lets core send the next without queueing for a slow window. */
  ackFrame(udid: string): void
  onStatus(udid: string, listener: (status: SimStatus) => void): Unsub
  /** What an agent's `sim` call did that the canvas shows: a driving highlight, or a link to create. */
  onAgentEvent(listener: (event: SimAgentEvent) => void): Unsub
  /** The user removed an agent↔Simulator link: core's auto-link ledger never re-creates it this run. */
  linkRemoved(ownerNodeId: string, simNodeId: string): void
}
