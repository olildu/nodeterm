/**
 * Stop a terminal DRAWING while the kanban board covers it, without stopping it PARSING.
 *
 * WHY. The canvas stays mounted under the board on purpose (`display: none` would 0x0-resize every
 * terminal into a tmux SIGWINCH — see the kanban section of CLAUDE.md), and nothing told xterm it
 * was covered: its only pause is its own GEOMETRIC IntersectionObserver (`RenderService`), and a
 * node under an opaque overlay still intersects the viewport. MEASURED (dev build, 12
 * streaming terminals, glass on, 60 s windows): board open over streaming terminals 36.5 % GPU /
 * 15.8 % renderer — no better than the canvas itself (30-32 %) — against 0.0 % / 2.4 % with the same
 * board over SILENT terminals, so essentially all of it was xterm painting output nobody could see
 * (140 RenderDebouncer refreshes per 5 s). Hiding the canvas with `visibility: hidden` measured
 * 35.5 %: CSS does not stop xterm's render service or WebGL's presents. The pause has to be xterm's.
 *
 * HOW: through xterm's OWN pause, never beside it. RenderService already knows how to be paused —
 * `refreshRows` on a paused service just sets `_needsFullRefresh`, renderer resizes queue on
 * `_pausedResizeTask`, and the transition back to intersecting flushes both and re-measures the
 * char size of a terminal that was opened hidden. All of that hangs off ONE method,
 * `_handleIntersectionChange(entry)`, which the observer reaches through `this.` (so an instance
 * property shadows it). We wrap it: the real entry is RECORDED, and what xterm is told is "not
 * intersecting" while covered, else the real entry. Covering and uncovering replay through the same
 * method, so the resume runs xterm's own bookkeeping rather than a copy of it that drifts.
 * Poking `_isPaused` directly would skip exactly that bookkeeping.
 *
 * The parser path is untouched: `term.write` still lands every byte in the buffer while paused, so
 * nothing is lost — the board-up period is one full repaint on the way out.
 *
 * WHAT THIS DOES NOT DO, ON PURPOSE. It never feeds the app's own visibility verdict
 * (`reportVisible` / the WebGL budget's `setVisible` / hibernation / the offscreen teardown):
 * folding the board into that verdict would let the board hibernate or tear down the sessions it
 * is showing cards for. The WebGL context stays held while the
 * board is up; only the draws stop.
 *
 * Private xterm API (`_core._renderService`), exactly as TerminalNode's renderer-swap net and
 * addon-fit already use it. Feature-detected: a build without the method gets no pause (today's
 * behaviour), never a throw.
 */

/** The slice of an IntersectionObserverEntry xterm's handler reads. */
export interface IntersectionVerdict {
  isIntersecting: boolean
  intersectionRatio: number
}

/** The private RenderService surface this module touches. */
export interface PausableRenderService {
  _handleIntersectionChange(entry: IntersectionVerdict): void
}

/** Minimal xterm shape, so the unit test needs no DOM and no real Terminal. */
export interface PausableTerminal {
  _core?: { _renderService?: Partial<PausableRenderService> }
}

/**
 * The decision, alone: should xterm render right now? Paused when covered OR when it is
 * geometrically out of view (xterm's own rule, kept). Exported so the rule is tested by name.
 */
export function renderPaused(covered: boolean, intersecting: boolean): boolean {
  return covered || !intersecting
}

/** An entry's own answer, the way xterm reads it (`isIntersecting` absent → ratio 0 = hidden). */
function intersects(entry: Partial<IntersectionVerdict>): boolean {
  return entry.isIntersecting === undefined ? entry.intersectionRatio !== 0 : entry.isIntersecting
}

const verdict = (intersecting: boolean): IntersectionVerdict => ({
  isIntersecting: intersecting,
  intersectionRatio: intersecting ? 1 : 0
})

export interface BoardRenderPause {
  /** Re-read `covered()` and act on a change. Change-gated: a call that moved nothing is free. */
  sync(): void
  /** Restore xterm's own handler and leave it in its natural (geometric) state. Idempotent. */
  dispose(): void
}

export interface BoardRenderPauseOptions {
  /** Is this terminal covered right now? Read at every sync and at every observer delivery. */
  covered: () => boolean
  /** Covered → uncovered while geometrically on screen: the caller's guaranteed full repaint.
   *  xterm's own resume refresh is debounced and can be swallowed (see `fullRepaint` in
   *  TerminalNode), so the board's exit owes the one that cannot be. */
  onUncover?: () => void
}

/** Marker so a second install on the same render service (a park re-adopt that skipped a
 *  dispose) replaces the first instead of stacking a wrapper on a wrapper. */
const INSTALLED = Symbol('nt.boardRenderPause')

type Wrapped = PausableRenderService & { [INSTALLED]?: BoardRenderPause }

/**
 * Wrap `term`'s render service. Returns null (and changes nothing) when the private method is
 * missing — an xterm upgrade that renamed it degrades to today's behaviour.
 */
export function installBoardRenderPause(
  term: PausableTerminal,
  opts: BoardRenderPauseOptions
): BoardRenderPause | null {
  const rs = term._core?._renderService as Wrapped | undefined
  if (!rs || typeof rs._handleIntersectionChange !== 'function') return null
  // One layer, ever: an earlier controller still attached gives its original back first.
  rs[INSTALLED]?.dispose()
  const hadOwn = Object.prototype.hasOwnProperty.call(rs, '_handleIntersectionChange')
  const ownBefore = rs._handleIntersectionChange
  const original = ownBefore.bind(rs)
  // Seed the geometry from what xterm is ACTING ON right now, read after the earlier controller
  // (if any) handed its real verdict back. Not a blanket `true`: a terminal re-adopted after a park
  // was detached, so its observer already delivered not-intersecting (`_isPaused = true`); reattached
  // still off screen, the observer has nothing new to report, and a `true` seed made the next board
  // cover/uncover UNPAUSE it — streaming output painted off screen until a pan in and out (found in
  // review, reproduced against xterm 5.5's handler). A fresh xterm starts unpaused with no
  // delivery yet, so the same read gives intersecting there. A build without the field: `true`.
  const pausedNow = (rs as { _isPaused?: unknown })._isPaused
  let geometric = typeof pausedNow === 'boolean' ? !pausedNow : true
  let covered = opts.covered()
  let disposed = false

  const apply = (): void => original(verdict(!renderPaused(covered, geometric)))

  const controller: BoardRenderPause = {
    sync(): void {
      if (disposed) return
      const now = opts.covered()
      if (now === covered) return
      covered = now
      apply()
      if (!covered && geometric) opts.onUncover?.()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      if (hadOwn) rs._handleIntersectionChange = ownBefore
      else delete (rs as Partial<Wrapped>)._handleIntersectionChange
      if (rs[INSTALLED] === controller) delete rs[INSTALLED]
      // Hand xterm back the geometry it would have had all along. A no-op when nothing was
      // covered; when something was, it is xterm's own resume (flush + refresh).
      // Replayed on a PARK too, on purpose, even though the element is about to be detached: left
      // paused, a park whose detach and re-adopt land between two observer deliveries (the
      // observer reports changes only at a rendering step) would come back on screen with
      // `_isPaused` stuck true and nothing left to clear it. The cost is a single refresh into a
      // detached element, and the WebGL dispose that follows does its own full refresh anyway.
      if (covered) original(verdict(geometric))
    }
  }

  rs._handleIntersectionChange = (entry: IntersectionVerdict): void => {
    if (disposed) return original(entry)
    geometric = intersects(entry)
    // The board can have opened between syncs (a node mounted under it, an observer delivery
    // racing the view switch), so the observer path re-reads rather than trusting the cache.
    covered = opts.covered()
    if (!covered) return original(entry)
    original(verdict(false))
  }
  rs[INSTALLED] = controller
  // Mounted under a board that is already up (a card's "new session", a project switch onto a
  // board-view project): pause before the first frame rather than waiting for a change.
  if (covered) apply()
  return controller
}

/**
 * Where a terminal node keeps its live session's pause, so the wiring is one tested unit rather
 * than three lines spread over TerminalNode. The lifecycle run `attach`es (the render service only
 * exists once the terminal is open) and calls the release from its cleanup — per run, NOT through
 * `cleanups`, because a park keeps the xterm while this run's closures die with it, so the
 * adopting run must install its own. The board-flag and focus-mode effects only `sync`.
 *
 * The slot is the point: a node mounted while the board is already up is paused at install, and
 * the board closing reaches it only through `sync`, so a controller that never landed in the slot
 * leaves that node frozen on stale content until it is panned off screen and back.
 */
export interface BoardPauseSlot {
  /** Install on `term` for this run and hold the controller. Returns the run's release: dispose,
   *  and clear the slot unless a newer run has attached since. */
  attach(term: PausableTerminal, opts: BoardRenderPauseOptions): () => void
  /** Re-read `covered()` on whatever controller is attached now; nothing attached, nothing done. */
  sync(): void
}

export function createBoardPauseSlot(): BoardPauseSlot {
  let current: BoardRenderPause | null = null
  return {
    attach(term, opts) {
      const pause = installBoardRenderPause(term, opts)
      current = pause
      return () => {
        pause?.dispose()
        if (current === pause) current = null
      }
    },
    sync() {
      current?.sync()
    }
  }
}
