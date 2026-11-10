// Turning a screen captured from tmux (`capture-pane -p -e`, LF-separated rows) into bytes an
// emulator can be fed. Pure, so the renderer's xterm seeding and main's relay repaint share it.

/**
 * Make text captured from tmux (`capture-pane`, LF-separated lines) safe to `term.write()`.
 * xterm runs with `convertEol: false` — a bare LF moves down but keeps the column, so raw capture
 * output would render as a staircase. Lone LFs become CRLF; existing CRLFs are left alone.
 */
export function toXtermText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

/**
 * Drop exactly ONE trailing newline from a tmux capture.
 * `capture-pane -p -e -S -<n>` emits a trailing LF after its last line. Writing it would leave the
 * cursor one row BELOW the last captured row: xterm scrolls, the topmost row of the captured
 * visible screen is pushed into scrollback, and tmux's attach redraw (`\x1b[H\x1b[2J`) then
 * repaints that same screen — so on every warm reattach the first visible row would appear twice.
 * Strip on the RAW capture (LF-separated), before `toXtermText` turns the LFs into CRLFs.
 */
export function stripTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, '')
}

/**
 * What a repaint over a LIVE emulator starts with: SGR reset (so the clear paints the default
 * background, not whatever colour the stream left set), cursor home, clear the screen. The ESC
 * that opens it also ends any escape sequence the emulator was halfway through when the stream was
 * cut.
 */
export const RESUME_REPAINT_PREFIX = '\x1b[0m\x1b[H\x1b[2J'

/**
 * A captured screen as a repaint over an emulator that is already showing something — the relay
 * stream resumed after backpressure, whose phone emulator has the old screen (and a dropped
 * frame's worth of missing output) on it and feeds a snapshot in without any reset of its own.
 * Clear and home first, CRLF line endings with the trailing newline dropped, then the cursor where
 * the pane has it when the capture read one (0-based, as tmux reports it); unknown leaves it where
 * the paint ends.
 */
export function resumeRepaintText(screen: string, cursor: { x: number; y: number } | null): string {
  const place = cursor ? `\x1b[${cursor.y + 1};${cursor.x + 1}H` : ''
  return RESUME_REPAINT_PREFIX + toXtermText(stripTrailingNewline(screen)) + place
}
