import { describe, expect, it } from 'vitest'
import {
  createBoardPauseSlot,
  installBoardRenderPause,
  renderPaused,
  type IntersectionVerdict,
  type PausableTerminal
} from './board-render-pause'

/**
 * A structural fake of xterm 5.5's RenderService pause machinery — the same three fields and the
 * same `_handleIntersectionChange` body as `node_modules/@xterm/xterm/src/browser/services/
 * RenderService.ts`, with the method on the PROTOTYPE (as in the real class) and the observer
 * reaching it through `this.`, which is what makes an instance property shadow it.
 */
class FakeRenderService {
  _isPaused = false
  _needsFullRefresh = false
  /** Rows actually handed to the renderer — the work the board pause exists to stop. */
  painted = 0
  /** Full refreshes the resume path flushed. */
  resumes = 0
  _handleIntersectionChange(entry: IntersectionVerdict): void {
    this._isPaused = entry.isIntersecting === undefined ? entry.intersectionRatio === 0 : !entry.isIntersecting
    if (!this._isPaused && this._needsFullRefresh) {
      this.resumes++
      this.refreshRows()
      this._needsFullRefresh = false
    }
  }
  refreshRows(): void {
    if (this._isPaused) {
      this._needsFullRefresh = true
      return
    }
    this.painted++
  }
  /** The geometric IntersectionObserver delivering an entry. */
  observe(intersecting: boolean): void {
    this._handleIntersectionChange({ isIntersecting: intersecting, intersectionRatio: intersecting ? 1 : 0 })
  }
}

function fake(): { term: PausableTerminal; rs: FakeRenderService } {
  const rs = new FakeRenderService()
  return { term: { _core: { _renderService: rs as never } }, rs }
}

describe('renderPaused', () => {
  it('pauses when covered, when off screen, and when both', () => {
    expect(renderPaused(false, true)).toBe(false)
    expect(renderPaused(true, true)).toBe(true)
    expect(renderPaused(false, false)).toBe(true)
    expect(renderPaused(true, false)).toBe(true)
  })
})

describe('installBoardRenderPause', () => {
  it('stops painting while covered and keeps the refresh owed (nothing is lost)', () => {
    const { term, rs } = fake()
    let covered = false
    const pause = installBoardRenderPause(term, { covered: () => covered })!
    rs.refreshRows()
    expect(rs.painted).toBe(1)
    covered = true
    pause.sync()
    expect(rs._isPaused).toBe(true)
    // Streaming output while the board is up: every refresh is deferred, none painted.
    for (let i = 0; i < 50; i++) rs.refreshRows()
    expect(rs.painted).toBe(1)
    expect(rs._needsFullRefresh).toBe(true)
  })

  it('resumes through xterm’s own flush on uncover — one full refresh — and asks for the guaranteed repaint', () => {
    const { term, rs } = fake()
    let covered = true
    let repaints = 0
    const pause = installBoardRenderPause(term, { covered: () => covered, onUncover: () => repaints++ })!
    rs.refreshRows()
    rs.refreshRows()
    covered = false
    pause.sync()
    expect(rs._isPaused).toBe(false)
    expect(rs.resumes).toBe(1)
    expect(rs.painted).toBe(1)
    expect(repaints).toBe(1)
  })

  it('pauses at install when mounted under a board that is already up', () => {
    const { term, rs } = fake()
    installBoardRenderPause(term, { covered: () => true })
    expect(rs._isPaused).toBe(true)
  })

  it('an observer delivery while covered cannot unpause (a node mounting under the board)', () => {
    const { term, rs } = fake()
    installBoardRenderPause(term, { covered: () => true })
    rs.observe(true) // xterm's initial "intersecting" entry
    expect(rs._isPaused).toBe(true)
  })

  it('uncovering a terminal that went off screen meanwhile stays paused, with no repaint', () => {
    const { term, rs } = fake()
    let covered = true
    let repaints = 0
    const pause = installBoardRenderPause(term, { covered: () => covered, onUncover: () => repaints++ })!
    rs.observe(false)
    covered = false
    pause.sync()
    expect(rs._isPaused).toBe(true)
    expect(repaints).toBe(0)
    rs.observe(true) // panned back into view: xterm's own resume, untouched
    expect(rs._isPaused).toBe(false)
  })

  it('a terminal re-adopted off screen (already paused, no new observer delivery) stays paused through a cover/uncover', () => {
    // Park re-adopt: the detached element's observer reported not-intersecting BEFORE install,
    // and reattached still off screen it has nothing new to deliver during the wrapper's life.
    const { term, rs } = fake()
    rs.observe(false)
    let covered = false
    let repaints = 0
    const pause = installBoardRenderPause(term, { covered: () => covered, onUncover: () => repaints++ })!
    covered = true
    pause.sync()
    covered = false
    pause.sync()
    expect(rs._isPaused).toBe(true)
    expect(repaints).toBe(0)
    for (let i = 0; i < 10; i++) rs.refreshRows()
    expect(rs.painted).toBe(0) // streaming output off screen: nothing drawn
    pause.dispose()
    expect(rs._isPaused).toBe(true) // dispose hands back the real (off-screen) geometry
    rs.observe(true) // panned into view: xterm's own resume
    expect(rs._isPaused).toBe(false)
    expect(rs.resumes).toBe(1)
  })

  it('leaves xterm’s geometric pause alone when nothing covers it', () => {
    const { term, rs } = fake()
    installBoardRenderPause(term, { covered: () => false })
    rs.observe(false)
    expect(rs._isPaused).toBe(true)
    rs.observe(true)
    expect(rs._isPaused).toBe(false)
  })

  it('sync is change-gated: no repeated replay or repaint for an unmoved board', () => {
    const { term, rs } = fake()
    let covered = false
    let repaints = 0
    const pause = installBoardRenderPause(term, { covered: () => covered, onUncover: () => repaints++ })!
    pause.sync()
    pause.sync()
    expect(repaints).toBe(0)
    covered = true
    pause.sync()
    covered = false
    pause.sync()
    pause.sync()
    expect(repaints).toBe(1)
    expect(rs._isPaused).toBe(false)
  })

  it('dispose restores the prototype method and hands back the real geometry', () => {
    const { term, rs } = fake()
    const pause = installBoardRenderPause(term, { covered: () => true })!
    expect(Object.prototype.hasOwnProperty.call(rs, '_handleIntersectionChange')).toBe(true)
    pause.dispose()
    expect(Object.prototype.hasOwnProperty.call(rs, '_handleIntersectionChange')).toBe(false)
    expect(rs._isPaused).toBe(false)
    pause.dispose() // idempotent
    pause.sync() // inert
    expect(rs._isPaused).toBe(false)
  })

  it('a second install (park re-adopt) replaces the first instead of stacking a wrapper', () => {
    const { term, rs } = fake()
    let firstReads = 0
    installBoardRenderPause(term, { covered: () => (firstReads++, true) })
    const second = installBoardRenderPause(term, { covered: () => false })!
    firstReads = 0
    rs.observe(true)
    expect(firstReads).toBe(0) // the stale controller's predicate is no longer in the chain
    expect(rs._isPaused).toBe(false)
    second.dispose()
    expect(Object.prototype.hasOwnProperty.call(rs, '_handleIntersectionChange')).toBe(false)
  })

  it('returns null and changes nothing when the private method is missing', () => {
    expect(installBoardRenderPause({}, { covered: () => true })).toBeNull()
    expect(installBoardRenderPause({ _core: { _renderService: {} } }, { covered: () => true })).toBeNull()
  })
})

/**
 * The node's wiring, run with a fake terminal: TerminalNode's lifecycle run ATTACHES (and its
 * cleanup releases), and the board-flag and focus-mode effects only SYNC the slot. A slot that
 * never held the run's controller is the bug this pins: a node mounted while the board is up
 * pauses at install, and the board closing must still reach it.
 */
describe('createBoardPauseSlot (TerminalNode wiring)', () => {
  it('a node mounted under the board resumes and repaints when the board closes', () => {
    const { term, rs } = fake()
    const slot = createBoardPauseSlot()
    let board = true
    let repaints = 0
    const release = slot.attach(term, { covered: () => board, onUncover: () => repaints++ })
    expect(rs._isPaused).toBe(true)
    rs.refreshRows()
    expect(rs.painted).toBe(0)

    board = false
    slot.sync() // what the [boardOpen] effect does after writing the ref
    expect(rs._isPaused).toBe(false)
    expect(rs.painted).toBe(1) // the refresh owed while covered was flushed
    expect(repaints).toBe(1)
    release()
  })

  it('release hands xterm its own handler back and leaves nothing for a later sync', () => {
    const { term, rs } = fake()
    const slot = createBoardPauseSlot()
    let board = true
    const release = slot.attach(term, { covered: () => board })
    release()
    expect(Object.prototype.hasOwnProperty.call(rs, '_handleIntersectionChange')).toBe(false)
    expect(rs._isPaused).toBe(false) // a covered pause is handed back, not left stuck
    board = true
    slot.sync()
    rs.observe(true)
    expect(rs._isPaused).toBe(false)
  })

  it('a stale run\'s release never detaches the controller a newer run attached', () => {
    const a = fake()
    const b = fake()
    const slot = createBoardPauseSlot()
    let board = false
    const releaseOld = slot.attach(a.term, { covered: () => board })
    slot.attach(b.term, { covered: () => board })
    releaseOld()
    board = true
    slot.sync()
    expect(b.rs._isPaused).toBe(true)
  })

  it('an xterm without the private method attaches nothing and release is still safe', () => {
    const slot = createBoardPauseSlot()
    const release = slot.attach({ _core: {} }, { covered: () => true })
    expect(() => {
      slot.sync()
      release()
    }).not.toThrow()
  })
})
