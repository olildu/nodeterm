import type { Terminal } from '@xterm/xterm'

/**
 * Trims every buffer line to the terminal's width after a narrowing resize, which xterm only does
 * for a buffer that reflows.
 *
 * `Buffer.resize` cuts the cells past the new right edge inside its `_isReflowEnabled` branch, and
 * reflow needs scrollback: the ALTERNATE buffer never has any, so its lines keep their old length
 * (still true on xterm.js master). Nothing draws those cells, but two things read them:
 *
 * 1. **The search addon.** It reads each line to its stored length, finds text that is no longer on
 *    screen, and for a hit past the edge computes a decoration width of `cols - col` — negative.
 *    `registerDecoration` throws "This API only accepts positive integers", and since the find bar
 *    runs `findNext` inside a React effect, the node's error boundary replaced the whole node with
 *    an error card. Every Claude Code node is on the alternate screen, so narrowing one node and
 *    then searching in it was enough. Measured with xterm 5.5.0 + addon-search 0.16.0.
 * 2. **A later widening.** `BufferLine.resize` grows a line over its old cells, so widening back
 *    brought the cut-off text back on screen until the app repainted the row.
 *
 * Trimming is what xterm already does to a reflowing buffer, and a trimmed cell is one nothing
 * displays, so for the visible screen this changes nothing.
 *
 * Guarded and fail-open in the same style as `patchViewportScrollSync`: if a private field is
 * missing on a future xterm version, the patch leaves stock behavior intact.
 */
interface BufferLineLike {
  length: number
  resize(cols: number, fillCellData: unknown): boolean
}

interface BufferLike {
  lines: { length: number; get(index: number): BufferLineLike | undefined }
  getNullCell(): unknown
}

interface CoreLike {
  buffers?: { normal?: BufferLike; alt?: BufferLike }
  __ntShrinkTrimPatched?: boolean
}

function trimBuffer(buffer: BufferLike | undefined, cols: number): void {
  if (!buffer) return
  const fill = buffer.getNullCell()
  for (let i = 0; i < buffer.lines.length; i++) {
    const line = buffer.lines.get(i)
    if (line && line.length > cols) line.resize(cols, fill)
  }
}

export function patchShrinkTrim(term: Terminal): boolean {
  try {
    const core = (term as unknown as { _core?: CoreLike })._core
    const buffers = core?.buffers
    if (
      !core ||
      !buffers ||
      typeof buffers.alt?.getNullCell !== 'function' ||
      typeof buffers.alt.lines?.get !== 'function' ||
      typeof term.onResize !== 'function'
    ) {
      return false
    }
    if (core.__ntShrinkTrimPatched) return true
    core.__ntShrinkTrimPatched = true
    let cols = term.cols
    term.onResize(({ cols: next }) => {
      const narrowed = next < cols
      cols = next
      if (!narrowed) return
      try {
        // Only the alternate buffer: the normal one reflows whenever it has scrollback, which
        // xterm trims itself. Our terminals never set `scrollback: 0` or `windowsPty` (the two
        // things that turn reflow off), so walking the normal buffer here would only be waste.
        // `onResize` fires synchronously right after `buffers.resize`, before any render.
        trimBuffer(core.buffers?.alt, next)
      } catch {
        // Fail open: an untrimmed line is the stock behavior, never worse.
      }
    })
    return true
  } catch {
    return false
  }
}
