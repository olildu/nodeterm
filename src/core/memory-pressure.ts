// Two-signal memory pressure (cmux's MemoryPressureMonitor pattern, Electron-free): host
// available-memory watermarks (readMemInfo — the same source session-budget trusts, except on
// darwin, where it is not measuring what its name says; see hostMemReader) plus this process's
// own RSS, because the host signal alone can't tell you YOU are the problem.
// Consumers hang reclaim levers off onPressure; all levers must be idempotent — the monitor
// re-fires a held severity at most once per RE_FIRE_FLOOR_MS.
//
// A THIRD leg, darwin only: the kernel's own pressure level (`kern.memorystatus_vm_pressure_level`,
// the number Activity Monitor's pressure graph colours). With the host leg silent there and main's
// RSS at 63-200 MB against a 4096 MB threshold, the two legs above never fire on macOS, so the
// renderer's reclaim levers (`releaseAllHiddenGrants` + the park drop) never ran while the window
// was visible — #179 removed the timed hidden-context release on the promise that these would.
// Measured (2026-10, dev build): the lever pair on 12 hidden warm terminals took the GPU
// process footprint 331 → 152 MB and IOSurface 235 → 91 MB; panning back re-granted all 12.
// This leg is deliberately NOT part of check()/onPressure:
//  - it fires on TRANSITIONS into warn/critical only, never on a held level. The 60 s re-fire
//    floor above at a held WARN (which a Mac can sit in for hours) would be #179's timed release
//    again, pan-back flicker included. A level that FLAPS (normal, warn, normal, warn — the
//    measured Mac moved between 1 and 2) is the same timed release by another route, so a run at
//    the same or a lower severity as the last one also waits out KERNEL_LEVER_GAP_MS; only an
//    escalation above the last run's severity (warning → critical) fires inside the gap;
//  - it never goes through hostMemReader/MemInfo, which the reaper's planReap shares — a kernel
//    WARN must not become a byte watermark the reaper culls detached sessions on (#135/#136/#137);
//  - it reports through its own callback, so a shell decides separately whether a kernel CRITICAL
//    also sweeps the reaper. Neither shell does yet: that step is to be measured on its own (#211).
import { execFile } from 'child_process'
import { hostMemReader, type MemInfo } from './session-budget'

export { hostMemReader }

export type PressureSeverity = 'warning' | 'critical'

export const PRESSURE_INTERVAL_MS = 30_000
export const RE_FIRE_FLOOR_MS = 60_000
export const SELF_RSS_WARN_MB = 4096
export const SELF_RSS_CRIT_MB = 8192
/** Minimum time between two kernel-leg lever runs at the same or a lower severity. Each fall to
 *  `normal` re-arms the leg, so without it a level alternating normal/warn would release every
 *  hidden WebGL context and drop the parks about once a minute. */
export const KERNEL_LEVER_GAP_MS = 10 * 60_000

/** macOS's own pressure level, as `kern.memorystatus_vm_pressure_level` reports it. */
export type KernelPressureLevel = 'normal' | 'warn' | 'critical'

/** sysctl's answer is a single integer: 1 normal, 2 warn, 4 critical (the kernel's
 *  `kVMPressure*` values). Anything else — 0, empty, junk — is "could not read", never a level. */
export function parseKernelPressureLevel(stdout: string): KernelPressureLevel | null {
  switch (stdout.trim()) {
    case '1':
      return 'normal'
    case '2':
      return 'warn'
    case '4':
      return 'critical'
    default:
      return null
  }
}

const KERNEL_RANK: Record<KernelPressureLevel, number> = { normal: 0, warn: 1, critical: 2 }

export type KernelLevelExec = (cb: (err: Error | null, stdout: string) => void) => void

const sysctlPressureLevel: KernelLevelExec = (cb) => {
  execFile('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 5_000 }, (err, stdout) =>
    cb(err, String(stdout))
  )
}

/**
 * The kernel-level reader: synchronous to its caller, asynchronous underneath, in the
 * `pty-devices.ts` primePtyCeiling pattern — each call returns the last reading that LANDED and
 * kicks one background `sysctl` (never two in flight). The monitor calls it once per 30 s tick, so
 * that is one tiny subprocess per tick, the same cost class as the RAM pill's 30 s host read; a
 * transition is therefore seen at most one tick late, which is fine for a lever that frees idle
 * warmth. Closure state, not module state, so tests (and two monitors) never share a cache.
 *
 * Off darwin there is no such sysctl, so the reader is absent (`null`) and the leg does not exist.
 * A failed or unparseable read lands as `null` — no information, never pressure.
 */
export function kernelPressureReader(
  platform: NodeJS.Platform = process.platform,
  exec: KernelLevelExec = sysctlPressureLevel
): (() => KernelPressureLevel | null) | null {
  if (platform !== 'darwin') return null
  let last: KernelPressureLevel | null = null
  let inFlight = false
  return () => {
    if (!inFlight) {
      inFlight = true
      try {
        exec((err, stdout) => {
          inFlight = false
          last = err ? null : parseKernelPressureLevel(stdout)
        })
      } catch {
        inFlight = false // a spawn that throws synchronously is a failed read, not a crash
        last = null
      }
    }
    return last
  }
}


export interface MemoryPressureMonitor {
  start(): void
  stop(): void
  /** One classification pass; null = no pressure (including "could not read"). */
  check(): PressureSeverity | null
  /** The kernel leg's held level (darwin); `normal` until a reading says otherwise. */
  kernelLevel(): KernelPressureLevel
}

export function createMemoryPressureMonitor(opts: {
  readMem?: () => MemInfo | null
  selfRssMb?: () => number
  intervalMs?: number
  onPressure: (s: PressureSeverity) => void
  /** The kernel-level reader; defaults to `kernelPressureReader()` (absent off darwin). `null`
   *  switches the leg off. */
  readKernelLevel?: (() => KernelPressureLevel | null) | null
  /** Fired on an ESCALATION of the kernel level (normal→warn, →critical), never on a held or
   *  falling level, and at the same or a lower severity than the last run only once
   *  KERNEL_LEVER_GAP_MS has passed since it. No callback ⇒ the leg is not sampled at all. */
  onKernelPressure?: (s: PressureSeverity) => void
  log?: (m: string) => void
}): MemoryPressureMonitor {
  const readMem = opts.readMem ?? hostMemReader()
  const readKernel =
    opts.onKernelPressure === undefined
      ? null
      : opts.readKernelLevel === undefined
        ? kernelPressureReader()
        : opts.readKernelLevel
  const log = opts.log ?? ((m: string): void => console.log(m))
  // `memoryUsage.rss()` reads just the one number; `memoryUsage()` builds the whole stats object
  // (heap walk included) every 30 s for a field we throw away.
  const selfRss = opts.selfRssMb ?? ((): number => Math.round(process.memoryUsage.rss() / 1048576))
  let timer: ReturnType<typeof setInterval> | null = null
  let lastFired = 0
  // Starting at `normal` is what makes a healthy Mac silent (no transition to report) and what
  // makes a launch INTO an already-pressured machine fire once.
  let kernelHeld: KernelPressureLevel = 'normal'
  // The last kernel-leg lever run: when, and at which level. Only a run moves these.
  let kernelRanAt: number | null = null
  let kernelRanLevel: KernelPressureLevel = 'normal'

  const check = (): PressureSeverity | null => {
    const rss = selfRss()
    const m = readMem()
    // A failed read is never evidence of pressure; self-RSS still counts.
    const hostCrit = m !== null && m.availableMb < m.totalMb * 0.05
    const hostWarn = m !== null && m.availableMb < m.totalMb * 0.1
    if (hostCrit || rss > SELF_RSS_CRIT_MB) return 'critical'
    if (hostWarn || rss > SELF_RSS_WARN_MB) return 'warning'
    return null
  }

  const kernelTick = (): void => {
    if (!readKernel || !opts.onKernelPressure) return
    const level = readKernel()
    // A failed read is no information: it neither fires nor resets the held level, so a
    // warn → (failed read) → warn sequence is still ONE lever run.
    if (level === null || level === kernelHeld) return
    const from = kernelHeld
    kernelHeld = level
    log(`[memory-pressure] kernel level ${from} -> ${level}`)
    // Escalations only. A falling level runs nothing: the levers already ran on the way up, and
    // whatever has re-granted since is warmth the user just panned back to.
    if (KERNEL_RANK[level] <= KERNEL_RANK[from]) return
    const now = Date.now()
    if (
      kernelRanAt !== null &&
      KERNEL_RANK[level] <= KERNEL_RANK[kernelRanLevel] &&
      now - kernelRanAt < KERNEL_LEVER_GAP_MS
    ) {
      log(`[memory-pressure] kernel ${level}: levers ran ${Math.round((now - kernelRanAt) / 1000)} s ago, skipping`)
      return
    }
    kernelRanAt = now
    kernelRanLevel = level
    const severity: PressureSeverity = level === 'critical' ? 'critical' : 'warning'
    log(`[memory-pressure] kernel ${level}: running reclaim levers (${severity})`)
    try {
      opts.onKernelPressure(severity)
    } catch (e) {
      console.warn('[memory-pressure] onKernelPressure threw', e)
    }
  }

  return {
    check,
    kernelLevel: () => kernelHeld,
    start(): void {
      if (timer) return
      // Prime the reader so the first tick compares a real reading, not the empty cache.
      readKernel?.()
      timer = setInterval(() => {
        kernelTick()
        const s = check()
        if (!s) return
        const now = Date.now()
        if (now - lastFired < RE_FIRE_FLOOR_MS) return
        lastFired = now
        // A consumer throw must never take the shell down with it — the responders run in a
        // shell (`webContents.send` on a destroyed window, a reaper sweep) and this timer is the
        // only thing on the stack. Log and keep the monitor alive, like session-budget's sweep.
        try {
          opts.onPressure(s)
        } catch (e) {
          console.warn('[memory-pressure] onPressure threw', e)
        }
      }, opts.intervalMs ?? PRESSURE_INTERVAL_MS)
      timer.unref?.()
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
    }
  }
}
