import { describe, it, expect, afterEach } from 'vitest'
import { setLiveCanvasNodesSource, terminalNodeSize, type CanvasNode } from './workspace'
import { useSettings } from './settings'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

const node = (
  type: string,
  width: number,
  height: number,
  data: Partial<CanvasNode['data']> = {}
): CanvasNode =>
  ({
    id: `${type}-${width}x${height}`,
    type,
    position: { x: 0, y: 0 },
    width,
    height,
    data: { title: '', color: '', group: null, tags: [], ...data }
  }) as CanvasNode

const withSettings = (patch: Partial<Settings>): void => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, ...patch } })
}

afterEach(() => {
  setLiveCanvasNodesSource(null)
  useSettings.setState({ settings: DEFAULT_SETTINGS })
})

describe('terminalNodeSize with newNodeSize', () => {
  const canvas = [node('terminal', 640, 440), node('terminal', 1000, 700), node('browser', 2000, 1400)]

  it('default mode ignores the canvas', () => {
    withSettings({ newNodeSize: 'default' })
    setLiveCanvasNodesSource(() => canvas)
    expect(terminalNodeSize()).toEqual({ width: 640, height: 440 })
  })

  it('matchLargest takes the largest terminal on the canvas', () => {
    withSettings({ newNodeSize: 'matchLargest' })
    setLiveCanvasNodesSource(() => canvas)
    expect(terminalNodeSize()).toEqual({ width: 1000, height: 700 })
  })

  it('falls back to the default size with no terminal, or no canvas', () => {
    withSettings({ newNodeSize: 'matchLargest', defaultNodeWidth: 700, defaultNodeHeight: 500 })
    expect(terminalNodeSize()).toEqual({ width: 700, height: 500 })
    setLiveCanvasNodesSource(() => [node('browser', 2000, 1400)])
    expect(terminalNodeSize()).toEqual({ width: 700, height: 500 })
  })

  it('a maximized node counts at its normal size, a collapsed one at its expanded height', () => {
    withSettings({ newNodeSize: 'matchLargest' })
    setLiveCanvasNodesSource(() => [
      node('terminal', 3000, 1800, { premaxRect: { x: 0, y: 0, width: 800, height: 500 } }),
      node('terminal', 900, 36, { collapsed: true, expandedHeight: 600 })
    ])
    expect(terminalNodeSize()).toEqual({ width: 900, height: 600 })
  })

  it('clamps to the same bounds as the default size', () => {
    withSettings({ newNodeSize: 'matchLargest' })
    setLiveCanvasNodesSource(() => [node('terminal', 5000, 3000)])
    expect(terminalNodeSize()).toEqual({ width: 2400, height: 1600 })
  })
})
