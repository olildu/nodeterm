import { describe, expect, it } from 'vitest'
import {
  extractEntryFields,
  makeSnippet,
  queryRegExp,
  searchEntries,
  planRefresh,
  INDEX_TEXT_CAP_BYTES,
  type ScanFile,
  type TranscriptIndexEntry
} from './transcript-index-core'

const raw = [
  JSON.stringify({ type: 'user', cwd: '/Users/me/proj', message: { content: 'fix the tmux config please' } }),
  JSON.stringify({ type: 'assistant', cwd: '/Users/me/proj', message: { content: [{ type: 'text', text: 'editing tmux.conf now' }] } })
].join('\n')

describe('extractEntryFields', () => {
  it('pulls cwd, first-user-message title, and concatenated text', () => {
    const f = extractEntryFields(raw)
    expect(f.cwd).toBe('/Users/me/proj')
    expect(f.title).toBe('fix the tmux config please')
    expect(f.text).toContain('fix the tmux config')
    expect(f.text).toContain('editing tmux.conf now')
  })

  it('trims a long title to ~80 chars and caps text at INDEX_TEXT_CAP_BYTES', () => {
    const long = 'x'.repeat(500)
    const big = Array.from({ length: 5000 }, (_, i) =>
      JSON.stringify({ type: 'user', cwd: '/c', message: { content: long } })
    ).join('\n')
    const f = extractEntryFields(big)
    expect(f.title.length).toBeLessThanOrEqual(80)
    expect(f.text.length).toBeLessThanOrEqual(INDEX_TEXT_CAP_BYTES)
  })

  it('a paste in the first prompt adds no code fences to the title', () => {
    const r = JSON.stringify({ type: 'user', cwd: '/c', message: { content: 'see <pasted_content id="ab12">\nboom\n</pasted_content id="ab12">' } })
    expect(extractEntryFields(r).title).not.toContain('```')
  })

  it('returns empty fields for unparseable input', () => {
    expect(extractEntryFields('garbage\n{bad json')).toEqual({ cwd: '', title: '', text: '' })
  })
})

describe('makeSnippet', () => {
  it('centers on the match and trims', () => {
    const s = makeSnippet('a'.repeat(300) + 'NEEDLE' + 'b'.repeat(300), 'needle')
    expect(s.toLowerCase()).toContain('needle')
    expect(s.length).toBeLessThanOrEqual(170)
  })
})

describe('searchEntries', () => {
  const entries: TranscriptIndexEntry[] = [
    { sessionId: 's1', transcriptPath: '/p/s1.jsonl', cwd: '/Users/me/alpha', mtime: 100, title: 'old tmux work', text: 'tmux mouse mode' },
    { sessionId: 's2', transcriptPath: '/p/s2.jsonl', cwd: '/Users/me/beta', mtime: 200, title: 'recent', text: 'something about TMUX clipboard' }
  ]

  it('matches title+text case-insensitively, newest first, capped', () => {
    const hits = searchEntries(entries, 'tmux', 20)
    expect(hits.map((h) => h.sessionId)).toEqual(['s2', 's1'])
    expect(hits[0].projectLabel).toBe('beta')
    expect(hits[0].snippet.toLowerCase()).toContain('tmux')
  })

  it('returns nothing for queries shorter than 2 chars', () => {
    expect(searchEntries(entries, 't')).toEqual([])
  })

  it('respects the limit', () => {
    expect(searchEntries(entries, 'tmux', 1)).toHaveLength(1)
  })

  it('names the account whose root holds a hit, so its resume runs under that login', () => {
    const hits = searchEntries(entries, 'tmux', 20, (p) => (p === '/p/s1.jsonl' ? 'work' : undefined))
    expect(hits.find((h) => h.sessionId === 's1')?.accountId).toBe('work')
    expect('accountId' in hits.find((h) => h.sessionId === 's2')!).toBe(false)
  })
})

describe('searchEntries matching (RegExp iu)', () => {
  const one = (text: string, title = 'x'): TranscriptIndexEntry[] => [
    { sessionId: 's', transcriptPath: '/p/s.jsonl', cwd: '/c', mtime: 1, title, text }
  ]
  const hit = (text: string, q: string): boolean => searchEntries(one(text), q).length === 1

  it('folds non-ASCII case the way toLowerCase().includes did', () => {
    expect(hit('Ein Café in München', 'CAFÉ IN MÜNCHEN')).toBe(true)
    expect(hit('ПРИВЕТ мир', 'привет МИР')).toBe(true)
    expect(hit('ΑΛΦΑ beta', 'αλφα')).toBe(true)
    expect(hit('日本語のテキスト', '日本語')).toBe(true)
    // The cases plain `i` would have LOST (toLowerCase folds them, simple-uppercase canonicalising
    // does not) — the reason the flag is `iu`.
    expect(hit('temperature in \u212A', 'in k')).toBe(true) // Kelvin sign
    expect(hit('unit \u212B', 'it å')).toBe(true) // Ångström sign
    expect(hit('GROSS\u1E9E', 'sß')).toBe(true) // capital sharp s
    expect(hit('Deseret \u{10400}', 't \u{10428}')).toBe(true) // astral case pair
  })

  it('Turkish İ: an i in the query still matches the dotted capital, as toLowerCase did', () => {
    // 'İ'.toLowerCase() is 'i' + U+0307, so the old lowered copy matched 'türki' inside 'TÜRKİYE';
    // under `iu` İ folds only to itself, so the query's i/I are widened to also take İ.
    expect(hit('Merhaba TÜRKİYE', 'türki')).toBe(true)
    expect(hit('İstanbul trafiği', 'istanbul')).toBe(true)
    expect(hit('İSTANBUL', 'ISTANBUL')).toBe(true)
    // A whole word now matches too (the old copy had U+0307 between the i and the rest).
    expect(hit('TÜRKİYE', 'türkiye')).toBe(true)
    // …and nothing that was a miss before turns into a hit on a different letter.
    expect(hit('TÜRKAYE', 'türki')).toBe(false)
    const [h] = searchEntries(one('z'.repeat(400) + ' TÜRKİYE ' + 'z'.repeat(400)), 'türki')
    expect(h.snippet).toContain('TÜRKİYE')
  })

  it('treats regex metacharacters in the query literally', () => {
    expect(hit('axb', 'a.b')).toBe(false)
    expect(hit('see a.b here', 'A.B')).toBe(true)
    expect(hit('cost $5 (approx)', '$5 (approx)')).toBe(true)
    expect(hit('path\\to\\file', '\\to\\')).toBe(true)
    expect(hit('aaa', 'a*')).toBe(false)
    // Characters that are NOT SyntaxCharacters must stay unescaped: `\-` is a SyntaxError in `u` mode.
    for (const q of ['a-b', 'x]y', 'p}q', 'a/b', 'a\\', 'oops)', '[]', '$^', '((', '{1,2}', '?+|']) {
      expect(() => searchEntries(one('irrelevant'), q)).not.toThrow()
      expect(hit(`pre ${q.toUpperCase()} post`, q)).toBe(true)
    }
  })

  it('a stateless matcher: the same query matches every entry, not every other one', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...one('needle')[0], sessionId: `s${i}`, mtime: i }))
    expect(searchEntries(many, 'needle')).toHaveLength(5)
    const re = queryRegExp('needle')
    expect([re.test('needle'), re.test('needle')]).toEqual([true, true])
  })

  it('centres the snippet on the same match the filter found', () => {
    const [h] = searchEntries(one('z'.repeat(400) + ' the \u212Aelvin scale ' + 'z'.repeat(400)), 'kelvin')
    expect(h.snippet).toContain('\u212Aelvin')
  })
})

describe('planRefresh', () => {
  const prior: TranscriptIndexEntry[] = [
    { sessionId: 'a', transcriptPath: '/p/a.jsonl', cwd: '/c', mtime: 100, title: 't', text: 'x' },
    { sessionId: 'b', transcriptPath: '/p/b.jsonl', cwd: '/c', mtime: 100, title: 't', text: 'x' }
  ]

  it('re-reads new and changed files, keeps unchanged, drops vanished', () => {
    const scan: ScanFile[] = [
      { sessionId: 'a', transcriptPath: '/p/a.jsonl', mtime: 100 }, // unchanged -> keep
      { sessionId: 'b', transcriptPath: '/p/b.jsonl', mtime: 200 }, // changed -> read
      { sessionId: 'c', transcriptPath: '/p/c.jsonl', mtime: 50 }   // new -> read
    ]
    const plan = planRefresh(prior, scan)
    expect(plan.keep.map((e) => e.sessionId)).toEqual(['a'])
    expect(plan.toRead.map((f) => f.sessionId).sort()).toEqual(['b', 'c'])
  })

  it('drops entries whose file is gone (not in scan)', () => {
    const plan = planRefresh(prior, [{ sessionId: 'a', transcriptPath: '/p/a.jsonl', mtime: 100 }])
    expect(plan.keep.map((e) => e.sessionId)).toEqual(['a'])
    expect(plan.toRead).toEqual([])
  })
})
