import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from './settings'
import {
  createBrowserNode,
  createFilesNode,
  createStickyNode,
  createTerminalNode,
  createTriggerNode,
  createWhiteboardNode,
  defaultNodeSize
} from './workspace'

function settings(over: Partial<typeof DEFAULT_SETTINGS>): void {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, ...over } })
}

afterEach(() => settings({}))

const size = (n: { width?: number; height?: number }): [number | undefined, number | undefined] => [
  n.width,
  n.height
]

describe('per-kind default node sizes (Settings → Behavior → Default node size)', () => {
  it('leaves every kind at its built-in size when nothing is set', () => {
    expect(size(createStickyNode(0))).toEqual([240, 200])
    expect(size(createFilesNode(0, '/tmp'))).toEqual([340, 460])
  })

  it('opens a new node at the size the user set for its kind', () => {
    settings({ defaultNodeSizes: { sticky: { width: 400, height: 320 } } })
    expect(size(createStickyNode(0))).toEqual([400, 320])
  })

  it('only changes the kind that was set', () => {
    settings({ defaultNodeSizes: { sticky: { width: 400, height: 320 } } })
    expect(size(createFilesNode(0, '/tmp'))).toEqual([340, 460])
    expect(size(createBrowserNode(0, 'https://example.com'))).toEqual([800, 560])
  })

  it('covers the trigger node, which places itself without placeNode', () => {
    settings({ defaultNodeSizes: { trigger: { width: 360, height: 220 } } })
    const t = createTriggerNode(0)
    expect(size(t)).toEqual([360, 220])
    expect(t.style).toMatchObject({ width: 360, height: 220 })
  })

  it('opens a whiteboard at 900×600, or at the size the user set for whiteboards', () => {
    expect(size(createWhiteboardNode(0))).toEqual([900, 600])
    settings({ defaultNodeSizes: { whiteboard: { width: 1280, height: 720 } } })
    expect(size(createWhiteboardNode(0))).toEqual([1280, 720])
  })

  it('keeps terminals on their own long-standing setting', () => {
    settings({ defaultNodeWidth: 700, defaultNodeHeight: 500, defaultNodeSizes: {} })
    expect(size(createTerminalNode(0))).toEqual([700, 500])
  })

  it('never opens a node below what its resizer allows, whatever settings.json says', () => {
    settings({ defaultNodeSizes: { sticky: { width: 10, height: 10 } } })
    expect(size(createStickyNode(0))).toEqual([160, 120])
  })

  it('snaps a configured size onto the grid like any other new node', () => {
    settings({ snapToGrid: true, gridSize: 20, defaultNodeSizes: { sticky: { width: 413, height: 307 } } })
    const n = createStickyNode(0, { x: 517, y: 293 })
    expect([(n.width as number) % 20, (n.height as number) % 20]).toEqual([0, 0])
  })

  it('exposes the resolved size for a kind, for surfaces that size before creating', () => {
    settings({ defaultNodeSizes: { files: { width: 420, height: 600 } } })
    expect(defaultNodeSize('files')).toEqual({ width: 420, height: 600 })
    expect(defaultNodeSize('sticky')).toEqual({ width: 240, height: 200 })
  })
})
