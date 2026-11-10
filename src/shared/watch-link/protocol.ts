// What travels inside a live link's E2E tunnel, besides raw pty frames and pty:* events.
// The viewer's namespace is `watch:` on purpose: the OWNER's IPC is `watchLink:`, which the relay
// host refuses from every peer as host-only BEFORE any policy runs (src/shared/host-control.ts).

export const WATCH_PROTOCOL_VERSION = 1
export const WATCH_EVENT_PREFIX = 'watch:'
export const WATCH_EVENT = {
  meta: 'watch:meta',
  keyframe: 'watch:keyframe',
  waiting: 'watch:waiting',
  chat: 'watch:chat',
  end: 'watch:end',
  /** To ONE viewer, never a broadcast: its control state, after an unlock or when control changes
   *  under it (turned off, locked). The initial state rides `watch:meta`. */
  control: 'watch:control',
  /** To every joined viewer: who typed in the last few seconds (`WatchTypingEvent`). */
  typing: 'watch:typing',
  /** To ONE viewer, the answer to its `watch:history` cast (`WatchHistoryPage`). */
  history: 'watch:history'
} as const
/** A viewer's chat line (Commenter and Control links). */
export const WATCH_CHAT_CAST = 'watch:chat'
/**
 * Control links only. Answered to that viewer alone with `watch:control`. Two forms:
 *  - SEALED, `{ sealed: { key, nonce, box } }` (./unlock-seal.ts): `{ name, password }` in a
 *    `nacl.box` from a fresh key pair of the page's to the key THIS connection's meta offered
 *    (`WatchMeta.unlockKey`). Every holder of a link can derive the tunnel's keys (both are derived
 *    from the link's secret), so a recording of the relay traffic plus the link would otherwise read a
 *    password a controller typed; the per-connection key pair is not derived from anything.
 *  - PLAIN, `{ name, password }`: what a page from before sealing sends, and what a page sends to a host
 *    that offered no key (a host from before sealing). A host refuses it (as a malformed attempt) on a
 *    connection that has already sent a sealed one.
 */
export const WATCH_UNLOCK_CAST = 'watch:unlock'
/**
 * Control links only, from a controlling viewer: `{ data }`, at most `INPUT_MAX` UTF-16 units.
 *
 * THE PASTE-FRAMING CONTRACT. Both ends keep it; the host trusts nothing else.
 *  - A controlling viewer forces bracketed paste ON in its OWN emulator (`?2004h`, put back after
 *    any reset the stream applies) and frames EVERY paste it sends as `ESC[200~` … `ESC[201~`. It
 *    never decides from the emulator's mode: what the viewer renders is a tmux CLIENT's output,
 *    whose `?2004h` is constant, so that mode says nothing about the application in the pane.
 *  - Before framing, the page removes both paste markers and every ESC from the paste's content: a
 *    paste is text, and a marker inside it would end the frame early and turn the rest into typed
 *    keys.
 *  - The host splits keys from pastes on those frames alone. Everything outside a frame is KEYS,
 *    typed byte for byte (tmux `send-keys -H`). The content of a frame is a PASTE, delivered with
 *    tmux `paste-buffer -p`, so tmux frames it for the pane only when the pane's application asked
 *    for bracketed paste. Where there is no tmux (the Windows session host, a direct Windows pane, a
 *    plain shell) the backend's own path decides the same way, or sends it unframed.
 *  - An emulator's answer to a query in the stream (DA, CPR, an OSC colour) travels ALONE, as its
 *    own cast, never merged with typed input: the host drops a cast that is entirely a terminal
 *    report, and only a whole one.
 *  - Input from a connection that stopped controlling within the last 5 s (it released, or the
 *    owner turned typing off or changed the password, or the link locked) is dropped silently:
 *    keystrokes in flight when control ended are not a breach. After that, or from a connection that
 *    never controlled, input is a policy breach and the host closes the connection.
 */
export const WATCH_INPUT_CAST = 'watch:input'
/** Control links only: drop the sender back to watching. No arguments. */
export const WATCH_RELEASE_CAST = 'watch:release'
/**
 * Every role: one page of the watched agent's CONVERSATION, never the terminal's history. The stream
 * is a tmux client painting on the alternate screen, so the viewer's emulator has nothing to scroll;
 * this is how a viewer reads back. `{ before?: number }` (`readHistoryRequest`): absent for the
 * newest page, else the `olderCursor` of the previous answer. Answered to that viewer alone with
 * `watch:history`.
 *
 * THE CUTOFF. A page holds only messages written at or after the moment the link was created
 * (`WatchHistoryPage.since`, the host's clock). A message with no time is never sent: nothing proves
 * it came after. What the link exposes is therefore what the terminal showed while it was shared, as
 * text, and nothing from before. Tool results are never sent (the screen shows a few lines of them
 * at most), and neither is the agent's thinking.
 */
export const WATCH_HISTORY_CAST = 'watch:history'

/** A Control link (`controller`) is a Commenter link plus typing for whoever unlocks it with the
 *  link's password. Every addition to this protocol is additive, so `WATCH_PROTOCOL_VERSION` stays 1:
 *  an older viewer page ignores the new events and simply cannot take control. */
export type WatchLinkRole = 'viewer' | 'commenter' | 'controller'
/** `attempts`: too many wrong passwords on this connection (it may reconnect through the link). */
export const WATCH_END_REASONS = ['revoked', 'expired', 'node-gone', 'session-ended', 'host-stopping', 'kicked', 'attempts'] as const
export type WatchLinkEndReason = (typeof WATCH_END_REASONS)[number]
export function isWatchEndReason(x: unknown): x is WatchLinkEndReason {
  return typeof x === 'string' && (WATCH_END_REASONS as readonly string[]).includes(x)
}

export interface WatchMeta {
  v: number
  role: WatchLinkRole
  /** Sharer-supplied; render as text, marked as set by the sharer. */
  label: string
  title: string
  /** Epoch ms on the host's clock, corrected to the server's; `null` for a link with no end time. */
  expiresAt: number | null
  cols: number
  rows: number
  /** A Control link's state for THIS viewer at join; absent on every other role. */
  control?: WatchControlEvent
  /** Present (true) when the watched node is an agent whose conversation `watch:history` can read
   *  back. Absent: a plain terminal, or a host older than read-back. */
  history?: true
  /** A Control link only: the base64 X25519 public key THIS connection seals its unlock to
   *  (`WATCH_UNLOCK_CAST`). The same for the connection's life; absent from a host older than sealing. */
  unlockKey?: string
}

/** `controlling`: this viewer may type. `available`: a Control link this viewer may unlock.
 *  `off`: the owner turned typing off. `locked`: too many wrong passwords across the link. */
export type WatchControlState = 'controlling' | 'available' | 'off' | 'locked'
/** Why an unlock was refused or control was taken away: `wrong` password, the link is `locked`,
 *  typing is `off`, an attempt `too-soon` after the last, the terminal is `unsupported`, or some input
 *  was `dropped` — over the rate limit, with no session to type into, or a delivery to the pane that
 *  failed. The host does not say which, so a viewer must not name a cause. */
export type WatchControlReason = 'wrong' | 'locked' | 'off' | 'too-soon' | 'unsupported' | 'dropped'
const CONTROL_STATES: readonly WatchControlState[] = ['controlling', 'available', 'off', 'locked']
const CONTROL_REASONS: readonly WatchControlReason[] = ['wrong', 'locked', 'off', 'too-soon', 'unsupported', 'dropped']
export interface WatchControlEvent {
  state: WatchControlState
  reason?: WatchControlReason
  /** With `locked` only: how long until the lock lifts by itself, in ms from when the host sent it.
   *  Absent: it does not (a lock from a host older than timed locks); only the sharer can lift it. The
   *  sharer can always lift it sooner. */
  lockedForMs?: number
}
/** The longest a wrong-password lock lasts by itself (the host doubles it from 15 minutes per lock). */
export const CONTROL_LOCK_MAX_MS = 24 * 60 * 60_000
export interface WatchTypingEvent {
  /** Self-chosen names: claims, shown as such. */
  names: string[]
}

/** The largest `watch:input` cast, in UTF-16 units. */
export const INPUT_MAX = 16384
/** The longest password the unlock cast carries, in code points. */
export const PASSWORD_MAX = 128
/** The most names one `watch:typing` event carries. */
export const TYPING_NAMES_MAX = 10

/** A `watch:control` payload (or `WatchMeta.control`), or null when it is not one. An unknown reason
 *  is dropped, never the state with it. */
export function readControlEvent(x: unknown): WatchControlEvent | null {
  if (!x || typeof x !== 'object') return null
  const { state, reason, lockedForMs } = x as Record<string, unknown>
  if (!(CONTROL_STATES as readonly unknown[]).includes(state)) return null
  const out: WatchControlEvent = { state: state as WatchControlState }
  if ((CONTROL_REASONS as readonly unknown[]).includes(reason)) out.reason = reason as WatchControlReason
  // Only beside `locked`, and only a duration a host can mean: anything else reads as "until the
  // sharer lifts it", never as a time the page would promise.
  if (
    state === 'locked' && typeof lockedForMs === 'number' && Number.isInteger(lockedForMs) &&
    lockedForMs >= 0 && lockedForMs <= CONTROL_LOCK_MAX_MS
  ) {
    out.lockedForMs = lockedForMs
  }
  return out
}
/** A `watch:typing` payload's names: each one a clean chat name, deduplicated in order, at most
 *  `TYPING_NAMES_MAX`. Anything else reads as nobody typing. */
export function readTypingNames(x: unknown): string[] {
  if (!x || typeof x !== 'object') return []
  const names = (x as Record<string, unknown>).names
  if (!Array.isArray(names)) return []
  const out: string[] = []
  for (const raw of names) {
    if (out.length >= TYPING_NAMES_MAX) break
    const name = sanitizeChatName(raw)
    if (name !== null && !out.includes(name)) out.push(name)
  }
  return out
}
export interface WatchKeyframe {
  sessionId: string
  /** The visible screen with SGR, or '' when the backend has no visible-only capture. */
  screen: string
  /** tmux paints its client on the alternate screen; the viewer must switch to it BEFORE painting,
   *  or every tmux redraw scrolls into the viewer's history (CLAUDE.md, co-attach seeding). */
  altScreen: boolean
  /** The host's cursor when the screen was captured, 0-based (tmux `cursor_x` / `cursor_y`). tmux's
   *  following stream moves the cursor RELATIVE to where it believes the tty cursor is, and a capture
   *  trims trailing blanks, so without this every keyframe offsets what is typed next. Absent when
   *  the host could not read it; the viewer then leaves the cursor where the screen text ends. */
  cursor?: { x: number; y: number }
}
export interface WatchChatMessage {
  id: string
  name: string
  text: string
  at: number
  from: 'viewer' | 'sharer'
}

/** Chat caps, in UTF-16 units (what an input's `maxLength` counts), never cutting a code point. */
export const CHAT_TEXT_MAX = 500
export const CHAT_NAME_MAX = 32
// C0 and C1 controls, DEL, and the ESC that starts every sequence. A newline becomes a space: chat
// is one line, and a pasted multi-line block must not reflow the owner's popover.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g
// The directional formatting characters: ALM (U+061C), LRM/RLM (U+200E/F), the embeddings and
// overrides (U+202A–E) and the isolates (U+2066–9). Chat is text one stranger wrote for the owner and
// every other viewer to read; an RLO reorders everything drawn after it. Escaped, never literal (a
// literal one is invisible in review). The same set as @shared/presence's BIDI_CONTROL_CHARS — this
// directory imports nothing from outside itself (it is vendored byte for byte into nodeterm-web), so
// the class is restated here and src/core/watch-link/wire.test.ts pins the two equal.
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
// Every other format character (Unicode category Cf) is invisible too: the zero-width space and
// joiners, the word joiner, the soft hyphen, the tag characters. In a NAME any of them makes a second
// name that looks exactly like the first — "Sharer" and "Sharer" + U+200B — in the chat, in "X is
// typing…" and in the owner's "someone using the name …" notice. So a name keeps none of them, nor the
// letters that draw as blank space (the Hangul fillers, the Braille blank, the combining grapheme
// joiner, which is invisible but a mark rather than Cf).
const NAME_INVISIBLES = /[\p{Cf}\u034f\u115f\u1160\u2800\u3164\uffa0]/gu
// In chat TEXT the same characters go, but for the two joiners real writing needs: the zero-width
// joiner (U+200D) holds emoji sequences together, and the zero-width non-joiner (U+200C) is how
// Persian and the Indic scripts are spelled. Text is not an identity claim; a name is.
const TEXT_INVISIBLES = /(?![\u200c\u200d])\p{Cf}/gu
/** How much of a raw value the cleaning chain may look at, as a multiple of the cap: a cast is
 *  attacker-sized, and the regex chain must not run over megabytes to keep 500 units of it. Generous
 *  enough that whitespace and controls collapsing away never empty an honest message. */
const RAW_FACTOR = 4

/** At most `max` UTF-16 units, cut BETWEEN code points: a plain `slice` can split a surrogate pair
 *  and leave a lone surrogate, which renders as a replacement glyph. Stops reading at the cap. */
function capUnits(s: string, max: number): string {
  if (s.length <= max) return s
  let out = ''
  for (const ch of s) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out
}

function clean(raw: unknown, max: number, invisibles: RegExp = TEXT_INVISIBLES): string | null {
  if (typeof raw !== 'string') return null
  // Bound the input BEFORE the regex chain (by code point), then cap the cleaned text the same way.
  const bounded = capUnits(raw, max * RAW_FACTOR)
  const cleaned = bounded
    .replace(/[\r\n\t]+/g, ' ')
    .replace(CONTROLS, '')
    .replace(BIDI_CONTROLS, '')
    .replace(invisibles, '')
    .replace(/\s+/g, ' ')
    .trim()
  const s = capUnits(cleaned, max).trim()
  return s ? s : null
}
export const sanitizeChatText = (raw: unknown): string | null => clean(raw, CHAT_TEXT_MAX)
/** A self-chosen name (chat, the typing line, an unlock): no invisible character at all, so two names
 *  that look alike ARE alike. */
export const sanitizeChatName = (raw: unknown): string | null => clean(raw, CHAT_NAME_MAX, NAME_INVISIBLES)

// --- read-back (`watch:history`) --------------------------------------------------------------------

/** Why a page holds no messages: `unsupported` — the node is not an agent with a readable
 *  conversation; `untimed` — its conversation states no times, so nothing in it can be shown as
 *  written after the link was shared; `error` — the host could not read it (try again). */
export const HISTORY_STATUSES = ['ok', 'unsupported', 'untimed', 'error'] as const
export type WatchHistoryStatus = (typeof HISTORY_STATUSES)[number]
/** Why there is nothing older (only when `olderCursor` is null): `shared` — the page reached the
 *  moment the link was created; `conversation` — it reached the start of the conversation;
 *  `cut` — the host's reader for this agent cannot page further back. */
export const HISTORY_STARTS = ['shared', 'conversation', 'cut'] as const
export type WatchHistoryStart = (typeof HISTORY_STARTS)[number]
export type WatchHistoryPart = { kind: 'text'; text: string } | { kind: 'tool'; name: string; arg: string }
export interface WatchHistoryMessage {
  role: 'user' | 'assistant'
  /** When the line was written, epoch ms on the host's clock; never before `since`. */
  at: number
  parts: WatchHistoryPart[]
}
export interface WatchHistoryPage {
  /** The cursor this page answers (`null`: the newest page). */
  before: number | null
  status: WatchHistoryStatus
  /** When the link was created (the host's clock): nothing older is ever on a page. */
  since: number
  /** Oldest first. */
  messages: WatchHistoryMessage[]
  /** Ask for this as `before` to read older messages; null when there is nothing older to show. */
  olderCursor: number | null
  /** Why there is nothing older; null while `olderCursor` is set. */
  start: WatchHistoryStart | null
}

/** One text part, in UTF-16 units (the cut ends in `…`). */
export const HISTORY_TEXT_MAX = 20_000
export const HISTORY_TOOL_NAME_MAX = 64
export const HISTORY_TOOL_ARG_MAX = 200
export const HISTORY_PARTS_MAX = 64
/** Messages on one page; the NEWEST are kept. */
export const HISTORY_MESSAGES_MAX = 200
/** All the text on one page. Past it, the OLDER messages' text is cut to `…` (they keep their place). */
export const HISTORY_PAGE_TEXT_MAX = 400_000
const HISTORY_CURSOR_MAX = Number.MAX_SAFE_INTEGER
// Every C0 control but TAB and LF (CR is folded into LF first), DEL and the C1 controls. ESC goes with
// them: the page renders text, never a terminal sequence.
const HISTORY_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

const isCursor = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= HISTORY_CURSOR_MAX

/** Multi-line text a viewer may read: LF and TAB kept, CR folded into LF, every other control and
 *  every bidi control removed, at most `max` UTF-16 units (a cut ends in `…`). Null when nothing is
 *  left. */
export function sanitizeHistoryText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string' || max < 2) return null
  const s = capUnits(raw, max * RAW_FACTOR)
    .replace(/\r\n?/g, '\n')
    .replace(HISTORY_CONTROLS, '')
    .replace(BIDI_CONTROLS, '')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '')
  if (!s) return null
  return s.length <= max ? s : `${capUnits(s, max - 1)}…`
}

/** A `watch:history` cast's argument, or null when it is not one. */
export function readHistoryRequest(x: unknown): { before: number | null } | null {
  if (x === undefined) return { before: null }
  if (!x || typeof x !== 'object') return null
  const before = (x as Record<string, unknown>).before
  if (before === undefined) return { before: null }
  return isCursor(before) ? { before } : null
}

function readHistoryPart(x: unknown): WatchHistoryPart | null {
  if (!x || typeof x !== 'object') return null
  const p = x as Record<string, unknown>
  if (p.kind === 'text') {
    const text = sanitizeHistoryText(p.text, HISTORY_TEXT_MAX)
    return text === null ? null : { kind: 'text', text }
  }
  if (p.kind === 'tool') {
    const name = clean(p.name, HISTORY_TOOL_NAME_MAX)
    if (name === null) return null
    return { kind: 'tool', name, arg: clean(p.arg, HISTORY_TOOL_ARG_MAX) ?? '' }
  }
  return null
}

function readHistoryMessage(x: unknown, since: number): WatchHistoryMessage | null {
  if (!x || typeof x !== 'object') return null
  const m = x as Record<string, unknown>
  if (m.role !== 'user' && m.role !== 'assistant') return null
  // The cutoff, enforced on BOTH ends: the host builds pages with it and the page re-reads them with it.
  if (typeof m.at !== 'number' || !Number.isFinite(m.at) || m.at < since) return null
  if (!Array.isArray(m.parts)) return null
  const parts: WatchHistoryPart[] = []
  for (const raw of m.parts) {
    if (parts.length >= HISTORY_PARTS_MAX) break
    const part = readHistoryPart(raw)
    if (part) parts.push(part)
  }
  return parts.length > 0 ? { role: m.role, at: m.at, parts } : null
}

/** A `watch:history` page, cleaned and bounded, or null when it is not one. The host builds every page
 *  through this too, so both ends hold the same limits. */
export function readHistoryPage(x: unknown): WatchHistoryPage | null {
  if (!x || typeof x !== 'object') return null
  const p = x as Record<string, unknown>
  if (!(HISTORY_STATUSES as readonly unknown[]).includes(p.status)) return null
  if (p.before !== null && !isCursor(p.before)) return null
  if (p.olderCursor !== null && !isCursor(p.olderCursor)) return null
  if (p.start !== null && !(HISTORY_STARTS as readonly unknown[]).includes(p.start)) return null
  if (typeof p.since !== 'number' || !Number.isFinite(p.since) || p.since < 0) return null
  const since = p.since
  const messages: WatchHistoryMessage[] = []
  if (p.status === 'ok' && Array.isArray(p.messages)) {
    for (const raw of p.messages) {
      const m = readHistoryMessage(raw, since)
      if (m) messages.push(m)
    }
  }
  const kept = messages.slice(-HISTORY_MESSAGES_MAX)
  // The page's text budget, spent newest first: an older message past it keeps its place, as `…`.
  let budget = HISTORY_PAGE_TEXT_MAX
  for (let i = kept.length - 1; i >= 0; i--) {
    kept[i] = {
      ...kept[i],
      parts: kept[i].parts.map((part) => {
        if (part.kind !== 'text') return part
        if (part.text.length <= budget) {
          budget -= part.text.length
          return part
        }
        const text = budget >= 2 ? `${capUnits(part.text, budget - 1)}…` : '…'
        budget = 0
        return { kind: 'text', text }
      })
    }
  }
  return {
    before: p.before as number | null,
    status: p.status as WatchHistoryStatus,
    since,
    messages: kept,
    olderCursor: p.olderCursor as number | null,
    start: p.start as WatchHistoryStart | null
  }
}
