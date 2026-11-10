// gemini's session file (`~/.gemini/tmp/<project>/chats/session-*.jsonl`) as the ⌘M panel's
// structured messages — and, through the relay's `chat.page`, the phone's.
//
// The file is NOT a list of messages. Measured against gemini-cli 0.61.0's ChatRecordingService
// (bundle `chunk-JDPZ4CE3.js`, `appendRecord` / `pushMessage` / `rewindTo` /
// `updateMessagesFromHistory`, and its own reader `loadConversationRecord`), every line is one of:
//
//   header        {sessionId, projectHash, startTime, lastUpdated, kind, directories?, summary?}
//                 — the first line; an older single-record shape also carried `messages`.
//   message       {id, timestamp, type, content, displayContent?, …} — `type` is `user`, `gemini`,
//                 `info`, `warning` or `error`. The SAME id is written again, in full, every time the
//                 message changes (its tool calls are added, their results land, its tokens arrive):
//                 an UPSERT, which keeps the message's first position.
//   $rewindTo     {$rewindTo: id} — the user rewound: that message and everything after it are gone.
//   $set          {$set: {lastUpdated | summary | directories | memoryScratchpad | sessionId |
//                  messages}} — metadata, except `messages`, which REPLACES the model's history.
//
// That last one is the trap. `$set.messages` is written at session start (the `<session_context>`
// preamble), on every compression (all turns re-minted under NEW ids, the older ones dropped, a
// `<state_snapshot>` summary inserted as a user turn), and when an aborted turn is rolled back. It
// is what gemini will SEND next time, not what was said: folding it the way gemini's own resume does
// would make the whole thread vanish at every compression, show the model-facing snapshot as
// something the human typed, and delete a cancelled prompt the terminal still shows. Every message
// that was actually said is also appended as its own record, so the display log is those records
// alone, upserted by id, with `$rewindTo` honoured — and `$set` never touches it.
//
// Why this does not page (claude pages by byte window): a record's meaning depends on records
// before it — a tool result arrives as a later rewrite of an earlier message, and a rewind removes
// earlier messages — so a byte window cannot be folded on its own. The file is read whole under
// the same 5 MB cap claude's legacy read uses (`readCappedTail`), and returned as ONE page with
// `olderCursor: null`, exactly like grok. Past the cap the fold starts at the tail: a message first
// written before it appears where its first in-window rewrite is, and a rewind to a message before
// it is ignored (see `rewind` below).
import type { ChatMessage, ChatPart, ChatTranscriptResult } from '../shared/types'
import type { ChatTranscriptPage } from '../shared/chat-page'
import { CHAT_TOOL_ARG_MAX } from '../shared/chat-command'
import { locateGemini } from './handoff/locate'
import { readCappedTail } from './transcript-reader'
import { isRecord } from '../shared/is-record'

/** Same caps as claude's reader (`summarizeResult` / `metaString` in transcript-reader.ts), in
 *  UTF-16 code units — kept equal so the three readers' parts look alike. */
const TOOL_RESULT_LINES = 3
const TOOL_RESULT_MAX = 500
const CHAT_META_MAX_CHARS = 100

/** Text parts that gemini itself wrote into a user turn, not the human: the environment preamble
 *  (`getInitialChatHistory`) and a hook's additionalContext, APPENDED as its own part beside the
 *  prompt (`fireBeforeAgentHookSafe`). The same prefixes gemini's `isIgnoredUserContent` skips.
 *  Dropped per PART — dropping the message would drop the prompt next to the hook's text. */
const HARNESS_PREFIXES = ['<session_context>', '<hook_context>']

/** Which argument names a call, per the parameter names gemini's tools declare (`command` for
 *  run_shell_command, `file_path` for read_file / write_file / replace, `dir_path` for
 *  list_directory, `pattern` for glob / grep_search, `query` for google_web_search, `prompt` for
 *  web_fetch, `name` for activate_skill, `title` for update_topic). First present string wins. */
const ARG_KEYS = ['command', 'file_path', 'dir_path', 'path', 'pattern', 'query', 'prompt', 'name', 'title'] as const

type Rec = Record<string, unknown>
type ToolPart = Extract<ChatPart, { kind: 'tool' }>

export interface GeminiChat {
  messages: ChatMessage[]
  /** The newest model turn's `model`. Absent (the key) when no turn states a usable one. */
  model?: string
  /** Records and entries we could not map — never rendered, never a crash. */
  skipped: number
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function isHarnessText(t: string): boolean {
  const s = t.trimStart()
  return HARNESS_PREFIXES.some((p) => s.startsWith(p))
}

/** A content value (string or Part[]) as its visible text parts: thoughts and harness text dropped,
 *  non-text parts (images, function calls/responses) ignored here. */
function visibleTexts(content: unknown): string[] {
  const raw: string[] = []
  if (typeof content === 'string') raw.push(content)
  else if (Array.isArray(content)) {
    for (const p of content) {
      if (!isRecord(p) || p.thought === true) continue
      const t = str(p.text)
      if (t !== undefined) raw.push(t)
    }
  }
  return raw.filter((t) => t.length > 0 && !isHarnessText(t))
}

function summarize(s: string): string {
  return s.split('\n').slice(0, TOOL_RESULT_LINES).join(' ').slice(0, TOOL_RESULT_MAX)
}

/** What the model was given back: `functionResponse.response.output`, else its `error`. */
function responseText(part: unknown): string | undefined {
  const fr = isRecord(part) && isRecord(part.functionResponse) ? part.functionResponse : undefined
  const resp = fr && isRecord(fr.response) ? fr.response : undefined
  if (!resp) return undefined
  return str(resp.output) ?? str(resp.error)
}

function toolArg(args: unknown, description: unknown): string {
  if (isRecord(args)) {
    for (const k of ARG_KEYS) {
      const v = str(args[k])
      if (v) return v.slice(0, CHAT_TOOL_ARG_MAX)
    }
  }
  return (str(description) ?? '').slice(0, CHAT_TOOL_ARG_MAX)
}

function toolFromCall(c: Rec): ToolPart {
  const part: ToolPart = { kind: 'tool', name: str(c.name) || 'tool', arg: toolArg(c.args, c.description) }
  let out: string | undefined
  if (Array.isArray(c.result)) {
    for (const r of c.result) {
      out = responseText(r)
      if (out !== undefined) break
    }
  }
  // `resultDisplay` is what the TUI drew. Only its string form is text; an object (a file diff) is
  // not something to summarize, and rendering its JSON would be the raw-record failure.
  out ??= str(c.resultDisplay)
  const s = out === undefined ? '' : summarize(out)
  if (s) part.result = s
  return part
}

function lineTime(v: unknown): number | undefined {
  if (typeof v !== 'string' || !v) return undefined
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

/**
 * Fold the records into the display log: message records upserted by id in first-seen order,
 * `$rewindTo` honoured, everything else metadata. PURE.
 */
function foldRecords(buf: string): { log: Map<string, Rec>; skipped: number } {
  const log = new Map<string, Rec>()
  let skipped = 0
  const upsert = (m: unknown): void => {
    if (isRecord(m) && typeof m.id === 'string') log.set(m.id, m)
  }
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      skipped++
      continue
    }
    if (!isRecord(o)) {
      skipped++
      continue
    }
    if (typeof o.$rewindTo === 'string') {
      if (!log.has(o.$rewindTo)) {
        // gemini clears EVERYTHING on an unknown target. Its targets after a compression are the
        // re-minted copies this log deliberately does not hold, and past the read cap the target
        // can sit before the window — a wipe would blank a thread that is really there.
        skipped++
        continue
      }
      let found = false
      for (const id of [...log.keys()]) {
        if (id === o.$rewindTo) found = true
        if (found) log.delete(id)
      }
    } else if (typeof o.id === 'string') {
      upsert(o)
    } else if (isRecord(o.$set)) {
      // Metadata; `$set.messages` is the model's context, not the thread (see the file comment).
    } else if (typeof o.sessionId === 'string' && typeof o.projectHash === 'string') {
      if (Array.isArray(o.messages)) for (const m of o.messages) upsert(m)
    } else {
      skipped++
    }
  }
  return { log, skipped }
}

/**
 * Ordered bubbles for a gemini session. PURE — the golden fixtures in
 * `src/shared/chat-fixtures/gemini/` pin its output byte for byte.
 *
 *  - `user`: the text the human TYPED — `displayContent` when gemini recorded one (it does when the
 *    sent content differs, e.g. an `@file` expanded into the file's body), else `content`. A turn
 *    that is only tool output (`functionResponse` parts, which gemini records as a user turn) is not
 *    a bubble; its output is attached to the call it answers when that call has none yet.
 *  - `gemini`: its text, then one tool part per call — from `toolCalls` (the enriched record, with
 *    results), else from `functionCall` parts in `content` (a rewritten file carries those).
 *    Thoughts are dropped, as claude's reader drops thinking.
 *  - `info` / `warning` / `error`: the TUI's own notes (a compression, a cancel, an API error) —
 *    rendered on the assistant side prefixed `[info]` etc., never as something the human said.
 */
export function chatFromGemini(buf: string): GeminiChat {
  const { log, skipped: foldSkipped } = foldRecords(buf)
  let skipped = foldSkipped
  const messages: ChatMessage[] = []
  const toolById = new Map<string, ToolPart>()
  let model: string | undefined
  const push = (role: ChatMessage['role'], parts: ChatPart[], rec: Rec): void => {
    if (!parts.length) return
    const at = lineTime(rec.timestamp)
    messages.push(at === undefined ? { role, parts } : { role, parts, at })
  }
  for (const rec of log.values()) {
    switch (rec.type) {
      case 'user': {
        if (Array.isArray(rec.content)) {
          for (const p of rec.content) {
            if (!isRecord(p) || !isRecord(p.functionResponse)) continue
            const id = str(p.functionResponse.id)
            const tool = id ? toolById.get(id) : undefined
            const out = responseText(p)
            if (tool && tool.result === undefined && out) {
              const s = summarize(out)
              if (s) tool.result = s
            }
          }
        }
        const shown = rec.displayContent !== undefined ? visibleTexts(rec.displayContent) : []
        const typed = shown.length ? shown : visibleTexts(rec.content)
        push('user', typed.map((text) => ({ kind: 'text', text })), rec)
        break
      }
      case 'gemini': {
        const parts: ChatPart[] = visibleTexts(rec.content).map((text) => ({ kind: 'text', text }))
        const calls = Array.isArray(rec.toolCalls) ? rec.toolCalls : []
        if (calls.length) {
          for (const c of calls) {
            if (!isRecord(c)) {
              skipped++
              continue
            }
            const part = toolFromCall(c)
            parts.push(part)
            const id = str(c.id)
            if (id) toolById.set(id, part)
          }
        } else if (Array.isArray(rec.content)) {
          for (const p of rec.content) {
            if (!isRecord(p) || !isRecord(p.functionCall)) continue
            const fc = p.functionCall
            const part: ToolPart = { kind: 'tool', name: str(fc.name) || 'tool', arg: toolArg(fc.args, undefined) }
            parts.push(part)
            const id = str(fc.id)
            if (id) toolById.set(id, part)
          }
        }
        const m = str(rec.model)
        if (m && m.length <= CHAT_META_MAX_CHARS) model = m
        push('assistant', parts, rec)
        break
      }
      case 'info':
      case 'warning':
      case 'error': {
        const t = visibleTexts(rec.content).join('\n')
        if (t) push('assistant', [{ kind: 'text', text: `[${rec.type}] ${t}` }], rec)
        break
      }
      default:
        skipped++
    }
  }
  const out: GeminiChat = { messages, skipped }
  if (model !== undefined) out.model = model
  return out
}

/**
 * The gemini leg of `chat:read-transcript` (routed in transcript-ipc.ts BEFORE anything
 * claude-shaped runs). Local only: a remote node's session lives on its host and there is no remote
 * reader for it yet, so `remoteOnly` answers `unreadable` (paged) / not-found (legacy) without
 * touching this machine's disk — a same-id file here is a namesake, not the session.
 *
 * Located strictly by the session id in the file's header (`locateGemini`). There is no cwd leg:
 * the newest session in a directory is whichever node spoke last, not this one.
 */
export async function readGeminiChatTranscript(
  q: { sessionId?: string; remoteOnly?: boolean },
  page: ChatTranscriptPage | null
): Promise<ChatTranscriptResult> {
  const paging = page ? { olderCursor: null, unmatchedResults: [] } : {}
  if (q.remoteOnly) return page ? { messages: [], found: false, ...paging, unreadable: true } : { messages: [], found: false }
  const p = q.sessionId ? await locateGemini(q.sessionId) : undefined
  const buf = p ? await readCappedTail(p) : undefined
  if (buf === undefined) return { messages: [], found: false, ...paging }
  const chat = chatFromGemini(buf)
  // `model` rides the PAGED result only, as on claude's reader; the legacy result stays
  // `{messages, found}`.
  return {
    messages: chat.messages,
    found: true,
    ...paging,
    ...(page && chat.model !== undefined ? { model: chat.model } : {})
  }
}
