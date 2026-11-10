// Process-death and hang telemetry for the debug log ring.
//
// Before this, the only process-death handler was the main window's `render-process-gone`, and
// it logged nothing: a GPU-process crash, a utility-process OOM or a multi-second renderer hang
// left no trace anywhere a user could copy out of the app. These helpers only FORMAT a line and
// keep a cheap per-session count; `index.ts` emits it through `console.*` with a `[tag]` prefix,
// which is the log-sink convention (`core/log-sink.ts`) — the ring gets it, redacted, and the dev
// terminal still sees it.
//
// OBSERVE, NEVER ACT. Nothing here reloads, relaunches or kills anything. Chromium respawns a
// dead GPU process itself; relaunching on top of that would turn a recoverable GPU reset into a
// lost session (and repeated GPU deaths can trip Chromium's per-domain
// 3D-API block "until restart", so anything that provokes more of them degrades the session).
//
// Electron-free on purpose (structural types only) so it unit-tests without an Electron runtime.

export type HealthLevel = 'info' | 'warn'

export interface HealthLine {
  level: HealthLevel
  msg: string
}

/** The subset of Electron's `Details` (app 'child-process-gone') we read. */
export interface ChildProcessGoneDetails {
  type: string
  reason: string
  exitCode: number
  name?: string
  serviceName?: string
}

/**
 * Format app 'child-process-gone' and count it per process type for the session. Returns a
 * stateful formatter so the count lives with the app, not in a module global a test would leak.
 *
 * Only `{type, reason, exitCode, name}`. `name` / `serviceName` are
 * Chromium's fixed service labels ("Audio Service", "Network Service"), never a path or argv.
 *
 * Level: a `clean-exit` is Chromium tearing down a utility process it no longer needs — routine,
 * so `info`, or the ring would fill with non-events. Every other reason (crashed, oom, killed,
 * abnormal-exit, launch-failed, integrity-failure, memory-eviction) is a real death → `warn`.
 */
export function createChildProcessGoneLog(): (d: ChildProcessGoneDetails) => HealthLine {
  const counts = new Map<string, number>()
  return (d) => {
    const n = (counts.get(d.type) ?? 0) + 1
    counts.set(d.type, n)
    const label = d.name || d.serviceName
    const who = label ? `${d.type} (${label})` : d.type
    return {
      level: d.reason === 'clean-exit' ? 'info' : 'warn',
      msg: `${who} process gone: reason=${d.reason} exitCode=${d.exitCode} — #${n} ${d.type} this session`
    }
  }
}

/** Format webContents 'render-process-gone' — the existing crash-reload handler's trace line. */
export function formatRenderProcessGone(d: { reason: string; exitCode: number }): HealthLine {
  return {
    level: d.reason === 'clean-exit' ? 'info' : 'warn',
    msg: `renderer process gone: reason=${d.reason} exitCode=${d.exitCode}`
  }
}

export interface HangTracker {
  /** BrowserWindow 'unresponsive'. Returns the line to log, or null for a repeat while hung. */
  unresponsive(now: number): HealthLine | null
  /** BrowserWindow 'responsive'. Returns the line to log, or null if we never saw it hang. */
  responsive(now: number): HealthLine | null
  /** The renderer died ('render-process-gone'): an open hang ends unmeasured. The session's hang
   *  count is kept. */
  reset(): void
}

/**
 * Pair BrowserWindow 'unresponsive' / 'responsive' into one hang with a duration. Electron fires
 * 'unresponsive' only after its own hang timeout (several seconds of no input ack), so the
 * logged duration is "from the hang being declared", a lower bound on the real stall — said in
 * the message so nobody reads it as the whole freeze.
 *
 * Edges: a second 'unresponsive' before a 'responsive' keeps the FIRST timestamp (one hang, not
 * two); a 'responsive' with no open hang (listener attached mid-hang, or a reload reset) logs
 * nothing — a duration we cannot measure is not reported as zero.
 */
export function createHangTracker(): HangTracker {
  let since: number | null = null
  let hangs = 0
  return {
    unresponsive(now) {
      if (since !== null) return null
      since = now
      hangs++
      return { level: 'warn', msg: `window unresponsive — hang #${hangs} this session` }
    },
    responsive(now) {
      if (since === null) return null
      const ms = Math.max(0, now - since)
      since = null
      return {
        level: 'warn',
        msg: `window responsive again after ${ms} ms (counted from Electron's hang timeout, so the real stall was longer) — hang #${hangs}`
      }
    },
    reset() {
      // A hung page that dies never acks again, so without this the reloaded page's first hang
      // would read as a repeat of the dead one, and its 'responsive' would report a duration
      // spanning the crash.
      since = null
    }
  }
}
