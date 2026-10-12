import { describe, expect, it } from 'vitest'
import { applySimDrive, drivenPairs } from './simDriving'

const drive = (ids: string[], until: number, owner = 'agent') => ({ kind: 'drive' as const, ownerNodeId: owner, simNodeIds: ids, until })

describe('simDriving', () => {
  it('a drive event opens a window per node; the end-of-call event REPLACES it with the short linger', () => {
    const start = applySimDrive({}, drive(['s1'], 20_000), 1_000)
    expect(start.s1).toEqual({ ownerNodeId: 'agent', until: 20_000 })
    const end = applySimDrive(start, drive(['s1'], 5_000), 2_000)
    expect(end.s1.until).toBe(5_000)
  })
  it('is bounded: lapsed entries are swept and an already-lapsed event opens nothing', () => {
    const e = applySimDrive({ old: { ownerNodeId: 'x', until: 500 } }, drive(['s1'], 9_000), 1_000)
    expect(Object.keys(e)).toEqual(['s1'])
    expect(applySimDrive(e, drive(['s2'], 900), 1_000)).toEqual(e)
    expect(drivenPairs(e, 9_001).size).toBe(0)
  })
  it('the edge matches on device>agent and only while the window is open', () => {
    const e = applySimDrive({}, drive(['s1', 's2'], 8_000), 1_000)
    expect([...drivenPairs(e, 2_000)].sort()).toEqual(['s1>agent', 's2>agent'])
    expect(drivenPairs(e, 8_000).size).toBe(0)
  })
  it('ignores an auto-link event', () => {
    const e = applySimDrive({}, { kind: 'auto-link', projectId: 'p', ownerNodeId: 'a', simNodeId: 's' }, 1)
    expect(e).toEqual({})
  })
})

describe('what the node draws while driven', () => {
  const ev = (over: Record<string, unknown>) =>
    ({ kind: 'drive', ownerNodeId: 'a', simNodeIds: ['s'], until: 10_000, ...over }) as never
  it('keeps the action and the latest tap, and bumps the tap seq per new tap', () => {
    let e = applySimDrive({}, ev({ action: 'sim --tap-label "General"' }), 0)
    e = applySimDrive(e, ev({ action: 'sim --tap-label "General"', tap: { x: 10, y: 20 } }), 1)
    expect(e.s.tap).toMatchObject({ x: 10, y: 20 })
    const seq1 = e.s.tap!.seq
    // the settle update carries no point: the marker must survive it
    e = applySimDrive(e, ev({ action: 'waiting for the screen to settle' }), 2)
    expect(e.s.action).toBe('waiting for the screen to settle')
    expect(e.s.tap).toMatchObject({ x: 10, y: 20, seq: seq1 })
    e = applySimDrive(e, ev({ tap: { x: 30, y: 40 } }), 3)
    expect(e.s.tap!.seq).toBeGreaterThan(seq1)
  })
  it('drops everything when the window lapses', () => {
    const e = applySimDrive({}, ev({ tap: { x: 1, y: 1 } }), 0)
    expect(applySimDrive(e, ev({ until: 5, simNodeIds: [] }), 20_000)).toEqual({})
  })
})
