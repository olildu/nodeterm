// Issue #852: a context link may be one-way. These pin the pure "who reads whom" rule that both
// shells (desktop renderer, Server Edition) derive the read-authorization map from.
import { describe, it, expect } from 'vitest'
import { classifyLink, gainedReaders, LINK_NOT_LINKABLE, linkReadPairs, planBridges, withLinkReader, type LinkEndpoint } from './canvas-link'

describe('linkReadPairs', () => {
  it('a link without a reader is bidirectional (every link persisted before #852)', () => {
    expect(linkReadPairs({ source: 'a', target: 'b' })).toEqual([
      { reader: 'a', read: 'b' },
      { reader: 'b', read: 'a' }
    ])
  })

  it('reader = source: only the source reads the target', () => {
    expect(linkReadPairs({ source: 'a', target: 'b', reader: 'a' })).toEqual([
      { reader: 'a', read: 'b' }
    ])
  })

  it('reader = target: only the target reads the source', () => {
    expect(linkReadPairs({ source: 'a', target: 'b', reader: 'b' })).toEqual([
      { reader: 'b', read: 'a' }
    ])
  })

  it('fails closed on a reader that is not an endpoint (hand-edited or corrupt project.json)', () => {
    expect(linkReadPairs({ source: 'a', target: 'b', reader: 'c' })).toEqual([])
    expect(linkReadPairs({ source: 'a', target: 'b', reader: '' })).toEqual([])
    expect(
      linkReadPairs({ source: 'a', target: 'b', reader: 42 as unknown as string })
    ).toEqual([])
  })
})

describe('withLinkReader', () => {
  const edge = { id: 'bridge-a-b', source: 'a', target: 'b' }

  it('sets a reader on a copy, never mutating the input', () => {
    const next = withLinkReader(edge, 'b')
    expect(next).toEqual({ id: 'bridge-a-b', source: 'a', target: 'b', reader: 'b' })
    expect(edge).toEqual({ id: 'bridge-a-b', source: 'a', target: 'b' })
  })

  it('null returns the link to bidirectional by dropping the field entirely', () => {
    const next = withLinkReader({ ...edge, reader: 'a' }, null)
    expect(next).toEqual(edge)
    expect('reader' in next).toBe(false)
  })

  it('ignores a reader that is not an endpoint', () => {
    expect(withLinkReader(edge, 'z')).toBe(edge)
  })
})

describe('gainedReaders', () => {
  it('flipping one-way hands read access to the other side only', () => {
    expect(
      gainedReaders({ source: 'a', target: 'b', reader: 'a' }, { source: 'a', target: 'b', reader: 'b' })
    ).toEqual(['b'])
  })

  it('both → one-way grants nobody anything new', () => {
    expect(
      gainedReaders({ source: 'a', target: 'b' }, { source: 'a', target: 'b', reader: 'a' })
    ).toEqual([])
  })

  it('one-way → both grants the former non-reader', () => {
    expect(
      gainedReaders({ source: 'a', target: 'b', reader: 'a' }, { source: 'a', target: 'b' })
    ).toEqual(['b'])
  })
})

describe('planBridges oneWay', () => {
  const lookup = (id: string) =>
    id === 's1' ? { kind: 'sticky', contextCapable: false } : { kind: 'terminal', contextCapable: true }

  it('a one-way context bridge makes --from the only reader', () => {
    const plan = planBridges('n1', ['n2'], lookup, [], { oneWay: true })
    expect(plan.edges).toEqual([{ id: 'bridge-n1-n2', source: 'n1', target: 'n2', reader: 'n1' }])
  })

  it('without the option the edge carries no reader (bidirectional, unchanged shape)', () => {
    const plan = planBridges('n1', ['n2'], lookup, [])
    expect(plan.edges).toEqual([{ id: 'bridge-n1-n2', source: 'n1', target: 'n2' }])
  })

  it('note links are one-way by nature and never carry a reader', () => {
    const plan = planBridges('n1', ['s1'], lookup, [], { oneWay: true })
    expect(plan.edges).toEqual([{ id: 'bridge-s1-n1', source: 's1', target: 'n1' }])
  })
})

const agent = (contextCapable = true): LinkEndpoint => ({ kind: 'terminal', contextCapable })
const device: LinkEndpoint = { kind: 'simulator', contextCapable: false }
const note: LinkEndpoint = { kind: 'sticky', contextCapable: false }

describe('classifyLink — Simulator nodes', () => {
  it('a Simulator node + a context-capable agent is a sim link, in either order', () => {
    expect(classifyLink(device, agent())).toBe('sim')
    expect(classifyLink(agent(), device)).toBe('sim')
  })
  it('refuses every other pairing with a device', () => {
    expect(classifyLink(device, agent(false))).toBeNull() // a plain shell has nothing to drive it with
    expect(classifyLink(device, device)).toBeNull()
    expect(classifyLink(device, note)).toBeNull()
    expect(classifyLink(note, device)).toBeNull()
    expect(classifyLink(device, { kind: 'editor', contextCapable: false })).toBeNull()
  })
  it('leaves the existing kinds alone', () => {
    expect(classifyLink(agent(), agent())).toBe('context')
    expect(classifyLink(note, agent(false))).toBe('note')
  })
})

describe('planBridges — Simulator nodes', () => {
  const nodes: Record<string, LinkEndpoint> = { a: agent(), b: agent(), s: device, t: agent(false), n: note }
  const lookup = (id: string) => nodes[id] ?? null

  it('normalizes to device → agent whichever way the caller names them', () => {
    const fromAgent = planBridges('a', ['s'], lookup, [])
    expect(fromAgent.edges).toEqual([{ id: 'bridge-s-a', source: 's', target: 'a' }])
    expect(fromAgent.linked).toEqual(['s'])
    const fromDevice = planBridges('s', ['a'], lookup, [])
    expect(fromDevice.edges).toEqual([{ id: 'bridge-s-a', source: 's', target: 'a' }])
  })
  it('one-way never applies: a device cannot read, so no reader is stamped', () => {
    expect(planBridges('a', ['s'], lookup, [], { oneWay: true }).edges).toEqual([
      { id: 'bridge-s-a', source: 's', target: 'a' }
    ])
  })
  it('dedupes in either direction, within the batch and against existing edges', () => {
    expect(planBridges('a', ['s'], lookup, [{ source: 'a', target: 's' }]).skipped).toEqual([
      { id: 's', why: 'already linked' }
    ])
    const batch = planBridges('a', ['s', 's'], lookup, [])
    expect(batch.edges).toHaveLength(1)
    expect(batch.skipped).toEqual([{ id: 's', why: 'already linked' }])
  })
  it('keeps the matrix for everything it must still refuse', () => {
    const plan = planBridges('s', ['t', 'n', 's', 'a'], lookup, [])
    expect(plan.linked).toEqual(['a'])
    expect(plan.skipped).toEqual([
      { id: 't', why: LINK_NOT_LINKABLE },
      { id: 'n', why: LINK_NOT_LINKABLE },
      { id: 's', why: 'same node' }
    ])
  })
  it('an agent may have several devices (the verb then asks for --node)', () => {
    const two: Record<string, LinkEndpoint> = { ...nodes, s2: device }
    const plan = planBridges('a', ['s', 's2'], (id) => two[id] ?? null, [])
    expect(plan.edges.map((e) => e.id)).toEqual(['bridge-s-a', 'bridge-s2-a'])
  })
})
