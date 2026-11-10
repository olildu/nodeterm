// @vitest-environment jsdom
// "This node hit an error — This API only accepts positive integers" when typing in the find bar of
// a Claude node. Claude Code draws in the ALTERNATE screen, and xterm trims a buffer's lines on a
// narrowing resize only when that buffer reflows (`Buffer.resize`, `_isReflowEnabled`) — the
// alternate buffer has no scrollback, so it never does. Its lines keep their old length, the search
// addon reads the cells past the right edge as text, and for a hit there its decoration width
// (`cols - col`) goes negative: `registerDecoration` throws, and the node's error boundary takes the
// whole node down. These drive a REAL xterm and the real search addon, so the failure is theirs.
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { Terminal } from '@xterm/xterm'
import { SearchAddon } from '@xterm/addon-search'
import { patchShrinkTrim } from './shrink-trim'

const DECORATIONS = {
  matchBackground: '#ffd60a55',
  activeMatchBackground: '#ff9f0a',
  matchOverviewRuler: '#ffd60a',
  activeMatchColorOverviewRuler: '#ff9f0a'
}
const ALT_SCREEN = '\x1b[?1049h'

let host: HTMLDivElement | undefined
afterEach(() => host?.remove())

function open(cols: number): { term: Terminal; search: SearchAddon } {
  ;(window as unknown as { matchMedia?: unknown }).matchMedia ??= () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {}
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  const term = new Terminal({ cols, rows: 5, allowProposedApi: true })
  const search = new SearchAddon()
  term.loadAddon(search)
  term.open(host)
  return { term, search }
}

const write = (term: Terminal, data: string): Promise<void> => new Promise((r) => term.write(data, r))

/** Run a find the way the find bar does and report how many hits xterm counted. */
function find(search: SearchAddon, query: string): number {
  let count = -1
  const sub = search.onDidChangeResults((r) => (count = r.resultCount))
  try {
    search.findNext(query, { decorations: DECORATIONS, incremental: true })
  } finally {
    sub.dispose()
  }
  return count
}

describe('patchShrinkTrim', () => {
  it('reproduces the crash without the patch (guards the test itself)', async () => {
    const { term, search } = open(130)
    await write(term, ALT_SCREEN + 'x'.repeat(120) + ' s')
    term.resize(100, 5)
    expect(() => find(search, 's')).toThrow('This API only accepts positive integers')
  })

  it('a find after narrowing an alternate-screen terminal no longer throws', async () => {
    const { term, search } = open(130)
    patchShrinkTrim(term)
    await write(term, ALT_SCREEN + 'x'.repeat(120) + ' s')
    term.resize(100, 5)
    expect(() => find(search, 's')).not.toThrow()
  })

  it('text cut off by the narrowing is no longer counted as a hit', async () => {
    const { term, search } = open(130)
    patchShrinkTrim(term)
    await write(term, ALT_SCREEN + 'x'.repeat(120) + ' s')
    term.resize(100, 5)
    expect(find(search, 's')).toBe(0)
  })

  it('hits that are still on screen are found and highlighted as before', async () => {
    const { term, search } = open(130)
    patchShrinkTrim(term)
    await write(term, ALT_SCREEN + 'a s b' + 'x'.repeat(110) + ' s')
    term.resize(100, 5)
    expect(find(search, 's')).toBe(1)
  })

  it('the normal buffer needs no patch: xterm trims it itself', async () => {
    const { term, search } = open(130)
    await write(term, 'x'.repeat(120) + ' s')
    term.resize(100, 5)
    expect(() => find(search, 's')).not.toThrow()
    expect(term.buffer.active.getLine(0)!.translateToString(false)).toHaveLength(100)
  })

  it('widening again shows blank cells, not the text that was cut off', async () => {
    const { term } = open(130)
    patchShrinkTrim(term)
    await write(term, ALT_SCREEN + 'x'.repeat(120) + ' s')
    term.resize(100, 5)
    term.resize(130, 5)
    expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe('x'.repeat(100))
  })

  it('a wide character cut by the new edge does not break the trim or the find', async () => {
    const { term, search } = open(130)
    patchShrinkTrim(term)
    // '日' is two cells wide and lands on columns 99–100: the narrowing to 100 cuts through it.
    await write(term, ALT_SCREEN + 'x'.repeat(99) + '日 s')
    term.resize(100, 5)
    expect(() => find(search, 's')).not.toThrow()
    expect(find(search, '日')).toBe(1)
    expect(term.buffer.active.getLine(0)!.length).toBe(100)
  })

  it('is idempotent and fails open on a terminal without the expected internals', async () => {
    const { term, search } = open(130)
    expect(patchShrinkTrim(term)).toBe(true)
    expect(patchShrinkTrim(term)).toBe(true)
    await write(term, ALT_SCREEN + 'x'.repeat(120) + ' s')
    term.resize(100, 5)
    expect(() => find(search, 's')).not.toThrow()
    expect(patchShrinkTrim({} as Terminal)).toBe(false)
  })
})

describe('wiring', () => {
  const src = (rel: string): string => readFileSync(resolve(__dirname, rel), 'utf8')
  it.each([
    ['TerminalNode', '../nodes/TerminalNode.tsx'],
    ['ModalTerminal', '../components/kanban/ModalTerminal.tsx']
  ])('%s patches every terminal it creates', (_name, rel) => {
    expect(src(rel)).toMatch(/patchShrinkTrim\(term\)/)
  })
})
