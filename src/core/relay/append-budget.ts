// How fast a hosted Commenter may append to a board log (security audit F3, 2026-10).
//
// A board log keeps ONE rotated generation (board-log.ts `MAX_BOARD_LOG_BYTES`, 4 MiB): a Commenter
// that appends fast enough rotates the project's real history out of reach, irrecoverably, for the
// whole team. The access policy already reduces a Commenter's entry to a comment's own fields
// (access-policy.ts `commentEntry`, so one entry is at most ~16 KiB); this bounds the RATE, per peer
// key (so reconnecting does not reset it): one comment every `minIntervalMs`, and at most
// `bytesPerWindow` bytes per `windowMs`. At the defaults a flood needs hours of sustained appending
// to push 8 MiB through, which is long enough for an owner to notice and remove the peer. A comment
// a human types is a few hundred bytes, every few seconds at most, and never meets either limit.
//
// Editors and owners are not limited: Editor is shell access, and a shell can rewrite the file.

export const BOARD_APPEND_MIN_INTERVAL_MS = 2_000
export const BOARD_APPEND_WINDOW_MS = 60_000
export const BOARD_APPEND_BYTES_PER_WINDOW = 32 * 1024

export const BOARD_APPEND_REFUSED = 'You are commenting too fast. Wait a moment and try again.'

export interface AppendBudget {
  /** May an append of `bytes` go through now? A refusal spends nothing. */
  admit(bytes: number): boolean
}

export interface AppendBudgetOptions {
  minIntervalMs?: number
  windowMs?: number
  bytesPerWindow?: number
  /** Monotonic ms. Default `performance.now`, so a wall-clock step cannot refill the budget. */
  now?: () => number
}

export function createAppendBudget(opts: AppendBudgetOptions = {}): AppendBudget {
  const minInterval = opts.minIntervalMs ?? BOARD_APPEND_MIN_INTERVAL_MS
  const windowMs = opts.windowMs ?? BOARD_APPEND_WINDOW_MS
  const cap = opts.bytesPerWindow ?? BOARD_APPEND_BYTES_PER_WINDOW
  const now = opts.now ?? (() => performance.now())
  const spent: Array<{ at: number; bytes: number }> = []
  let last = -Infinity
  return {
    admit(bytes) {
      const t = now()
      const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
      if (t - last < minInterval) return false
      while (spent.length > 0 && t - spent[0].at >= windowMs) spent.shift()
      const used = spent.reduce((n, e) => n + e.bytes, 0)
      if (used + size > cap) return false
      spent.push({ at: t, bytes: size })
      last = t
      return true
    }
  }
}

/** Budgets per peer key, bounded (oldest out): a key is a 32-byte public key, so the map cannot grow
 *  past the team's own size in practice; the bound is a guard. */
export function createAppendBudgets(max = 256, opts: AppendBudgetOptions = {}): (key: string) => AppendBudget {
  const byKey = new Map<string, AppendBudget>()
  return (key) => {
    let b = byKey.get(key)
    if (b) return b
    b = createAppendBudget(opts)
    byKey.set(key, b)
    while (byKey.size > max) byKey.delete(byKey.keys().next().value as string)
    return b
  }
}
