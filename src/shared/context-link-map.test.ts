// Issue #852: the link map is the read AUTHORIZATION (main serves a node only the entries of its
// own document). A one-way link must therefore put an entry on the reading side only.
import { describe, it, expect } from 'vitest'
import { buildBackgroundLinkMaps, buildLinkMap, type LinkNodeInfo } from './context-link-map'
import type { CanvasNodeState } from './types'

const info = (id: string): LinkNodeInfo => ({ id, title: id.toUpperCase(), cwd: `/w/${id}`, sticky: id.startsWith('s') })

describe('buildLinkMap direction', () => {
  it('a link without a reader maps both directions (backward compatible)', () => {
    const map = buildLinkMap([{ source: 'a', target: 'b' }], info)
    expect(Object.keys(map).sort()).toEqual(['a', 'b'])
    expect(map.a!.map((e) => e.id)).toEqual(['b'])
    expect(map.b!.map((e) => e.id)).toEqual(['a'])
  })

  it('reader = source: only the source gets an entry', () => {
    const map = buildLinkMap([{ source: 'a', target: 'b', reader: 'a' }], info)
    expect(map).toEqual({ a: [{ id: 'b', title: 'B', cwd: '/w/b' }] })
  })

  it('reader = target: only the target gets an entry', () => {
    const map = buildLinkMap([{ source: 'a', target: 'b', reader: 'b' }], info)
    expect(map).toEqual({ b: [{ id: 'a', title: 'A', cwd: '/w/a' }] })
  })

  it('a reader naming neither endpoint authorizes nobody', () => {
    expect(buildLinkMap([{ source: 'a', target: 'b', reader: 'x' }], info)).toEqual({})
  })

  it('a malformed (non-string) persisted reader authorizes nobody', () => {
    expect(buildLinkMap([{ source: 'a', target: 'b', reader: null as never }], info)).toEqual({})
    expect(buildLinkMap([{ source: 'a', target: 'b', reader: 42 as never }], info)).toEqual({})
  })

  it('note links keep their fixed direction (terminal reads the sticky)', () => {
    const map = buildLinkMap([{ source: 's1', target: 'a' }], info)
    expect(Object.keys(map)).toEqual(['a'])
  })
})

describe('buildBackgroundLinkMaps direction', () => {
  const node = (id: string): CanvasNodeState => ({
    id, kind: 'terminal', agentId: 'claude', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
    title: id, color: '#fff', group: null, cwd: `/w/${id}`
  })

  it('honours a persisted reader and still reads old, reader-less bridges as bidirectional', () => {
    const map = buildBackgroundLinkMaps(
      [
        { id: 'p1', nodes: [node('a'), node('b')], bridges: [{ id: 'l1', source: 'a', target: 'b', reader: 'a' }] },
        { id: 'p2', nodes: [node('c'), node('d')], bridges: [{ id: 'l2', source: 'c', target: 'd' }] }
      ],
      null,
      () => undefined
    )
    expect(Object.keys(map).sort()).toEqual(['a', 'c', 'd'])
  })
})

describe('a Simulator node in the link map', () => {
  const sim = { udid: 'AE342EEF-B624-4060-B9E6-AE6E9EAAC24A', name: 'iPhone 15' }
  const infoWithSim = (id: string): LinkNodeInfo =>
    id === 'dev' ? { id, title: 'Phone', sticky: false, simulator: sim } : { id, title: id.toUpperCase(), cwd: `/w/${id}`, sticky: false, agentId: 'claude' }

  it('the AGENT gets a simulator entry (no transcript fields); the device gets nothing — it cannot read', () => {
    const map = buildLinkMap([{ source: 'dev', target: 'a' }], infoWithSim)
    expect(map).toEqual({ a: [{ id: 'dev', title: 'Phone', simulator: sim }] })
    expect(map.dev).toBeUndefined()
  })
  it('still maps the entry when the stored direction is agent → device', () => {
    expect(buildLinkMap([{ source: 'a', target: 'dev' }], infoWithSim)).toEqual({
      a: [{ id: 'dev', title: 'Phone', simulator: sim }]
    })
  })
  it('two passive nodes (a device and a note) never link', () => {
    const map = buildLinkMap([{ source: 'dev', target: 'sn' }], (id) =>
      id === 'dev' ? infoWithSim('dev') : { id, title: 'N', sticky: true, note: 'x' }
    )
    expect(map).toEqual({})
  })
  it('a device link beside a context link does not disturb it', () => {
    const map = buildLinkMap(
      [
        { source: 'dev', target: 'a' },
        { source: 'a', target: 'b' }
      ],
      infoWithSim
    )
    expect(map.a?.map((e) => e.id)).toEqual(['dev', 'b'])
    expect(map.b?.map((e) => e.id)).toEqual(['a'])
  })
  it('background projects build it from the serialized node (udid + name, no agent, no account)', () => {
    const nodes = [
      { id: 'dev', kind: 'simulator', title: 'Phone', simUdid: sim.udid, simName: sim.name, accountId: 'x' },
      { id: 'a', kind: 'terminal', title: 'A', agentId: 'claude' }
    ] as unknown as CanvasNodeState[]
    const map = buildBackgroundLinkMaps(
      [{ id: 'p', nodes, bridges: [{ id: 'b1', source: 'dev', target: 'a' }] }],
      null,
      () => 's1'
    )
    expect(map.a).toEqual([{ id: 'dev', title: 'Phone', simulator: sim }])
  })
})
