import { describe, expect, it } from 'vitest'
import {
  HISTORY_MESSAGES_MAX,
  HISTORY_PARTS_MAX,
  HISTORY_TEXT_MAX,
  HISTORY_TOOL_ARG_MAX,
  WATCH_EVENT,
  WATCH_HISTORY_CAST,
  readHistoryPage,
  readHistoryRequest,
  sanitizeHistoryText
} from './protocol'

const msg = (role: 'user' | 'assistant', at: number, text: string) => ({ role, at, parts: [{ kind: 'text', text }] })
const page = (over: Record<string, unknown> = {}) => ({
  before: null,
  status: 'ok',
  since: 1000,
  messages: [msg('user', 1500, 'hi')],
  olderCursor: null,
  start: 'shared',
  ...over
})

describe('watch:history names', () => {
  it('is a watch: cast and event, never the owner namespace', () => {
    expect(WATCH_HISTORY_CAST).toBe('watch:history')
    expect(WATCH_EVENT.history).toBe('watch:history')
    expect(WATCH_HISTORY_CAST.startsWith('watchLink:')).toBe(false)
  })
})

describe('sanitizeHistoryText', () => {
  it('keeps newlines and tabs, drops CR, other controls, ESC and bidi controls', () => {
    expect(sanitizeHistoryText('a\r\nb\tc\x1b[31md‮e\u0007', 100)).toBe('a\nb\tc[31mde')
  })
  it('caps by code point and marks the cut', () => {
    const out = sanitizeHistoryText('😀'.repeat(10), 7)
    expect(out).toBe('😀😀😀…')
    expect(out!.length).toBeLessThanOrEqual(7)
  })
  it('answers null for a non-string or an empty result', () => {
    expect(sanitizeHistoryText(5, 10)).toBeNull()
    expect(sanitizeHistoryText('\x00\x01', 10)).toBeNull()
  })
})

describe('readHistoryRequest', () => {
  it('reads an absent or a non-negative integer cursor', () => {
    expect(readHistoryRequest(undefined)).toEqual({ before: null })
    expect(readHistoryRequest({})).toEqual({ before: null })
    expect(readHistoryRequest({ before: 42 })).toEqual({ before: 42 })
  })
  it('refuses anything else', () => {
    for (const before of [-1, 1.5, '3', Number.NaN, Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(readHistoryRequest({ before })).toBeNull()
    }
    expect(readHistoryRequest('x')).toBeNull()
  })
})

describe('readHistoryPage', () => {
  it('reads a well-formed page', () => {
    expect(readHistoryPage(page())).toEqual(page())
  })
  it('refuses an unknown status or start, or a bad cursor', () => {
    expect(readHistoryPage(page({ status: 'nope' }))).toBeNull()
    expect(readHistoryPage(page({ start: 'nope' }))).toBeNull()
    expect(readHistoryPage(page({ olderCursor: -3 }))).toBeNull()
    expect(readHistoryPage(page({ before: 'x' }))).toBeNull()
    expect(readHistoryPage(null)).toBeNull()
  })
  it('drops a message before the link was shared, or with no time', () => {
    const p = readHistoryPage(page({ messages: [msg('user', 999, 'old'), { role: 'user', parts: [] }, msg('assistant', 1000, 'new')] }))
    expect(p!.messages).toEqual([msg('assistant', 1000, 'new')])
  })
  it('drops a malformed part and a message left with none', () => {
    const p = readHistoryPage(
      page({
        messages: [
          { role: 'assistant', at: 1200, parts: [{ kind: 'html', text: '<b>' }, { kind: 'text', text: 'ok' }] },
          { role: 'assistant', at: 1300, parts: [{ kind: 'text', text: '\x00' }] },
          { role: 'system', at: 1400, parts: [{ kind: 'text', text: 'x' }] }
        ]
      })
    )
    expect(p!.messages).toEqual([{ role: 'assistant', at: 1200, parts: [{ kind: 'text', text: 'ok' }] }])
  })
  it('caps tool names and args, parts and messages', () => {
    const p = readHistoryPage(
      page({
        messages: Array.from({ length: HISTORY_MESSAGES_MAX + 5 }, (_, i) => ({
          role: 'assistant',
          at: 2000 + i,
          parts: Array.from({ length: HISTORY_PARTS_MAX + 3 }, () => ({ kind: 'tool', name: 'Bash', arg: 'x'.repeat(HISTORY_TOOL_ARG_MAX * 2) }))
        }))
      })
    )
    expect(p!.messages).toHaveLength(HISTORY_MESSAGES_MAX)
    // The NEWEST are kept: the oldest five go.
    expect(p!.messages[0].at).toBe(2005)
    expect(p!.messages[0].parts).toHaveLength(HISTORY_PARTS_MAX)
    const tool = p!.messages[0].parts[0] as { arg: string }
    expect(tool.arg.length).toBeLessThanOrEqual(HISTORY_TOOL_ARG_MAX)
  })
  it('caps a text part', () => {
    const p = readHistoryPage(page({ messages: [msg('assistant', 1500, 'y'.repeat(HISTORY_TEXT_MAX + 50))] }))
    const text = (p!.messages[0].parts[0] as { text: string }).text
    expect(text.length).toBeLessThanOrEqual(HISTORY_TEXT_MAX)
    expect(text.endsWith('…')).toBe(true)
  })
  it('a status other than ok carries no messages', () => {
    expect(readHistoryPage(page({ status: 'error' }))!.messages).toEqual([])
  })
})
