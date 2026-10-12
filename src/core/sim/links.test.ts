import { describe, expect, it } from 'vitest'
import { createSimLinkLedger, defaultSimTarget, linkedSimulatorIds, shouldAutoLink } from './links'

describe('linkedSimulatorIds', () => {
  const sims = ['s1', 's2', 's3']
  it('reads persisted bridges in either direction, in canvas order', () => {
    expect(
      linkedSimulatorIds('a', sims, [
        { source: 's3', target: 'a' },
        { source: 'a', target: 's1' }
      ])
    ).toEqual(['s1', 's3'])
  })
  it('ignores other agents\' links and links to things that are not this project\'s Simulator nodes', () => {
    expect(linkedSimulatorIds('a', sims, [{ source: 's1', target: 'b' }, { source: 'a', target: 'elsewhere' }])).toEqual([])
  })
  it('adds what this run auto-linked before the autosave, and forgets what the user removed', () => {
    const ledger = createSimLinkLedger()
    ledger.noteAutoLinked('a', 's2')
    expect(linkedSimulatorIds('a', sims, [], ledger)).toEqual(['s2'])
    ledger.noteRemoved('a', 's2')
    expect(linkedSimulatorIds('a', sims, [], ledger)).toEqual([])
  })
  it('an auto-link record for a node no longer in the project is not a link', () => {
    const ledger = createSimLinkLedger()
    ledger.noteAutoLinked('a', 'gone')
    expect(linkedSimulatorIds('a', sims, [], ledger)).toEqual([])
  })
})

describe('defaultSimTarget', () => {
  it('0 / 1 / many', () => {
    expect(defaultSimTarget([])).toEqual({ ok: false, reason: 'none', candidates: [] })
    expect(defaultSimTarget(['s1'])).toEqual({ ok: true, node: 's1' })
    expect(defaultSimTarget(['s1', 's2'])).toEqual({ ok: false, reason: 'several', candidates: ['s1', 's2'] })
  })
})

describe('the ledger and shouldAutoLink', () => {
  it('a removal outranks a later auto-link record (never re-created this run)', () => {
    const l = createSimLinkLedger()
    l.noteRemoved('a', 's1')
    l.noteAutoLinked('a', 's1')
    expect(l.autoLinked('a', 's1')).toBe(false)
    expect(shouldAutoLink('a', 's1', [], l, true)).toBe(false)
  })
  it('is per agent AND node', () => {
    const l = createSimLinkLedger()
    l.noteRemoved('a', 's1')
    expect(shouldAutoLink('a', 's2', [], l, true)).toBe(true)
    expect(shouldAutoLink('b', 's1', [], l, true)).toBe(true)
  })
  it('needs a linkable caller and a pair that is not already linked', () => {
    const l = createSimLinkLedger()
    expect(shouldAutoLink('a', 's1', [], l, false)).toBe(false)
    expect(shouldAutoLink('a', 's1', ['s1'], l, true)).toBe(false)
    expect(shouldAutoLink('a', 's1', ['s2'], l, true)).toBe(true)
  })
})
