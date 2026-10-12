// Parser tests for the context-link transcript renderers.
//
// FIXTURE PROVENANCE — `__fixtures__/grok/chat_history.jsonl` is REAL. It was cut from a live grok
// 1.0.13 session (576 messages, a logged-in account) on 2026-09-01: 21 lines chosen to cover all
// eight line shapes that session contains, with home paths, usernames and session UUIDs redacted
// and long text truncated. NO KEY WAS ALTERED and no line was authored by hand — except one
// deliberately truncated JSON line, added to exercise the malformed-line counter.
//
// It is real for a reason this project paid for: in task03 the grok hook tests asserted against
// payloads WE had written from grok's shipped docs, so they pinned our reading of the documentation
// instead of the agent's behaviour, and a feature that was dead on every real payload stayed green
// through TDD, an independent review and a QA sign-off. A fixture the agent produced cannot agree
// with us out of politeness.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { linesFromGrok, renderContextLink, renderTranscriptLines, type ContextLinkFetch } from './context-link-render'
import type { LinkDoc, LinkDocEntry } from './context-link-core'

const buf = readFileSync(path.join(__dirname, '__fixtures__/grok/chat_history.jsonl'), 'utf8')

describe('linesFromGrok over a real chat_history.jsonl', () => {
  it('renders user prompts and assistant text in file order', () => {
    const lines = linesFromGrok(buf)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some((l) => l.startsWith('user: '))).toBe(true)
    expect(lines.some((l) => l.startsWith('assistant: '))).toBe(true)
    // Order is the file's own: the first rendered line comes from the first renderable record.
    const firstRenderable = buf
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as { type?: string }
        } catch {
          return undefined
        }
      })
      .find((o) => o && (o.type === 'user' || o.type === 'assistant' || o.type === 'system'))
    expect(firstRenderable).toBeDefined()
    expect(lines[0].startsWith(`${firstRenderable!.type === 'assistant' ? 'assistant' : firstRenderable!.type}: `)).toBe(
      true
    )
  })

  it('reads `content` in BOTH shapes: a bare string and an array of parts carrying `.text`', () => {
    const arrayLine = buf
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as { type?: string; content?: unknown }
        } catch {
          return undefined
        }
      })
      .find((o) => o && Array.isArray(o.content))
    expect(arrayLine, 'the fixture must contain an array-content line or this test proves nothing').toBeDefined()
    const text = (arrayLine!.content as { text?: string }[])[0].text!.slice(0, 24)
    expect(linesFromGrok(buf).some((l) => l.includes(text))).toBe(true)
  })

  it('never attributes harness-injected text to the human', () => {
    // grok files these under `type: 'user'` and marks them with `synthetic_reason`. Measured
    // vocabulary across every local session: system_reminder, compaction_meta,
    // project_instructions, task_completed — 60 lines, all of them `user`, none of them typed by
    // a person. This reader feeds context-link and transfer, so "the other agent's user said X"
    // has to mean a human said X.
    const lines = linesFromGrok(buf)
    expect(lines.some((l) => l.startsWith('user: <system-reminder>'))).toBe(false)
    expect(lines.some((l) => l.includes('<system-reminder>') && l.startsWith('user: '))).toBe(false)
  })

  it('labels each injected line with its own reason, including one it has never seen', () => {
    const lines = linesFromGrok(buf)
    for (const reason of ['system_reminder', 'compaction_meta', 'project_instructions', 'task_completed']) {
      expect(lines.some((l) => l.startsWith(`${reason}: `)), `no line rendered for ${reason}`).toBe(true)
    }
    // The rule is "carries synthetic_reason ⇒ not the human", not a table of the four values we
    // happened to observe: an unmeasured future reason must still not land on `user`.
    const future = JSON.stringify({ type: 'user', content: 'x', synthetic_reason: 'not_yet_invented' })
    expect(linesFromGrok(future)).toEqual(['not_yet_invented: x'])
  })

  it('renders tool calls and tool results, distinctly from prose', () => {
    const lines = linesFromGrok(buf)
    expect(lines.some((l) => l.startsWith('  $ '))).toBe(true)
    expect(lines.some((l) => l.startsWith('  = '))).toBe(true)
  })

  it('renders a backend tool call (web search) by its query', () => {
    expect(linesFromGrok(buf).some((l) => l.startsWith('  $ web_search'))).toBe(true)
  })

  it('never emits the encrypted reasoning payload', () => {
    expect(buf).toContain('encrypted_content')
    expect(linesFromGrok(buf).join('\n')).not.toContain('encrypted_content')
  })

  it('counts malformed lines instead of dropping them silently', () => {
    expect(linesFromGrok.skipped(buf)).toBe(1)
    // A malformed line must not cost the lines around it.
    expect(linesFromGrok(buf).length).toBeGreaterThan(5)
  })

  it('is routed by agent id, with no call-site comparison', () => {
    expect(renderTranscriptLines('grok', buf)).toEqual(linesFromGrok(buf))
  })
})

describe('a linked Simulator node', () => {
  const entry = (over: Partial<LinkDocEntry> = {}): LinkDocEntry => ({
    id: 'dev',
    title: 'Phone',
    cwd: '',
    transcriptPath: '',
    tmux: '',
    simulator: { udid: 'AE342EEF-B624-4060-B9E6-AE6E9EAAC24A', name: 'iPhone 15' },
    ...over
  })
  const doc = (links: LinkDocEntry[]): LinkDoc => ({ self: { id: 'a' }, links, tmuxBin: null, tmuxSocket: 's' })
  const noFetch: ContextLinkFetch = {
    transcript: async () => { throw new Error('a device has no transcript') },
    terminal: async () => { throw new Error('a device has no terminal') },
    opencodeExport: async () => { throw new Error('not opencode') }
  }

  it('list marks it with the device', async () => {
    const out = await renderContextLink(doc([entry()]), 'list', {}, noFetch)
    expect(out).toContain('- Phone (simulator: iPhone 15) (id: dev)')
  })
  it('summary prints the device state the shell read — and never touches a transcript', async () => {
    const out = await renderContextLink(doc([entry()]), 'summary', {}, {
      ...noFetch,
      simulator: async () => 'iPhone 15 · iOS 26.5 · booted'
    })
    expect(out).toContain('=== Phone — simulator ===')
    expect(out).toContain('iPhone 15 · iOS 26.5 · booted')
    expect(out).toMatch(/default target/)
  })
  it('transcript prints the same; terminal says there is none', async () => {
    const f = { ...noFetch, simulator: async () => 'iPhone 15 · iOS 26.5 · shut down' }
    expect(await renderContextLink(doc([entry()]), 'transcript', {}, f)).toContain('shut down')
    expect(await renderContextLink(doc([entry()]), 'terminal', {}, f)).toMatch(/no terminal/)
  })
  it('degrades honestly when the state cannot be read or no device is chosen', async () => {
    expect(await renderContextLink(doc([entry()]), 'summary', {}, noFetch)).toContain('state could not be read')
    const bare = entry({ simulator: {} })
    expect(await renderContextLink(doc([bare]), 'summary', {}, noFetch)).toContain('No device is chosen')
    expect(await renderContextLink(doc([bare]), 'list', {}, noFetch)).toContain('- Phone (simulator) (id: dev)')
  })
  it('is picked by --node like any other entry, and several linked nodes still need --node', async () => {
    const agent = entry({ id: 'x', title: 'Other', simulator: undefined, agent: 'claude' })
    const multi = await renderContextLink(doc([entry(), agent]), 'summary', {}, noFetch)
    expect(multi).toContain('Several linked nodes')
    expect(multi).toContain('Phone (simulator: iPhone 15)')
  })
})
