import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const TERMINAL_SRC = fs.readFileSync(path.join(__dirname, 'TerminalNode.tsx'), 'utf8')

describe('TerminalNode global kanban sizing', () => {
  it('parks the canvas size vote while the global kanban overlay is open', () => {
    const start = TERMINAL_SRC.indexOf('const boardOpen = useViewMode(')
    const end = TERMINAL_SRC.indexOf('const boardOpenRef', start)
    const boardOpen = TERMINAL_SRC.slice(start, end)

    // The modal is a co-attached viewer. If the hidden canvas node keeps voting, the PTY uses its
    // smaller grid (usually 80 columns) instead of the visible modal's measured width.
    expect(boardOpen).toContain('s.globalKanban')
    expect(boardOpen).toContain('omniKanbanEnabled')
  })
})

describe('TerminalNode board render pause wiring', () => {
  // The same `boardOpen` (Omni included) also stops xterm DRAWING under the board. The behaviour —
  // a node mounted under the board resumes when it closes, release restores xterm's handler, a
  // stale run cannot detach a newer one — is tested on the slot itself with a fake terminal
  // (`terminal/board-render-pause.test.ts`). This only pins that the node USES the slot: matched on
  // the source with comments stripped, so a call that survives only inside a comment fails.
  const CODE = stripComments(TERMINAL_SRC)

  it('attaches per lifecycle run with the board flag, except for the focus-mode node', () => {
    const attach = CODE.slice(CODE.indexOf('const releaseBoardPause = boardPauseSlot.attach('))
    const call = attach.slice(0, attach.indexOf('})') + 2)
    expect(call).toContain('covered: () => boardOpenRef.current && focusedNodeId() !== id')
    expect(call).toContain('onUncover: fullRepaint')
  })

  it('releases from the run\'s cleanup, before a park keeps the xterm', () => {
    expect(CODE.match(/\breleaseBoardPause\(\)/g)).toHaveLength(1)
  })

  it('syncs after the board flag moves and when focus mode moves', () => {
    const effect = CODE.slice(CODE.indexOf('boardOpenRef.current = boardOpen'))
    const body = effect.slice(0, effect.indexOf('}, [boardOpen])'))
    expect(body.indexOf('boardPauseSlot.sync()')).toBeGreaterThan(0)
    const focus = CODE.slice(CODE.indexOf('subscribeFocusedNode(() => {'))
    expect(focus.slice(0, focus.indexOf('[]'))).toContain('boardPauseSlot.sync()')
  })

  it('never feeds the visibility verdict (budget, hibernation, offscreen teardown)', () => {
    const report = CODE.slice(CODE.indexOf('const reportVisible = (visible: boolean): void => {'))
    const body = report.slice(0, report.indexOf('visibilityReportRef.current = reportVisible'))
    expect(body).not.toContain('boardOpen')
    expect(body).not.toContain('boardPause')
  })
})

/** Block and line comments out, so a pin cannot be satisfied by text that only survives in one.
 *  A `//` right after `:`, a quote or a backslash is kept (URLs, regexes, strings). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}
