/**
 * The two decisions that keep `boot` from racing, kept pure so they can be tested without an
 * emulator (main.ts is process-bound).
 */

/** Share one in-flight run between overlapping callers; a call after it settles starts a new one. */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  return () => {
    if (inFlight) return inFlight
    const p = fn().finally(() => {
      if (inFlight === p) inFlight = null
    })
    inFlight = p
    return p
  }
}

export interface BootFacts {
  /** The emulator the monitor last adopted (up to a poll interval old), or null. */
  adoptedPid: number | null
  /** Is that pid still listed in the emulator discovery files with a live process? */
  adoptedStillRunning: boolean
  /** Any running emulator for this AVD that the monitor has not adopted yet. */
  otherRunningForAvd: boolean
  /** The `emulator` child we launched earlier is still alive. */
  bootChildAlive: boolean
}

export interface BootDecision {
  /** The adopted emulator is gone: drop it (and report Shutdown) before anything else. */
  dropStale: boolean
  action: 'already-running' | 'booting' | 'spawn'
}

export function decideBoot(f: BootFacts): BootDecision {
  const stale = f.adoptedPid !== null && !f.adoptedStillRunning
  if (f.adoptedPid !== null && f.adoptedStillRunning) return { dropStale: false, action: 'already-running' }
  // Launching while one runs only loses the AVD lock, so a not-yet-adopted emulator counts as running.
  if (f.otherRunningForAvd) return { dropStale: stale, action: 'already-running' }
  if (f.bootChildAlive) return { dropStale: stale, action: 'booting' }
  return { dropStale: stale, action: 'spawn' }
}

/** How long after answering a boot request with "already running" a vanishing emulator still counts as a lost boot. */
export const REBOOT_WINDOW_MS = 15_000

/**
 * An emulator that is being killed stays alive and listed for a few seconds, so a `boot` that lands in
 * that window is (correctly, as far as the snapshot goes) answered "already running" and then the
 * emulator finishes dying with nobody left to boot it. If it disappears inside the window and no
 * launch of ours is running, the acknowledged boot request is still owed: boot again.
 */
export function owesReboot(f: { answeredAt: number | null; now: number; stopping: boolean; bootChildAlive: boolean }): boolean {
  if (f.answeredAt === null || f.stopping || f.bootChildAlive) return false
  return f.now - f.answeredAt <= REBOOT_WINDOW_MS
}
