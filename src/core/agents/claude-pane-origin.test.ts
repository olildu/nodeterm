import { describe, expect, it, vi } from 'vitest'
import {
  classifyClaudeOrigin,
  createPaneOriginGate,
  normalizeTty,
  parseClaudeHookOrigin,
  PANE_TTY_RECHECK_MS,
  PANE_TTY_TTL_MS,
  wireClaudePaneOrigin
} from './claude-pane-origin'

describe('parseClaudeHookOrigin', () => {
  it('reads the three fields the claude script posts', () => {
    expect(parseClaudeHookOrigin({ nodeterm_claude_pid: '42', nodeterm_claude_fg: '1', nodeterm_claude_tty: 'pts/3' }))
      .toEqual({ pid: 42, foreground: true, tty: 'pts/3' })
    expect(parseClaudeHookOrigin({ nodeterm_claude_pid: '42', nodeterm_claude_fg: '0', nodeterm_claude_tty: '' }))
      .toEqual({ pid: 42, foreground: false })
  })
  it('no (or a malformed) fg field is no origin at all: an older script, a ps that could not answer', () => {
    expect(parseClaudeHookOrigin({})).toBeUndefined()
    expect(parseClaudeHookOrigin({ nodeterm_claude_fg: '' })).toBeUndefined()
    expect(parseClaudeHookOrigin({ nodeterm_claude_fg: 'yes' })).toBeUndefined()
  })
  it('drops a hostile pid or tty rather than carrying it', () => {
    expect(parseClaudeHookOrigin({ nodeterm_claude_pid: '1;id', nodeterm_claude_fg: '1', nodeterm_claude_tty: '../../x' }))
      .toEqual({ foreground: true })
  })
})

describe('classifyClaudeOrigin', () => {
  it('the pane\'s own foreground claude is the node\'s', () => {
    expect(classifyClaudeOrigin({ foreground: true, tty: 'pts/3' }, '/dev/pts/3')).toBe('own')
    expect(classifyClaudeOrigin({ foreground: true, tty: 'ttys003' }, '/dev/ttys003')).toBe('own')
  })
  it('#1112: a claude that is not the foreground of any terminal is not', () => {
    expect(classifyClaudeOrigin({ foreground: false }, '/dev/pts/3')).toBe('foreign')
    expect(classifyClaudeOrigin({ foreground: false }, null)).toBe('foreign')
  })
  it('#1153: a claude in the foreground of ANOTHER terminal (Claude\'s daemon pty) is not', () => {
    expect(classifyClaudeOrigin({ foreground: true, tty: 'pts/9' }, '/dev/pts/3')).toBe('foreign')
  })
  it('anything this core cannot judge is unknown, never foreign', () => {
    expect(classifyClaudeOrigin(undefined, '/dev/pts/3')).toBe('unknown')
    expect(classifyClaudeOrigin({ foreground: true }, '/dev/pts/3')).toBe('unknown')
    expect(classifyClaudeOrigin({ foreground: true, tty: 'pts/3' }, null)).toBe('unknown')
  })
  it('normalizeTty', () => {
    expect(normalizeTty('/dev/pts/3')).toBe('pts/3')
    expect(normalizeTty('?')).toBeNull()
    expect(normalizeTty('')).toBeNull()
  })
})

describe('createPaneOriginGate', () => {
  it('admits own, drops foreign, admits unknown — and reads the pane tty once while it agrees', async () => {
    const paneTty = vi.fn(async () => '/dev/pts/3')
    const gate = createPaneOriginGate({ paneTty, log: () => {} })
    expect(await gate.admit('n', { foreground: true, tty: 'pts/3', pid: 1 })).toBe(true)
    expect(await gate.admit('n', { foreground: true, tty: 'pts/3', pid: 1 })).toBe(true)
    expect(paneTty).toHaveBeenCalledTimes(1)
    expect(await gate.admit('n', { foreground: false, pid: 2 })).toBe(false)
    expect(await gate.admit('n', undefined)).toBe(true)
    expect(paneTty).toHaveBeenCalledTimes(1)
  })

  it('without a resolver only the no-terminal half applies', async () => {
    const gate = createPaneOriginGate({ log: () => {} })
    expect(await gate.admit('n', { foreground: false })).toBe(false)
    expect(await gate.admit('n', { foreground: true, tty: 'pts/9' })).toBe(true)
  })

  it('a disagreeing tty is re-read before it is called foreign, so a recreated pane never locks its own claude out', async () => {
    let t = 0
    let tty = '/dev/pts/3'
    const paneTty = vi.fn(async () => tty)
    const gate = createPaneOriginGate({ paneTty, now: () => t, log: () => {} })
    expect(await gate.admit('n', { foreground: true, tty: 'pts/3' })).toBe(true)
    // The pane is recreated under a new tty; past the recheck window the new tty is read.
    tty = '/dev/pts/7'
    t += PANE_TTY_RECHECK_MS
    expect(await gate.admit('n', { foreground: true, tty: 'pts/7' })).toBe(true)
    expect(paneTty).toHaveBeenCalledTimes(2)
  })

  it('a foreign process posting steadily costs one pane read per recheck window, not one per event', async () => {
    let t = 0
    const paneTty = vi.fn(async () => '/dev/pts/3')
    const gate = createPaneOriginGate({ paneTty, now: () => t, log: () => {} })
    await gate.admit('n', { foreground: true, tty: 'pts/3' })
    for (let i = 0; i < 5; i++) expect(await gate.admit('n', { foreground: true, tty: 'pts/9' })).toBe(false)
    expect(paneTty).toHaveBeenCalledTimes(1)
    t += PANE_TTY_TTL_MS
    expect(await gate.admit('n', { foreground: true, tty: 'pts/9' })).toBe(false)
    expect(paneTty).toHaveBeenCalledTimes(2)
  })

  it('forgetNode drops the cached tty (a recycle/destroy hands the node a new pane)', async () => {
    let tty = '/dev/pts/3'
    const paneTty = vi.fn(async () => tty)
    const gate = createPaneOriginGate({ paneTty, log: () => {} })
    await gate.admit('n', { foreground: true, tty: 'pts/3' })
    tty = '/dev/pts/7'
    gate.forgetNode('n')
    expect(await gate.admit('n', { foreground: true, tty: 'pts/7' })).toBe(true)
  })

  it('a pane that cannot be read is unknown (admitted) and is not re-read on every event', async () => {
    const paneTty = vi.fn(async () => null)
    const gate = createPaneOriginGate({ paneTty, log: () => {} })
    expect(await gate.admit('n', { foreground: true, tty: 'pts/9' })).toBe(true)
    expect(await gate.admit('n', { foreground: true, tty: 'pts/9' })).toBe(true)
    expect(paneTty).toHaveBeenCalledTimes(1)
  })

  it('a resolver that throws or hangs is unknown, never foreign', async () => {
    vi.useFakeTimers()
    try {
      const gate = createPaneOriginGate({ paneTty: () => new Promise(() => {}), log: () => {} })
      const p = gate.admit('n', { foreground: true, tty: 'pts/9' })
      await vi.advanceTimersByTimeAsync(2_500)
      expect(await p).toBe(true)
    } finally {
      vi.useRealTimers()
    }
    const gate2 = createPaneOriginGate({ paneTty: async () => { throw new Error('x') }, log: () => {} })
    expect(await gate2.admit('n', { foreground: true, tty: 'pts/9' })).toBe(true)
  })

  it('keeps each node\'s events in arrival order while a pane read is pending', async () => {
    let release: (v: string) => void = () => {}
    const paneTty = vi.fn(() => new Promise<string>((r) => { release = r }))
    const gate = createPaneOriginGate({ paneTty, log: () => {} })
    const order: string[] = []
    const a = gate.admit('n', { foreground: true, tty: 'pts/3' }).then((ok) => order.push(`a:${ok}`))
    const b = gate.admit('n', undefined).then((ok) => order.push(`b:${ok}`))
    const other = gate.admit('m', undefined).then((ok) => order.push(`m:${ok}`))
    await other
    expect(order).toEqual(['m:true'])
    release('/dev/pts/3')
    await Promise.all([a, b])
    expect(order).toEqual(['m:true', 'a:true', 'b:true'])
  })
})

describe('wireClaudePaneOrigin', () => {
  it('reads the pane tty from paneOwner, and never for a node it cannot read honestly', async () => {
    let resolver: ((id: string) => Promise<string | null>) | undefined
    const forgotten: string[] = []
    const handlers = new Map<string, (id: string) => void>()
    const paneOwner = vi.fn(async () => ({ tty: '/dev/pts/3' }))
    wireClaudePaneOrigin({
      hooks: { setPaneTtyResolver: (fn) => { resolver = fn }, forgetPaneOrigin: (id) => forgotten.push(id) },
      paneOwner,
      // An SSH-project node with no live client: paneOwner would read the LOCAL socket.
      cannotRead: (id) => id === 'remote-idle',
      on: (ch, cb) => handlers.set(ch, cb),
      destroyChannel: 'destroy',
      recycleChannel: 'recycle'
    })
    expect(await resolver!('local')).toBe('/dev/pts/3')
    expect(await resolver!('remote-idle')).toBeNull()
    expect(paneOwner).toHaveBeenCalledTimes(1)
    handlers.get('destroy')!('a')
    handlers.get('recycle')!('b')
    expect(forgotten).toEqual(['a', 'b'])
  })
})
