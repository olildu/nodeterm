import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type CanvasNodeState } from '@shared/types'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import { useSettings } from './settings'
import {
  COLLAPSIBLE_KINDS,
  canToggleCollapse,
  createSimulatorNode,
  flowToNodeStates,
  nodeStatesToFlow,
  toggleCollapsed,
  type CanvasNode
} from './workspace'

const UDID = 'AE342EEF-B624-4060-B9E6-AE6E9EAAC24A'

afterEach(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS } }))

const state = (over: Record<string, unknown>): CanvasNodeState =>
  ({
    id: 'sim-1',
    kind: 'simulator',
    position: { x: 10, y: 20 },
    size: { width: 320, height: 740 },
    title: 'iPhone 15',
    color: '#6ac4dc',
    group: null,
    ...over
  }) as unknown as CanvasNodeState

describe('createSimulatorNode', () => {
  it('is phone-shaped, teal (a palette colour), and empty until a device is picked', () => {
    const n = createSimulatorNode(0)
    expect(n.type).toBe('simulator')
    expect(n.id).toMatch(/^sim-/)
    expect(n.height as number).toBeGreaterThan(n.width as number)
    expect(n.data).toMatchObject({ title: 'Simulator', titleAuto: true, color: '#6ac4dc', group: null })
    expect(n.data.simUdid).toBeUndefined()
  })
  it('carries a valid device and takes its name for the title', () => {
    const n = createSimulatorNode(0, undefined, { udid: UDID.toLowerCase(), name: 'iPhone 15' })
    expect(n.data).toMatchObject({ simUdid: UDID, simName: 'iPhone 15', title: 'iPhone 15' })
  })
  it('drops a device id that is not a UUID instead of storing it', () => {
    const n = createSimulatorNode(0, undefined, { udid: '$(rm -rf ~)', name: 'x' })
    expect(n.data.simUdid).toBeUndefined()
    expect(n.data.simName).toBeUndefined()
  })
  it('places on the grid like every other kind when snapping is on', () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, snapToGrid: true, gridSize: 20 } })
    const n = createSimulatorNode(0, { x: 517, y: 293 })
    expect([Math.abs(n.position.x % 20), Math.abs(n.position.y % 20)]).toEqual([0, 0])
    expect([(n.width as number) % 20, (n.height as number) % 20]).toEqual([0, 0])
  })
  it('never starts below the minimum its resizer enforces', () => {
    const n = createSimulatorNode(0)
    expect(n.width as number).toBeGreaterThanOrEqual(NODE_MIN_SIZES.simulator.width)
    expect(n.height as number).toBeGreaterThanOrEqual(NODE_MIN_SIZES.simulator.height)
  })
})

describe('simulator serialization validates the device at BOTH seams', () => {
  it('round-trips a valid device', () => {
    const [flow] = nodeStatesToFlow([state({ simUdid: UDID, simName: 'iPhone 15' })])
    expect(flow.type).toBe('simulator')
    expect(flow.data).toMatchObject({ simUdid: UDID, simName: 'iPhone 15' })
    expect(flowToNodeStates([flow])[0]).toMatchObject({ kind: 'simulator', simUdid: UDID, simName: 'iPhone 15' })
  })
  it.each([
    ['not a UUID', 'iPhone 15'],
    ['a shell injection', '$(touch /tmp/x)'],
    ['a path', '../../etc/passwd'],
    ['a number', 5],
    ['an object', { udid: UDID }],
    ['empty', '']
  ])('reading a project file: %s becomes "no device chosen" (the node is kept)', (_label, bad) => {
    const [flow] = nodeStatesToFlow([state({ simUdid: bad, simName: 'Evil' })])
    expect(flow.type).toBe('simulator')
    expect(flow.data.simUdid).toBeUndefined()
    // The name describes a device we no longer have; it must not outlive its id.
    expect(flow.data.simName).toBeUndefined()
  })
  it('writing a project file: a value that reached live node data is re-validated on the way OUT', () => {
    const live = {
      id: 'sim-1',
      type: 'simulator',
      position: { x: 0, y: 0 },
      width: 320,
      height: 740,
      data: { title: 'T', color: '#6ac4dc', group: null, simUdid: 'not-a-udid', simName: 'x' }
    } as unknown as CanvasNode
    const out = flowToNodeStates([live])[0]
    expect(out.simUdid).toBeUndefined()
    expect(out.simName).toBeUndefined()
  })
  it('normalizes case on the way in, so one device is one identity', () => {
    const [flow] = nodeStatesToFlow([state({ simUdid: UDID.toLowerCase() })])
    expect(flow.data.simUdid).toBe(UDID)
  })
  it('strips control and bidi characters from the stored name', () => {
    const [flow] = nodeStatesToFlow([state({ simUdid: UDID, simName: 'iPhone‮ 15\u0000' })])
    expect(flow.data.simName).toBe('iPhone 15')
  })
  it('persists the default size when the node has not been measured', () => {
    const bare = { id: 's', type: 'simulator', position: { x: 0, y: 0 }, data: { title: 'T', color: '#6ac4dc', group: null } } as unknown as CanvasNode
    const size = flowToNodeStates([bare])[0].size
    expect(size.height).toBeGreaterThan(size.width)
  })
})

describe('simulator collapse', () => {
  it('is a collapsible kind (header-only), and remembers the expanded height', () => {
    expect(COLLAPSIBLE_KINDS.has('simulator')).toBe(true)
    const n = createSimulatorNode(0)
    expect(canToggleCollapse(n)).toBe(true)
    const [collapsed] = toggleCollapsed([n], [n.id])
    expect(collapsed.data.collapsed).toBe(true)
    expect(collapsed.data.expandedHeight).toBe(n.height)
  })
})
