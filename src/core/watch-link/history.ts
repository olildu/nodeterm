// A live link's read-back (`watch:history`, src/shared/watch-link/protocol.ts): one page of the
// watched agent's conversation, cut to what was written after the link was created.
//
// Why a conversation and not the terminal's history: the viewer's stream is a tmux CLIENT, which paints
// on the alternate screen, so the viewer's emulator never has lines to scroll; a keyframe is the
// visible screen and never history (docs/live-links.md → Keyframes). And on an agent node the terminal's
// history would not help anyway: Claude's fullscreen TUI keeps its conversation on the pane's alternate
// screen, where tmux records no history at all.
//
// The read itself is the ⌘M panel's (`readChatTranscript` behind the phone's `chat.page`, wired by the
// desktop shell); this module only turns its answer into a page, and holds the cutoff:
//  - a message older than the link, or with no time, never reaches a page (nothing proves it came
//    after the link);
//  - only text and tool names/arguments travel: tool results and thinking never do;
//  - paging stops at the link's creation even when the transcript goes further back.
import type { ChatMessage, ChatTranscriptResult } from '../../shared/types'
import {
  HISTORY_MESSAGES_MAX,
  readHistoryPage,
  type WatchHistoryMessage,
  type WatchHistoryPage,
  type WatchHistoryPart,
  type WatchHistoryStart,
  type WatchHistoryStatus
} from '../../shared/watch-link/protocol'

/** How large a transcript window one page reads (the ⌘M panel's older-page size). */
export const HISTORY_READ_BYTES = 512 * 1024

/** What the shell's reader answered: a transcript page, or a node with no conversation to read. A
 *  failed read is a rejection, never an empty page. */
export type HistoryRead = { kind: 'page'; result: ChatTranscriptResult } | { kind: 'unsupported' }

function partsOf(m: ChatMessage): WatchHistoryPart[] {
  const out: WatchHistoryPart[] = []
  for (const p of m.parts) {
    if (p.kind === 'text') out.push({ kind: 'text', text: p.text })
    else if (p.kind === 'tool') {
      out.push({ kind: 'tool', name: p.name, arg: p.arg })
      // A plan or a question is read in full on the screen (it is what the card shows); its result is not.
      if (p.body) out.push({ kind: 'text', text: p.body })
    }
    // thinking: never
  }
  return out
}

const empty = (before: number | null, since: number, status: WatchHistoryStatus): WatchHistoryPage => ({
  before,
  status,
  since,
  messages: [],
  olderCursor: null,
  start: status === 'ok' ? 'conversation' : null
})

/** The page for one read. `since` is the link's `createdAt`; `before` the cursor the viewer asked for.
 *  A null `read` is a failed read. */
export function historyPageFrom(read: HistoryRead | null, since: number, before: number | null): WatchHistoryPage {
  if (read === null) return empty(before, since, 'error')
  if (read.kind === 'unsupported') return empty(before, since, 'unsupported')
  const { result } = read
  if (!result.found) {
    // The NEWEST page found nothing: no conversation was written yet. An OLDER page that finds nothing
    // is a failed read (the transcript reader's own contract), never "the start".
    return before === null ? empty(before, since, 'ok') : empty(before, since, 'error')
  }
  const all = result.messages
  const timed = all.filter((m) => typeof m.at === 'number' && Number.isFinite(m.at))
  if (all.length > 0 && timed.length === 0) return empty(before, since, 'untimed')
  const reachedShare = timed.some((m) => (m.at as number) < since)
  let kept: ChatMessage[] = timed.filter((m) => (m.at as number) >= since)
  let olderCursor: number | null = reachedShare ? null : typeof result.olderCursor === 'number' ? result.olderCursor : null
  let start: WatchHistoryStart | null = olderCursor !== null ? null : reachedShare ? 'shared' : 'conversation'
  if (kept.length > HISTORY_MESSAGES_MAX) {
    kept = kept.slice(-HISTORY_MESSAGES_MAX)
    // Page on from the oldest message kept when its line's offset is known; a reader that does not
    // page cannot go back further.
    const key = kept[0].key
    if (typeof key === 'number' && Number.isInteger(key) && key >= 0) {
      olderCursor = key
      start = null
    } else {
      olderCursor = null
      start = 'cut'
    }
  }
  const messages: WatchHistoryMessage[] = kept.map((m) => ({ role: m.role, at: m.at as number, parts: partsOf(m) }))
  // Through the protocol's own reader: the same cleaning and bounds the viewer applies.
  return readHistoryPage({ before, status: 'ok', since, messages, olderCursor, start }) ?? empty(before, since, 'error')
}
