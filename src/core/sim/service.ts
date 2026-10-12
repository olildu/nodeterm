import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import { IPC } from '../../shared/ipc'
import {
  SIM_QUALITY,
  combineSimViews,
  isQuietEligible,
  normalizeSimUdid,
  normalizeSimViewOptions,
  sanitizeSimCommand,
  type SimAvailability,
  type SimDeviceInfo,
  type SimDevicesResult,
  type SimErrorCode,
  type SimReply,
  type SimScreenshotReply,
  type SimStatus,
  type SimViewOptions
} from '../../shared/sim'
import { bootSimulatorHeadless, listSimulators } from '../run-service'
import { platform } from '../platform'
import { SimHelper, type HelperChild, type HelperEvent, type HelperExit, type SpawnHelper } from './helper-process'
import { simHelperPath } from './helper-path'

/**
 * The host side of the simulator node (CLAUDE.md → Simulator node).
 *
 * One `sim-helper attach <udid>` process per DEVICE, shared by every node that views it and by
 * every window that has such a node mounted: the first viewer starts it, the last one leaving
 * stops it after a short grace (a project switch unmounts and remounts the node within a second or
 * two, and respawning the helper costs ~1 s of black screen). The helper takes an exclusive
 * per-device lock, so two helpers for one device cannot exist — a second would exit
 * `already-attached` — which is why a restart WAITS for the old process to be gone first.
 *
 * Frames are pushed, never queued: each window may hold two unacknowledged frames; while it does,
 * only the newest later frame is kept and sent on the next ack. A window that stops acknowledging
 * (reload, wedged renderer) is let through again after {@link ACK_STALL_MS}, so one lost ack can
 * never freeze a node for good.
 *
 * Electron-free: it reaches its shell only through injected `send` / `clientIds`, so the Server
 * Edition (which never registers it) and the unit tests (a fake child) share the code.
 */

/** How long a device keeps its helper after its last viewer leaves. */
export const SIM_GRACE_MS = 4_000
/** Unacknowledged frames per window. */
export const SIM_MAX_IN_FLIGHT = 2
/** An unacknowledged frame older than this is assumed lost. */
export const ACK_STALL_MS = 2_000

/** How often an agent's settle wait looks at the frame counter. */
const AGENT_IDLE_POLL_MS = 25
/** The longest an agent call waits for the frame the helper sends when its stream is switched on. */
const AGENT_FIRST_FRAME_MS = 400
/** Stream scale while an agent holds the lease: ~1 px per point, enough to see a spinner or a caret. */
export const AGENT_STREAM_SCALE = 0.33
/** How long an agent's viewer keeps the helper alive after its last call. */
export const AGENT_LINGER_MS = 30_000

const VIEWER_ID = /^[A-Za-z0-9._-]{1,128}$/

export interface AgentRunOptions {
  /** How long to wait for the device to be usable (a cold helper start is ~1 s; a boot is longer). */
  connectTimeoutMs: number
  /** `--boot`: a device that reads as shut down is expected to come up, so keep waiting. */
  tolerateShutdown?: boolean
}

export type AgentFailure = { ok: false; code: string; error: string }

/** What a `sim` call may do to its device while it holds the lease. */
export interface AgentDevice {
  status(): SimStatus
  command(raw: Record<string, unknown>): Promise<SimReply>
  screenshot(scale: number): Promise<SimScreenshotReply>
  /**
   * Resolves once the screen has not changed for `quietMs` (idle), or with `idle: false` when
   * `timeoutMs` passed first. `changed` says whether any frame arrived at all.
   *
   * With `reactionMs` it is the wait AFTER AN INPUT: frames are counted from the moment the last
   * input command was sent, and a screen that has not started to change is given `reactionMs` to do
   * so before it counts as "no visible change". MEASURED on an iPhone 15 simulator: the first changed
   * frame arrives 110 ms after a tap and ~480 ms after a Home press, so a bare quiet window ends
   * before the screen has even begun to move.
   */
  waitIdle(opts: { quietMs: number; timeoutMs: number; reactionMs?: number }): Promise<{ idle: boolean; waitedMs: number; changed: boolean }>
}

export interface SimServiceDeps {
  isDarwin: boolean
  helperPath: () => string | null
  spawn: SpawnHelper
  listDevices: () => Promise<SimDevicesResult>
  boot: (udid: string) => Promise<{ ok: boolean; error?: string }>
  send: (uiId: number, channel: string, ...args: unknown[]) => void
  clientIds: () => number[]
  graceMs?: number
  now?: () => number
  log?: (message: string) => void
}

interface Viewer {
  senderId: number
  viewerId: string
  view: SimViewOptions
  /** The core's own agent lease (the `sim` canvas-control verb): no window, no frames sent to it. */
  internal?: boolean
}

interface SenderFlow {
  inFlight: number
  sentAt: number
  pending: Buffer | null
  /** Acks received for the oldest in-flight frame; every viewer in the window acks each frame once. */
  acks: number
}

interface Entry {
  udid: string
  helper: SimHelper | null
  /** True from the moment a start is committed to until the process exists. */
  starting: boolean
  /** Settles when a stopped helper is really gone; a new start waits for it. */
  gone: Promise<void> | null
  generation: number
  status: SimStatus
  viewers: Map<string, Viewer>
  flow: Map<number, SenderFlow>
  lastFrame: Buffer | null
  applied: { maxFps: number; scale: number } | null
  grace: ReturnType<typeof setTimeout> | null
  /** Frames seen from this helper process and when the last arrived — the agent's settle wait reads them. */
  frameCount: number
  lastFrameAt: number
  /** Observers of "the status changed" — the agent lease's wait for the device to be usable. */
  statusTaps: Set<() => void>
  /** Agent calls on one device run one at a time; this is the tail of that chain. */
  agentTail: Promise<unknown>
  /** Keeps the agent's viewer (and so the helper) alive between a script's calls. */
  agentLinger: ReturnType<typeof setTimeout> | null
}

const key = (senderId: number, viewerId: string): string => `${senderId}:${viewerId}`

function errorStatus(code: SimErrorCode, message: string, device?: SimDeviceInfo): SimStatus {
  return { phase: 'error', ...(device ? { device } : {}), error: { code, message } }
}

/** The helper's `info`/`ready` device body → our shape; undefined if it is not usable. */
export function toDeviceInfo(raw: unknown): SimDeviceInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const udid = normalizeSimUdid(r.udid)
  if (!udid) return undefined
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v.slice(0, 120) : undefined)
  return {
    udid,
    name: str(r.name) ?? 'Simulator',
    ...(str(r.runtime) ? { runtime: str(r.runtime) } : {}),
    ...(str(r.state) ? { state: str(r.state) } : {}),
    ...(str(r.deviceType) ? { deviceType: str(r.deviceType) } : {}),
    pixelWidth: num(r.pixelWidth),
    pixelHeight: num(r.pixelHeight),
    pointWidth: num(r.pointWidth),
    pointHeight: num(r.pointHeight),
    scale: num(r.scale) || 1,
    ready: r.ready === true,
    ...(typeof r.streaming === 'boolean' ? { streaming: r.streaming } : {})
  }
}

const FATAL_CODES: ReadonlySet<string> = new Set(['no-xcode', 'already-attached', 'device-not-found'])

export function createSimService(deps: SimServiceDeps) {
  const devices = new Map<string, Entry>()
  const graceMs = deps.graceMs ?? SIM_GRACE_MS
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((m: string) => console.warn(`[sim] ${m}`))

  function availability(): SimAvailability {
    if (!deps.isDarwin) {
      return { ok: false, code: 'unsupported', message: 'The iOS Simulator needs macOS with Xcode installed.' }
    }
    if (!deps.helperPath()) {
      return { ok: false, code: 'no-helper', message: 'This build does not include the simulator helper (sim-helper).' }
    }
    return { ok: true }
  }

  // ─── delivery ───────────────────────────────────────────────────────────────────────────────

  function senders(entry: Entry): number[] {
    const live = new Set(deps.clientIds())
    const seen = new Set<number>()
    for (const [k, v] of [...entry.viewers]) {
      if (v.internal) continue // the core's own lease: no window to lose, no frames to send
      // A window that is gone (closed, or the Server Edition's socket dropped) can never detach.
      if (!live.has(v.senderId)) {
        entry.viewers.delete(k)
        continue
      }
      seen.add(v.senderId)
    }
    for (const id of [...entry.flow.keys()]) if (!seen.has(id)) entry.flow.delete(id)
    return [...seen]
  }

  function pushStatus(entry: Entry): void {
    for (const id of senders(entry)) deps.send(id, IPC.simStatus(entry.udid), entry.status)
    for (const tap of [...entry.statusTaps]) tap()
    if (entry.viewers.size === 0) scheduleStop(entry)
  }

  function deliver(entry: Entry, senderId: number, payload: Buffer): void {
    const flow = entry.flow.get(senderId)
    if (!flow) return
    if (flow.inFlight >= SIM_MAX_IN_FLIGHT && now() - flow.sentAt > ACK_STALL_MS) {
      flow.inFlight = 0
      flow.acks = 0
    }
    if (flow.inFlight >= SIM_MAX_IN_FLIGHT) {
      flow.pending = payload // newest wins; older queued frames are dropped, never sent late
      return
    }
    flow.inFlight++
    flow.sentAt = now()
    deps.send(senderId, IPC.simFrame(entry.udid), payload)
  }

  function broadcastFrame(entry: Entry, payload: Buffer): void {
    for (const id of senders(entry)) deliver(entry, id, payload)
  }

  function ackFrame(senderId: number, rawUdid: unknown): void {
    const udid = normalizeSimUdid(rawUdid)
    const entry = udid ? devices.get(udid) : undefined
    const flow = entry?.flow.get(senderId)
    if (!entry || !flow) return
    // A window frame is delivered ONCE but each node showing the device in it acknowledges it, so
    // credit is returned when every viewer of this window has answered, not on the first answer.
    const need = Math.max(1, [...entry.viewers.values()].filter((v) => v.senderId === senderId).length)
    flow.acks++
    if (flow.acks < need) return
    flow.acks = 0
    flow.inFlight = Math.max(0, flow.inFlight - 1)
    if (flow.pending && flow.inFlight < SIM_MAX_IN_FLIGHT) {
      const next = flow.pending
      flow.pending = null
      deliver(entry, senderId, next)
    }
  }

  // ─── stream policy ──────────────────────────────────────────────────────────────────────────

  function applyStream(entry: Entry): void {
    const helper = entry.helper
    if (!helper?.running) return
    const want = combineSimViews([...entry.viewers.values()].map((v) => v.view))
    const prev = entry.applied
    if (prev && prev.maxFps === want.maxFps && (want.maxFps === 0 || prev.scale === want.scale)) return
    entry.applied = want
    if (want.maxFps === 0) helper.fire({ cmd: 'stream', on: false })
    else helper.fire({ cmd: 'stream', on: true, maxFps: want.maxFps, scale: want.scale, quality: SIM_QUALITY })
  }

  // ─── helper lifecycle ───────────────────────────────────────────────────────────────────────

  function startHelper(entry: Entry): void {
    if (entry.helper || entry.starting) return
    entry.starting = true
    entry.status = { phase: 'connecting', ...(entry.status.device ? { device: entry.status.device } : {}) }
    pushStatus(entry)
    void (async () => {
      if (entry.gone) await entry.gone
      entry.starting = false
      // Everyone left while the previous helper was still shutting down.
      if (entry.viewers.size === 0 || entry.helper) {
        if (entry.viewers.size === 0) scheduleStop(entry)
        return
      }
      const bin = deps.helperPath()
      if (!bin) {
        entry.status = errorStatus('no-helper', 'The simulator helper (sim-helper) is missing from this build.')
        pushStatus(entry)
        return
      }
      const generation = ++entry.generation
      const live = (): boolean => entry.generation === generation
      const helper = new SimHelper(bin, entry.udid, deps.spawn, {
        onFrame: (payload) => {
          if (!live()) return
          entry.lastFrame = payload
          entry.frameCount++
          entry.lastFrameAt = now()
          broadcastFrame(entry, payload)
        },
        onEvent: (ev) => {
          if (live()) onEvent(entry, ev)
        },
        onExit: (info) => {
          if (live()) onExit(entry, info)
        }
      })
      entry.helper = helper
      entry.applied = null
      helper.start()
      if (!helper.running) return // a synchronous spawn failure was reported through onExit
      applyStream(entry)
      // Pre-boot facts (name, point size) so the node can lay out before the device is ready.
      void helper.request({ cmd: 'info' }).then((reply) => {
        if (!live() || !reply.ok || entry.status.device?.ready) return
        const device = toDeviceInfo(reply.device)
        if (!device) return
        entry.status = { ...entry.status, device: { ...device, ...(entry.status.device ?? {}), ready: false } }
        pushStatus(entry)
      })
    })()
  }

  function onEvent(entry: Entry, ev: HelperEvent): void {
    switch (ev.event) {
      case 'ready': {
        const device = toDeviceInfo(ev.device)
        entry.status = { phase: 'live', ...(device ? { device: { ...device, ready: true } } : {}) }
        entry.applied = null // the helper re-registers its stream after a recovery; say it again
        applyStream(entry)
        pushStatus(entry)
        return
      }
      case 'device-state': {
        const state = typeof ev.state === 'string' ? ev.state : ''
        const device = entry.status.device ? { ...entry.status.device, state, ready: false } : undefined
        if (state === 'Shutdown' || state === 'Shutting Down') {
          entry.status = { phase: 'shutdown', ...(device ? { device } : {}) }
          entry.lastFrame = null
        } else if (entry.status.phase !== 'live') {
          entry.status = { phase: 'connecting', ...(device ? { device } : {}) }
        } else if (device) {
          // Booted again while we still show the last session: wait for `ready` to say it is usable.
          entry.status = { phase: 'connecting', device }
        }
        pushStatus(entry)
        return
      }
      case 'surfaces-changed': {
        const dev = entry.status.device
        if (!dev) return
        const merged = toDeviceInfo({ ...dev, ...ev, udid: dev.udid, name: dev.name, ready: dev.ready })
        if (merged) {
          entry.status = { ...entry.status, device: merged }
          pushStatus(entry)
        }
        return
      }
      case 'error': {
        const code = typeof ev.code === 'string' ? ev.code : 'setup-failed'
        const message = typeof ev.message === 'string' && ev.message ? ev.message.slice(0, 300) : code
        if (ev.fatal === true || FATAL_CODES.has(code)) {
          entry.status = errorStatus(asErrorCode(code), message, entry.status.device)
        } else {
          // setup-failed is retried by the helper every 0.5 s and stream-failed is non-fatal: keep
          // the phase, attach the sentence so the node can show it.
          entry.status = { ...entry.status, error: { code: asErrorCode(code), message } }
        }
        pushStatus(entry)
        return
      }
    }
  }

  function onExit(entry: Entry, info: HelperExit): void {
    entry.helper = null
    entry.applied = null
    entry.lastFrame = null
    if (info.requested) {
      if (entry.viewers.size === 0 && !entry.starting) devices.delete(entry.udid)
      return
    }
    // A fatal error event usually precedes the exit and says more than the exit code does.
    if (!(entry.status.phase === 'error' && entry.status.error && FATAL_CODES.has(entry.status.error.code))) {
      const code: SimErrorCode = info.spawnError
        ? 'spawn-failed'
        : info.code === 3
          ? 'already-attached'
          : info.code === 4
            ? 'device-not-found'
            : info.code === 5
              ? 'no-xcode'
              : 'helper-exited'
      const detail = info.spawnError ?? lastLine(info.stderrTail)
      entry.status = errorStatus(
        code,
        code === 'helper-exited'
          ? `The simulator helper stopped${info.code !== null ? ` (exit ${info.code})` : ''}${detail ? `: ${detail}` : '.'}`
          : detail || code,
        entry.status.device
      )
      log(`helper for ${entry.udid} ended unexpectedly: ${code}${detail ? ` — ${detail}` : ''}`)
    }
    pushStatus(entry)
    if (entry.viewers.size === 0) devices.delete(entry.udid)
  }

  function scheduleStop(entry: Entry): void {
    if (entry.grace || entry.viewers.size > 0) return
    entry.grace = setTimeout(() => {
      entry.grace = null
      if (entry.viewers.size > 0) return
      stopHelper(entry)
    }, graceMs)
  }

  function stopHelper(entry: Entry): void {
    const helper = entry.helper
    entry.generation++ // whatever the dying process says now is not news
    entry.helper = null
    entry.applied = null
    entry.lastFrame = null
    if (!helper) {
      if (!entry.starting) devices.delete(entry.udid)
      return
    }
    const gone = helper.quit().finally(() => {
      if (entry.gone === gone) entry.gone = null
      if (entry.viewers.size === 0 && !entry.helper && !entry.starting) devices.delete(entry.udid)
    })
    entry.gone = gone
  }

  // ─── the API ────────────────────────────────────────────────────────────────────────────────

  function ensureEntry(udid: string): Entry {
    let entry = devices.get(udid)
    if (!entry) {
      entry = {
        udid,
        helper: null,
        starting: false,
        gone: null,
        generation: 0,
        status: { phase: 'connecting' },
        viewers: new Map(),
        flow: new Map(),
        lastFrame: null,
        applied: null,
        grace: null,
        frameCount: 0,
        lastFrameAt: 0,
        statusTaps: new Set(),
        agentTail: Promise.resolve(),
        agentLinger: null
      }
      devices.set(udid, entry)
    }
    return entry
  }

  function attach(senderId: number, rawUdid: unknown, rawViewerId: unknown, rawView: unknown): SimStatus {
    const udid = normalizeSimUdid(rawUdid)
    if (!udid) return errorStatus('device-not-found', 'That is not a simulator id.')
    const avail = availability()
    if (!avail.ok) return errorStatus(avail.code, avail.message)
    if (typeof rawViewerId !== 'string' || !VIEWER_ID.test(rawViewerId)) {
      return errorStatus('setup-failed', 'Bad viewer id.')
    }
    const entry = ensureEntry(udid)
    if (entry.grace) {
      clearTimeout(entry.grace)
      entry.grace = null
    }
    entry.viewers.set(key(senderId, rawViewerId), { senderId, viewerId: rawViewerId, view: normalizeSimViewOptions(rawView) })
    // A window's first viewer starts it with a clean credit slate (its old acks died with the old
    // page); a second node in the same window must not wipe the first one's in-flight count.
    if (!entry.flow.has(senderId)) entry.flow.set(senderId, { inFlight: 0, sentAt: 0, pending: null, acks: 0 })
    // A fresh viewer on a static screen would otherwise wait for a change to see anything.
    if (entry.lastFrame && entry.status.phase === 'live') deliver(entry, senderId, entry.lastFrame)
    if (!entry.helper && !entry.starting) startHelper(entry)
    else applyStream(entry)
    return entry.status
  }

  function detach(senderId: number, rawUdid: unknown, rawViewerId: unknown): void {
    const udid = normalizeSimUdid(rawUdid)
    const entry = udid ? devices.get(udid) : undefined
    if (!entry || typeof rawViewerId !== 'string') return
    entry.viewers.delete(key(senderId, rawViewerId))
    if (![...entry.viewers.values()].some((v) => v.senderId === senderId)) entry.flow.delete(senderId)
    applyStream(entry)
    if (entry.viewers.size === 0) scheduleStop(entry)
  }

  /**
   * A window's page went away without detaching (reload, crash, close): drop every viewer it held.
   * Viewer ids are per mount, so a reloaded page never reuses them, and without this the dead
   * viewers kept the helper streaming at their last view level for the rest of the app run.
   */
  function dropSender(senderId: number): void {
    for (const entry of [...devices.values()]) {
      let changed = false
      for (const [k, v] of [...entry.viewers]) {
        if (!v.internal && v.senderId === senderId) {
          entry.viewers.delete(k)
          changed = true
        }
      }
      if (!changed) continue
      entry.flow.delete(senderId)
      applyStream(entry)
      if (entry.viewers.size === 0) scheduleStop(entry)
    }
  }

  function setView(senderId: number, rawUdid: unknown, rawViewerId: unknown, rawView: unknown): void {
    const udid = normalizeSimUdid(rawUdid)
    const entry = udid ? devices.get(udid) : undefined
    if (!entry || typeof rawViewerId !== 'string') return
    const viewer = entry.viewers.get(key(senderId, rawViewerId))
    if (!viewer) return
    viewer.view = normalizeSimViewOptions(rawView)
    applyStream(entry)
  }

  /** The device and helper a sender may drive: it must itself be a viewer of that device. */
  function drivable(senderId: number, rawUdid: unknown): SimHelper | null {
    const udid = normalizeSimUdid(rawUdid)
    const entry = udid ? devices.get(udid) : undefined
    if (!entry?.helper?.running) return null
    if (![...entry.viewers.values()].some((v) => v.senderId === senderId)) return null
    return entry.helper
  }

  async function command(senderId: number, rawUdid: unknown, raw: unknown): Promise<SimReply> {
    const checked = sanitizeSimCommand(raw)
    if (!checked.ok) return { ok: false, code: 'bad-request', error: checked.error }
    const helper = drivable(senderId, rawUdid)
    if (!helper) return { ok: false, code: 'not-running', error: 'The simulator is not connected.' }
    return (await helper.request(checked.cmd)) as SimReply
  }

  async function shot(helper: SimHelper, scale: number): Promise<SimScreenshotReply> {
    const { reply, image } = await helper.requestImage({ cmd: 'screenshot', format: 'png', scale })
    if (!reply.ok || !image) {
      return {
        ok: false,
        code: typeof reply.code === 'string' ? reply.code : 'screenshot-failed',
        error: typeof reply.error === 'string' ? reply.error : 'The screenshot failed.'
      }
    }
    // A Buffer's backing store may be a shared pool; hand the caller exactly these bytes.
    return {
      ok: true,
      format: image.format,
      width: image.width,
      height: image.height,
      data: new Uint8Array(image.data)
    }
  }

  async function screenshot(senderId: number, rawUdid: unknown): Promise<SimScreenshotReply> {
    const helper = drivable(senderId, rawUdid)
    if (!helper) return { ok: false, code: 'not-running', error: 'The simulator is not connected.' }
    return shot(helper, 1)
  }

  function input(senderId: number, rawUdid: unknown, raw: unknown): void {
    const checked = sanitizeSimCommand(raw)
    if (!checked.ok || !isQuietEligible(checked.cmd.cmd)) return
    drivable(senderId, rawUdid)?.fire(checked.cmd)
  }

  // ─── agents: the `sim` canvas-control verb ──────────────────────────────────────────────────
  //
  // An agent drives a device through the SAME helper the node watches — never a second process (the
  // helper holds a per-device lock, and one input queue is the whole reason two drivers would
  // interfere). It joins as an INTERNAL viewer: no window to lose, no frames sent to it, but it
  // counts in the refcount and asks for a stream so the screen-settle wait can see changes.
  //
  // Calls on one device run one at a time. The viewer lingers {@link AGENT_LINGER_MS} after the
  // last call (stream off) so a script of calls does not pay a helper restart (~1 s) between each.

  const AGENT_SENDER = -1
  const AGENT_VIEWER = 'agent'
  const agentKey = key(AGENT_SENDER, AGENT_VIEWER)

  function waitLive(entry: Entry, timeoutMs: number, tolerateShutdown: boolean): Promise<AgentFailure | null> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (v: AgentFailure | null): void => {
        if (timer) clearTimeout(timer)
        entry.statusTaps.delete(check)
        resolve(v)
      }
      const shutdown: AgentFailure = {
        ok: false,
        code: 'device-shutdown',
        error: `${entry.status.device?.name ?? 'The simulator'} is shut down.`
      }
      function check(): void {
        const st = entry.status
        if (st.phase === 'live' && entry.helper?.running) return finish(null)
        if (st.phase === 'error') {
          return finish({ ok: false, code: st.error?.code ?? 'setup-failed', error: st.error?.message ?? 'The simulator helper failed.' })
        }
        if (tolerateShutdown) return
        const state = st.device?.state
        if (st.phase === 'shutdown' || (st.phase === 'connecting' && (state === 'Shutdown' || state === 'Shutting Down'))) {
          return finish(shutdown)
        }
      }
      entry.statusTaps.add(check)
      timer = setTimeout(() => {
        const state = entry.status.device?.state
        finish(
          state === 'Shutdown' || state === 'Shutting Down'
            ? shutdown
            : { ok: false, code: 'timeout', error: 'The simulator did not become ready in time.' }
        )
      }, timeoutMs)
      check()
    })
  }

  /**
   * Switching the stream on makes the helper send a frame at once. Let that one land before the
   * first command, or it would arrive after it and read as the screen reacting to an input that has
   * not changed anything. Bounded and fail-open: no frame (a static device that dedupes it, a stream
   * that did not start) costs {@link AGENT_FIRST_FRAME_MS} and nothing else.
   */
  async function firstFrame(entry: Entry, before: number): Promise<void> {
    const end = now() + AGENT_FIRST_FRAME_MS
    while (entry.frameCount === before && now() < end) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, AGENT_IDLE_POLL_MS)
        t.unref?.()
      })
    }
  }

  function waitIdle(
    entry: Entry,
    markFrames: number,
    opts: { quietMs: number; timeoutMs: number; reactionMs?: number }
  ): Promise<{ idle: boolean; waitedMs: number; changed: boolean }> {
    return new Promise((resolve) => {
      const start = now()
      // After an input the count runs from when it was SENT (frames during a long swipe are changes);
      // a bare wait only counts what happens from now.
      const framesBefore = opts.reactionMs !== undefined ? markFrames : entry.frameCount
      const finish = (idle: boolean): void => {
        resolve({ idle, waitedMs: now() - start, changed: entry.frameCount > framesBefore })
      }
      const tick = (): void => {
        const t = now()
        if (t - start >= opts.timeoutMs) return finish(false)
        if (entry.frameCount > framesBefore) {
          if (t - Math.max(entry.lastFrameAt, start) >= opts.quietMs) return finish(true)
        } else {
          // Nothing has moved yet: quiet counts from the start, and an input gets its reaction time.
          const needed = opts.reactionMs !== undefined ? Math.max(opts.quietMs, opts.reactionMs) : opts.quietMs
          if (t - start >= needed) return finish(true)
        }
        // A short poll rather than a computed wake-up: a frame can arrive at any moment and move the
        // deadline, and this only ever runs inside one bounded call.
        const timer = setTimeout(tick, AGENT_IDLE_POLL_MS)
        timer.unref?.()
      }
      tick()
    })
  }

  function releaseAgent(entry: Entry): void {
    const viewer = entry.viewers.get(agentKey)
    if (!viewer) return
    viewer.view = { level: 'off' }
    applyStream(entry)
    entry.agentLinger = setTimeout(() => {
      entry.agentLinger = null
      entry.viewers.delete(agentKey)
      applyStream(entry)
      if (entry.viewers.size === 0) scheduleStop(entry)
    }, AGENT_LINGER_MS)
    entry.agentLinger.unref?.()
  }

  async function leased<T>(
    entry: Entry,
    opts: AgentRunOptions,
    fn: (device: AgentDevice) => Promise<T>
  ): Promise<{ ok: true; value: T } | AgentFailure> {
    if (entry.agentLinger) {
      clearTimeout(entry.agentLinger)
      entry.agentLinger = null
    }
    if (entry.grace) {
      clearTimeout(entry.grace)
      entry.grace = null
    }
    const framesAtLease = entry.frameCount
    const alreadyStreaming = !!entry.applied && entry.applied.maxFps > 0 // a node is watching: no first-frame burst to wait for
    entry.viewers.set(agentKey, {
      senderId: AGENT_SENDER,
      viewerId: AGENT_VIEWER,
      view: { level: 'active', scale: AGENT_STREAM_SCALE },
      internal: true
    })
    if (!entry.helper && !entry.starting) startHelper(entry)
    else applyStream(entry)
    try {
      const failed = await waitLive(entry, opts.connectTimeoutMs, opts.tolerateShutdown === true)
      if (failed) return failed
      if (!alreadyStreaming) await firstFrame(entry, framesAtLease)
      const helper = (): SimHelper | null => (entry.helper?.running ? entry.helper : null)
      let markFrames = entry.frameCount
      const device: AgentDevice = {
        status: () => entry.status,
        command: async (raw) => {
          const checked = sanitizeSimCommand(raw)
          if (!checked.ok) return { ok: false, code: 'bad-request', error: checked.error }
          const h = helper()
          if (!h) return { ok: false, code: 'not-running', error: 'The simulator is not connected.' }
          if (isQuietEligible(checked.cmd.cmd)) markFrames = entry.frameCount // an input: count changes from here
          return (await h.request(checked.cmd)) as SimReply
        },
        screenshot: async (scale) => {
          const h = helper()
          if (!h) return { ok: false, code: 'not-running', error: 'The simulator is not connected.' }
          return shot(h, scale)
        },
        waitIdle: (o) => waitIdle(entry, markFrames, o)
      }
      return { ok: true, value: await fn(device) }
    } finally {
      releaseAgent(entry)
    }
  }

  function agentRun<T>(
    rawUdid: unknown,
    opts: AgentRunOptions,
    fn: (device: AgentDevice) => Promise<T>
  ): Promise<{ ok: true; value: T } | AgentFailure> {
    const udid = normalizeSimUdid(rawUdid)
    if (!udid) return Promise.resolve({ ok: false, code: 'device-not-found', error: 'That is not a simulator id.' })
    const avail = availability()
    if (!avail.ok) return Promise.resolve({ ok: false, code: avail.code, error: avail.message })
    const entry = ensureEntry(udid)
    const job = entry.agentTail.then(() => leased(entry, opts, fn))
    entry.agentTail = job.catch(() => undefined)
    return job
  }

  async function bootDevice(rawUdid: unknown): Promise<{ ok: boolean; error?: string }> {
    const udid = normalizeSimUdid(rawUdid)
    if (!udid) return { ok: false, error: 'That is not a simulator id.' }
    if (!deps.isDarwin) return { ok: false, error: 'The iOS Simulator needs macOS with Xcode installed.' }
    return deps.boot(udid)
  }

  /** Quit every helper now (app quit). stdin EOF would end them anyway if the process died first. */
  async function dispose(): Promise<void> {
    const waits: Promise<void>[] = []
    for (const entry of [...devices.values()]) {
      if (entry.grace) clearTimeout(entry.grace)
      if (entry.agentLinger) clearTimeout(entry.agentLinger)
      entry.viewers.clear()
      const helper = entry.helper
      entry.helper = null
      entry.generation++
      if (helper) waits.push(helper.quit())
    }
    devices.clear()
    await Promise.all(waits)
  }

  return {
    availability,
    devices: (): Promise<SimDevicesResult> => (availability().ok ? deps.listDevices() : Promise.resolve({ devices: [] })),
    attach,
    detach,
    dropSender,
    setView,
    command,
    screenshot,
    input,
    ackFrame,
    boot: bootDevice,
    /** Run `fn` against a device as the core's own agent viewer (see the section above). */
    agentRun,
    dispose,
    /** Test seam: the device ids with a live entry. */
    activeDevices: (): string[] => [...devices.keys()]
  }
}

export type SimService = ReturnType<typeof createSimService>

function asErrorCode(code: string): SimErrorCode {
  const known: readonly SimErrorCode[] = [
    'unsupported',
    'no-helper',
    'no-xcode',
    'already-attached',
    'device-not-found',
    'spawn-failed',
    'helper-exited',
    'setup-failed',
    'stream-failed'
  ]
  return (known as readonly string[]).includes(code) ? (code as SimErrorCode) : 'setup-failed'
}

function lastLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  return (lines[lines.length - 1] ?? '').slice(0, 200)
}

// ─── Registration (the desktop shell) ─────────────────────────────────────────────────────────

/**
 * Wires the service to the platform's IPC table. Called by the DESKTOP shell only: the Server
 * Edition does not register it, so its `sim:*` calls reach the ws-bridge stub and answer
 * `unsupported` (a browser tab has no business driving the server's simulator, and the helper is
 * macOS-only anyway).
 */
let registered: SimService | null = null

/** App quit: stop every helper (they also end by themselves on stdin EOF if we die first). */
export function disposeSim(): void {
  void registered?.dispose()
}

export function registerSimIpc(): SimService {
  const p = platform()
  const service = createSimService({
    isDarwin: process.platform === 'darwin',
    helperPath: () =>
      simHelperPath({ resourcesPath: p.resourcesPath, repoRoot: process.cwd(), exists: (f) => fs.existsSync(f) }),
    spawn: (bin, args) => nodeSpawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as HelperChild,
    listDevices: async () => {
      const list = await listSimulators()
      return {
        devices: list.map((d) => ({
          udid: d.id,
          name: d.name,
          runtime: d.platform ?? 'iOS',
          booted: d.state === 'booted'
        }))
      }
    },
    boot: bootSimulatorHeadless,
    send: (id, channel, ...args) => p.sendTo(id, channel, ...args),
    clientIds: () => p.clientIds()
  })
  p.handle(IPC.simAvailability, () => service.availability())
  p.handle(IPC.simDevices, () => service.devices())
  p.handleWithSender(IPC.simAttach, (sender, udid, viewerId, view) => service.attach(sender, udid, viewerId, view))
  p.onWithSender(IPC.simDetach, (sender, udid, viewerId) => service.detach(sender, udid, viewerId))
  p.onWithSender(IPC.simView, (sender, udid, viewerId, view) => service.setView(sender, udid, viewerId, view))
  p.handle(IPC.simBoot, (udid) => service.boot(udid))
  p.handleWithSender(IPC.simCommand, (sender, udid, cmd) => service.command(sender, udid, cmd))
  p.handleWithSender(IPC.simScreenshot, (sender, udid) => service.screenshot(sender, udid))
  p.onWithSender(IPC.simInput, (sender, udid, cmd) => service.input(sender, udid, cmd))
  p.onWithSender(IPC.simFrameAck, (sender, udid) => service.ackFrame(sender, udid))
  registered = service
  return service
}
