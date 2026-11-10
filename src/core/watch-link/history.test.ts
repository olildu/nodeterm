import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatTranscriptResult } from '../../shared/types'
import { HISTORY_MESSAGES_MAX } from '../../shared/watch-link/protocol'
import { historyPageFrom } from './history'

const SINCE = 10_000
const text = (role: 'user' | 'assistant', at: number | undefined, t: string, key?: number): ChatMessage => ({
  role,
  parts: [{ kind: 'text', text: t }],
  ...(at === undefined ? {} : { at }),
  ...(key === undefined ? {} : { key })
})
const read = (messages: ChatMessage[], olderCursor: number | null = null, found = true): { kind: 'page'; result: ChatTranscriptResult } => ({
  kind: 'page',
  result: { messages, found, olderCursor, unmatchedResults: [] }
})

describe('historyPageFrom', () => {
  it('keeps only what was written at or after the link was created', () => {
    const p = historyPageFrom(read([text('user', 9_999, 'before'), text('user', 10_000, 'at'), text('assistant', 12_000, 'after')], 400), SINCE, null)
    expect(p.status).toBe('ok')
    expect(p.messages.map((m) => (m.parts[0] as { text: string }).text)).toEqual(['at', 'after'])
    // The window reached the link's creation: no paging past it, whatever the transcript says.
    expect(p.olderCursor).toBeNull()
    expect(p.start).toBe('shared')
  })

  it('pages on while the window is entirely after the link', () => {
    const p = historyPageFrom(read([text('user', 11_000, 'a'), text('assistant', 12_000, 'b')], 4096), SINCE, null)
    expect(p.olderCursor).toBe(4096)
    expect(p.start).toBeNull()
  })

  it('says the conversation started when the transcript has nothing older', () => {
    const p = historyPageFrom(read([text('user', 11_000, 'a')], null), SINCE, 9000)
    expect(p).toMatchObject({ before: 9000, olderCursor: null, start: 'conversation' })
  })

  it('never sends a message with no time, and calls a wholly untimed conversation untimed', () => {
    expect(historyPageFrom(read([text('user', undefined, 'x'), text('assistant', 11_000, 'y')]), SINCE, null).messages).toHaveLength(1)
    const p = historyPageFrom(read([text('user', undefined, 'x'), text('assistant', undefined, 'y')]), SINCE, null)
    expect(p.status).toBe('untimed')
    expect(p.messages).toEqual([])
  })

  it('sends tool names and arguments, a plan body, but never a result or thinking', () => {
    const m: ChatMessage = {
      role: 'assistant',
      at: 11_000,
      parts: [
        { kind: 'thinking', text: 'secret reasoning' },
        { kind: 'tool', name: 'Bash', arg: 'cat .env', result: 'TOKEN=abc' },
        { kind: 'tool', name: 'ExitPlanMode', arg: '', body: '## Plan\n1. do it' }
      ]
    }
    const p = historyPageFrom(read([m]), SINCE, null)
    expect(p.messages[0].parts).toEqual([
      { kind: 'tool', name: 'Bash', arg: 'cat .env' },
      { kind: 'tool', name: 'ExitPlanMode', arg: '' },
      { kind: 'text', text: '## Plan\n1. do it' }
    ])
    expect(JSON.stringify(p)).not.toContain('TOKEN=abc')
    expect(JSON.stringify(p)).not.toContain('secret reasoning')
  })

  it('a newest page with no transcript is an empty conversation; an older one is a failed read', () => {
    expect(historyPageFrom(read([], null, false), SINCE, null)).toMatchObject({ status: 'ok', messages: [], start: 'conversation' })
    expect(historyPageFrom(read([], null, false), SINCE, 500).status).toBe('error')
  })

  it('reports a failed read and a node with no conversation', () => {
    expect(historyPageFrom(null, SINCE, null).status).toBe('error')
    expect(historyPageFrom({ kind: 'unsupported' }, SINCE, null).status).toBe('unsupported')
  })

  it('past the message cap, pages on from the oldest message kept', () => {
    const many = Array.from({ length: HISTORY_MESSAGES_MAX + 3 }, (_, i) => text('assistant', 11_000 + i, `m${i}`, 1000 + i * 10))
    const p = historyPageFrom(read(many, 900), SINCE, null)
    expect(p.messages).toHaveLength(HISTORY_MESSAGES_MAX)
    expect((p.messages[0].parts[0] as { text: string }).text).toBe('m3')
    expect(p.olderCursor).toBe(1030)
  })

  it('past the message cap on a reader that does not page, says it was cut', () => {
    const many = Array.from({ length: HISTORY_MESSAGES_MAX + 1 }, (_, i) => text('assistant', 11_000 + i, `m${i}`))
    const p = historyPageFrom(read(many, null), SINCE, null)
    expect(p).toMatchObject({ olderCursor: null, start: 'cut' })
  })

  it('cleans what it sends: no escape sequence reaches the page', () => {
    const p = historyPageFrom(read([text('assistant', 11_000, 'ok\x1b]52;c;Zm9v\x07 done')]), SINCE, null)
    expect((p.messages[0].parts[0] as { text: string }).text).toBe('ok]52;c;Zm9v done')
  })
})
