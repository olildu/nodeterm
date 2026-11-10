// A codex rollout (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<thread id>.jsonl`) as the ⌘M
// panel's structured messages — the same `ChatMessage` / `ChatPart` shapes claude's reader emits,
// so the panel, the kanban card modal and the phone (over the relay, `ChatPage` v1) render it with
// no agent-specific code. Separate from `transcript-reader.ts`'s claude parser: claude's records
// (`message.content`, `tool_use` / `tool_result`) share nothing with codex's, and pointing claude's
// resolver at a codex id is how a codex node once read a stranger's claude session.
//
// ── The measured format (codex-cli 0.114.0 → 0.156.1, 67 rollouts, 2026-09-28) ──────────────────
// Every line is `{timestamp, type, payload}`; the paginated format (≥ 0.151, `session_meta.payload
// .history_mode: "paginated"`) adds a numeric `ordinal`. Two parallel streams describe one session:
//  - `response_item` — what the MODEL sees: `message` (role user / developer / assistant),
//    `reasoning`, `function_call` / `function_call_output`, `custom_tool_call` /
//    `custom_tool_call_output`, `tool_search_call` / `tool_search_output`, `agent_message`.
//  - `event_msg` — what the UI saw: `user_message` + `agent_message` (legacy ≤ 0.146), or
//    `item_completed` with a thread item (`UserMessage`, `AgentMessage`, `CommandExecution`, …) on
//    the paginated format; plus `task_started` / `task_complete` / `turn_aborted` / `token_count`.
//
// Which stream each part comes from is the whole design:
//  - USER text comes from the UI stream ONLY. The model-side `role:user` messages also carry the
//    context codex injects (`# AGENTS.md instructions…`, `<environment_context>`, subagent tasks,
//    image wrappers) — measured: every typed prompt appears in the UI stream, and every model-side
//    user text missing from it was injected. Reading the UI record needs no prefix heuristics.
//    The two UI shapes never co-occur in one rollout (measured over all 67).
//  - ASSISTANT text and TOOLS come from the model stream only: it exists on both formats, and a tool
//    call and its output are correlated by `call_id` exactly like claude's `tool_use_id`. The UI
//    copies (`agent_message` events, `AgentMessage` items) are skipped, or every answer would show
//    twice.
//  - `reasoning` is skipped (encrypted; claude's thinking is dropped too), and so are developer
//    messages, compaction, inter-agent `agent_message` deliveries and every metadata record.
//
// Paging: a rollout is append-only JSONL, so it pages exactly like claude's transcript — keys are
// absolute byte offsets and an output whose call sits in an older window is carried in
// `unmatchedResults` (see `parseCodexChatWindow`).
import fs from 'node:fs'
import path from 'node:path'
import type { ChatCarriedToolResult, ChatMessage, ChatPart } from '../shared/types'
import { CHAT_TOOL_ARG_MAX } from '../shared/chat-command'
import type { ChatWindowParse } from './transcript-reader'
import { codexHomeFor } from './codex-config-dir'
import { isRecord } from '../shared/is-record'

type ToolPart = Extract<ChatPart, { kind: 'tool' }>

/** A tool result's summary: first three lines joined by a space, first 500 UTF-16 units — claude's
 *  `summarizeResult` rule, so a result reads the same on either agent. */
const RESULT_LINES = 3
const RESULT_MAX = 500
/** Longest `model` / `effort` value reported (same bound as claude's reader). */
const META_MAX = 100
/** Longest `turn_aborted` reason shown in the note; a longer one is dropped from it. */
const REASON_MAX = 100
/** How far down a tool output the `Output:` line may sit and still end a preamble. */
const PREAMBLE_MAX_LINES = 6
/** The name a `tool_search_call` gets (the record itself carries none). */
export const CODEX_TOOL_SEARCH = 'tool_search'

/** Which argument field names a tool call, in order: codex's own `cmd` (exec_command) first, then
 *  claude's `toolArg` keys, then `query` (tool search) and `message` (the collaboration tools). */
const ARG_KEYS = ['cmd', 'command', 'file_path', 'path', 'pattern', 'query', 'description', 'prompt', 'message'] as const

/**
 * The one-line hint for a tool call: `arguments` is a JSON string (function_call) or an object
 * (tool_search_call). The first `ARG_KEYS` field holding a string (or, for `command`, an array of
 * strings, joined by a space) wins, capped at `CHAT_TOOL_ARG_MAX`. Anything else — unparseable,
 * not an object, no known field — is `''`, never the raw JSON.
 */
export function codexToolArg(args: unknown): string {
  let o: unknown = args
  if (typeof args === 'string') {
    try {
      o = JSON.parse(args)
    } catch {
      return ''
    }
  }
  if (!isRecord(o)) return ''
  for (const k of ARG_KEYS) {
    const v = o[k]
    if (typeof v === 'string') return v.slice(0, CHAT_TOOL_ARG_MAX)
    if (k === 'command' && Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) {
      return v.join(' ').slice(0, CHAT_TOOL_ARG_MAX)
    }
  }
  return ''
}

/** The text of a tool output: a string, or the `input_text` / `output_text` items of an array
 *  joined by `\n` (an `input_image` item has no text). Anything else has none. */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  return output
    .filter((c): c is { type: string; text: string } => isRecord(c) && (c.type === 'input_text' || c.type === 'output_text') && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}

/**
 * A tool output's summary. Codex opens its tool outputs with a preamble that ends at a line reading
 * exactly `Output:` — `Script completed / Wall time … / Output:` (exec), `Chunk ID / Wall time /
 * Process exited with code N / Original token count / Output:` (exec_command). Summarizing from the
 * top would show that preamble on every call, so the summary starts after it (leading blank lines
 * skipped). An empty body falls back to the preamble, which still says how the call ended. Only an
 * `Output:` within the first `PREAMBLE_MAX_LINES` lines counts; later it is content.
 */
export function codexResultSummary(output: unknown): string {
  const lines = outputText(output).split('\n')
  const marker = lines.slice(0, PREAMBLE_MAX_LINES).indexOf('Output:')
  let pick = lines
  if (marker >= 0) {
    const body = lines.slice(marker + 1)
    let first = 0
    while (first < body.length && body[first].trim() === '') first++
    pick = first < body.length ? body.slice(first) : lines.slice(0, marker)
  }
  return pick.slice(0, RESULT_LINES).join(' ').slice(0, RESULT_MAX)
}

function metaString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= META_MAX ? v : undefined
}

function lineTime(v: unknown): number | undefined {
  if (typeof v !== 'string' || !v) return undefined
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

/** Text parts of a content array: items of `type` whose `text` is a non-empty string. */
function textParts(content: unknown, type: string): ChatPart[] {
  if (!Array.isArray(content)) return []
  const parts: ChatPart[] = []
  for (const c of content) {
    if (isRecord(c) && c.type === type && typeof c.text === 'string' && c.text) parts.push({ kind: 'text', text: c.text })
  }
  return parts
}

export interface CodexChatParse {
  messages: ChatMessage[]
  /** PAGED only: outputs whose call is not among these lines (it lives in an OLDER window). */
  unmatched: Map<string, string>
  /** PAGED only: the newest `turn_context`'s `model` / `effort` — both from that ONE record. */
  model?: string
  effort?: string
  /** Non-blank lines that rendered nothing (no message, no result): metadata, reasoning, injected
   *  context, UI duplicates, malformed lines. Diagnostic only — never on the wire. */
  skipped: number
}

/**
 * Parse rollout lines into chat messages. `paged` adds what only a paged read needs: `key` (the
 * line's absolute byte offset), the `call_id` as a tool part's `id`, the carried outputs, and
 * `model` / `effort`. The unpaged read carries `at` too (same as claude).
 */
export function parseCodexChatRecords(
  records: Iterable<{ raw: string; offset: number }>,
  paged: boolean
): CodexChatParse {
  const messages: ChatMessage[] = []
  const unmatched = new Map<string, string>()
  const toolById = new Map<string, ToolPart>()
  let model: string | undefined
  let effort: string | undefined
  let skipped = 0
  for (const { raw, offset } of records) {
    if (!raw.trim()) continue
    let o: unknown
    try {
      o = JSON.parse(raw)
    } catch {
      skipped++
      continue
    }
    if (!isRecord(o) || !isRecord(o.payload)) {
      skipped++
      continue
    }
    const p = o.payload
    const at = lineTime(o.timestamp)
    const push = (role: ChatMessage['role'], parts: ChatPart[]): void => {
      const m: ChatMessage = { role, parts }
      if (at !== undefined) m.at = at
      if (paged) m.key = offset
      messages.push(m)
    }
    const tool = (name: string, arg: string, callId: unknown): void => {
      const part: ToolPart = { kind: 'tool', name, arg }
      if (paged && typeof callId === 'string' && callId) part.id = callId
      if (typeof callId === 'string' && callId) toolById.set(callId, part)
      push('assistant', [part])
    }
    let rendered = false
    if (o.type === 'event_msg') {
      if (p.type === 'user_message') {
        // LEGACY: the prompt exactly as typed.
        if (typeof p.message === 'string' && p.message.trim()) {
          push('user', [{ kind: 'text', text: p.message }])
          rendered = true
        }
      } else if (p.type === 'item_completed') {
        // PAGINATED: the same, as a thread item. Every other item type duplicates the model stream
        // (AgentMessage) or describes a tool the model stream already carries.
        const item = p.item
        if (isRecord(item) && item.type === 'UserMessage') {
          const parts = textParts(item.content, 'text')
          if (parts.length) {
            push('user', parts)
            rendered = true
          }
        }
      } else if (p.type === 'task_complete') {
        // A turn that FAILED (measured: `usage_limit_exceeded`) says why only here. Without the
        // note the reader sees a prompt followed by nothing.
        const err = p.error
        if (isRecord(err) && typeof err.message === 'string' && err.message.trim()) {
          push('assistant', [{ kind: 'text', text: `[error] ${err.message}` }])
          rendered = true
        }
      } else if (p.type === 'turn_aborted') {
        const reason = typeof p.reason === 'string' ? p.reason.trim() : ''
        const shown = reason && reason.length <= REASON_MAX ? `: ${reason}` : ''
        push('assistant', [{ kind: 'text', text: `[turn aborted${shown}]` }])
        rendered = true
      }
    } else if (o.type === 'response_item') {
      if (p.type === 'message') {
        // Only the assistant's own words. role user / developer is model-side context (see header).
        if (p.role === 'assistant') {
          const parts = textParts(p.content, 'output_text')
          if (parts.length) {
            push('assistant', parts)
            rendered = true
          }
        }
      } else if (p.type === 'function_call') {
        tool(typeof p.name === 'string' && p.name ? p.name : 'tool', codexToolArg(p.arguments), p.call_id)
        rendered = true
      } else if (p.type === 'custom_tool_call') {
        const input = typeof p.input === 'string' ? p.input.trim().slice(0, CHAT_TOOL_ARG_MAX) : ''
        tool(typeof p.name === 'string' && p.name ? p.name : 'tool', input, p.call_id)
        rendered = true
      } else if (p.type === 'tool_search_call') {
        tool(CODEX_TOOL_SEARCH, codexToolArg(p.arguments), p.call_id)
        rendered = true
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output' || p.type === 'tool_search_output') {
        const callId = typeof p.call_id === 'string' && p.call_id ? p.call_id : undefined
        const target = callId ? toolById.get(callId) : undefined
        const s = codexResultSummary(p.output)
        if (target) {
          if (s) target.result = s
          rendered = true
        } else if (paged && s && callId) {
          // Its call is in an OLDER window (codex writes the call before its output).
          unmatched.set(callId, s)
          rendered = true
        }
      }
    } else if (o.type === 'turn_context' && paged) {
      // One record answers BOTH: a field it does not state is absent, never carried forward from an
      // older turn (same rule as claude's reader).
      model = metaString(p.model)
      effort = metaString(p.effort)
    }
    if (!rendered) skipped++
  }
  const out: CodexChatParse = { messages, unmatched, skipped }
  if (model !== undefined) out.model = model
  if (effort !== undefined) out.effort = effort
  return out
}

/** The unpaged (legacy) read: every line of `text`, no keys, no carried results. */
export function chatMessagesFromCodex(text: string): ChatMessage[] {
  return parseCodexChatRecords(
    text.split('\n').map((raw) => ({ raw, offset: 0 })),
    false
  ).messages
}

/**
 * One byte window of a rollout, with EXACTLY the window contract of claude's `parseChatWindow`
 * (transcript-reader.ts) — `buf` starts one lookbehind byte before the window when `bufStart > 0`,
 * everything up to the first `\n` is the dropped partial line, `olderCursor` is where the first
 * complete line starts, and a window with no complete line reports `noCompleteLine` pointing at
 * `bufStart`. Kept as its own copy (a dozen lines) rather than a refactor of claude's function, so
 * this agent's reader stays in its own file; `codex-chat.test.ts` pins that the two split every
 * boundary identically.
 */
export function parseCodexChatWindow(buf: Buffer, bufStart: number): ChatWindowParse {
  const end = bufStart + buf.length
  let from = 0
  let olderCursor: number | null = null
  if (bufStart > 0) {
    const nl = buf.indexOf(0x0a)
    if (nl < 0 || bufStart + nl + 1 >= end) {
      return { messages: [], olderCursor: bufStart, unmatchedResults: [], noCompleteLine: true }
    }
    from = nl + 1
    olderCursor = bufStart + from
  }
  const records: Array<{ raw: string; offset: number }> = []
  while (from < buf.length) {
    const nl = buf.indexOf(0x0a, from)
    const to = nl < 0 ? buf.length : nl
    if (to > from) records.push({ raw: buf.toString('utf8', from, to), offset: bufStart + from })
    from = to + 1
  }
  const { messages, unmatched, model, effort } = parseCodexChatRecords(records, true)
  const carried: ChatCarriedToolResult[] = [...unmatched].map(([id, result]) => ({ id, result }))
  return {
    messages,
    olderCursor,
    unmatchedResults: carried,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    noCompleteLine: false
  }
}

// ── Locating the rollout ─────────────────────────────────────────────────────────────────────────

/**
 * A codex thread id: one WHOLE uuid (measured: UUIDv7, e.g. `01a0cd92-5650-7190-950b-…`). Claude's
 * looser `SESSION_ID_RE` (hex and dashes, 8–64) is not enough here — a uuid's last group is itself
 * 12 hex characters, so `-<that group>.jsonl` would match ANOTHER thread's rollout name.
 */
export const CODEX_THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** How deep under `sessions/` a rollout may sit (codex writes `YYYY/MM/DD/`). */
const LOCATE_MAX_DEPTH = 4

/** `rollout-<anything>-<id>.jsonl`: the thread id is the WHOLE suffix, never a substring. */
function isRolloutFor(name: string, sessionId: string): boolean {
  return name.startsWith('rollout-') && name.endsWith(`-${sessionId}.jsonl`)
}

async function readable(p: string): Promise<boolean> {
  try {
    const st = await fs.promises.lstat(p)
    return st.isFile()
  } catch {
    return false
  }
}

const rolloutCache = new Map<string, string>()
/** Test seam: the hit cache outlives a test's temp home otherwise. */
export function resetCodexRolloutCacheForTests(): void {
  rolloutCache.clear()
}

/**
 * The rollout of THIS codex session: the file whose name ends in `-<thread id>.jsonl` under the
 * node's own account's `CODEX_HOME/sessions` (`codexHomeFor`: a managed account's private home, or
 * the system `$CODEX_HOME` / `~/.codex`). Keyed strictly by the thread id — there is no cwd or
 * newest-file fallback, because an answer that is "a codex session" rather than "this one" is a
 * stranger's conversation. Symlinks (files or date directories) are not followed, so the answer
 * cannot leave the sessions tree.
 *
 * `hinted` is the hook-fed path a live context tail holds for the id (authoritative when the pane's
 * own `CODEX_HOME` differs from ours). It is used only when its file name names this very thread
 * and it exists — a hint is a shortcut, not a way to point one session at another's file.
 */
export async function locateCodexRollout(
  q: { sessionId?: string; accountId?: string },
  hinted?: (sessionId: string) => string | undefined
): Promise<string | undefined> {
  const id = q.sessionId
  if (!id || !CODEX_THREAD_ID_RE.test(id)) return undefined
  const hint = hinted?.(id)
  if (hint && isRolloutFor(path.basename(hint), id) && (await readable(hint))) return hint
  let root: string
  try {
    root = path.join(codexHomeFor(q.accountId), 'sessions')
  } catch {
    // An account id that cannot name a home (codexAccountHome refuses it): nothing to read, and
    // certainly not the system home.
    return undefined
  }
  const cacheKey = `${root}\0${id}`
  const cached = rolloutCache.get(cacheKey)
  if (cached) {
    if (await readable(cached)) return cached
    rolloutCache.delete(cacheKey)
  }
  // Newest date directory first: the session being read is almost always a recent one.
  const walk = async (dir: string, depth: number): Promise<string | undefined> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return undefined
    }
    for (const e of entries) {
      if (e.isFile() && isRolloutFor(e.name, id)) return path.join(dir, e.name)
    }
    if (depth >= LOCATE_MAX_DEPTH) return undefined
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse()
    for (const d of dirs) {
      const hit = await walk(path.join(dir, d), depth + 1)
      if (hit) return hit
    }
    return undefined
  }
  const found = await walk(root, 0)
  if (found) rolloutCache.set(cacheKey, found)
  return found
}
