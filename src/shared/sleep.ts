/** Resolve after `ms` milliseconds. A plain `setTimeout`, so fake timers in tests control it. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
