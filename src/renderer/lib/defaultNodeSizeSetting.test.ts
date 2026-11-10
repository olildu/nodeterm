import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { SIZABLE_NODE_KINDS } from '@shared/default-node-size'
import { useSettings } from '../state/settings'
import {
  NODE_SIZE_CHOICES,
  NODE_SIZE_CHOICE_LABELS,
  nodeSizeField,
  nodeSizePatch,
  nodeSizeResetPatch
} from './defaultNodeSizeSetting'

function settings(over: Partial<Settings> = {}): Settings {
  const s = { ...DEFAULT_SETTINGS, ...over }
  useSettings.setState({ settings: s })
  return s
}

afterEach(() => settings())

describe('Default node size setting model', () => {
  it('offers terminal first, then every sizable kind, each with a label', () => {
    expect(NODE_SIZE_CHOICES).toEqual(['terminal', ...SIZABLE_NODE_KINDS])
    for (const c of NODE_SIZE_CHOICES) expect(NODE_SIZE_CHOICE_LABELS[c]).toBeTruthy()
  })

  it('keeps terminal on the existing width/height pair', () => {
    const s = settings({ defaultNodeWidth: 700, defaultNodeHeight: 480 })
    expect(nodeSizeField(s, 'terminal')).toMatchObject({ size: { width: 700, height: 480 }, isCustom: true })
    expect(nodeSizeField(settings(), 'terminal').isCustom).toBe(false)
    expect(nodeSizePatch(s, 'terminal', { width: 720, height: 500 })).toEqual({
      defaultNodeWidth: 720,
      defaultNodeHeight: 500
    })
  })

  it('shows the built-in size for a kind the user never set, marked not isCustom', () => {
    const s = settings()
    expect(nodeSizeField(s, 'sticky')).toMatchObject({ size: { width: 240, height: 200 }, isCustom: false })
  })

  it('writes one kind without disturbing the others', () => {
    const s = settings({ defaultNodeSizes: { files: { width: 400, height: 600 } } })
    expect(nodeSizePatch(s, 'sticky', { width: 300, height: 260 })).toEqual({
      defaultNodeSizes: { files: { width: 400, height: 600 }, sticky: { width: 300, height: 260 } }
    })
  })

  it('resets one kind back to built-in by removing only its entry', () => {
    const s = settings({
      defaultNodeSizes: { files: { width: 400, height: 600 }, sticky: { width: 300, height: 260 } }
    })
    expect(nodeSizeResetPatch(s, 'sticky')).toEqual({ defaultNodeSizes: { files: { width: 400, height: 600 } } })
    expect(s.defaultNodeSizes.sticky).toEqual({ width: 300, height: 260 }) // input not mutated
  })

  it('resets terminal to the shipped default pair', () => {
    const s = settings({ defaultNodeWidth: 900, defaultNodeHeight: 700 })
    expect(nodeSizeResetPatch(s, 'terminal')).toEqual({
      defaultNodeWidth: DEFAULT_SETTINGS.defaultNodeWidth,
      defaultNodeHeight: DEFAULT_SETTINGS.defaultNodeHeight
    })
  })

  it('shows the stored numbers unclamped, so typing 300 digit by digit is not snapped to the minimum', () => {
    const s = settings({ defaultNodeSizes: { sticky: { width: 3, height: 200 } } })
    expect(nodeSizeField(s, 'sticky').size).toEqual({ width: 3, height: 200 })
    const t = settings({ defaultNodeWidth: 3 })
    expect(nodeSizeField(t, 'terminal').size.width).toBe(3)
  })

  it('never spreads a hand-edited non-object defaultNodeSizes into index keys', () => {
    for (const junk of ['abc', ['x'], 7, null]) {
      const s = settings({ defaultNodeSizes: junk as unknown as Settings['defaultNodeSizes'] })
      expect(nodeSizePatch(s, 'sticky', { width: 300, height: 260 })).toEqual({
        defaultNodeSizes: { sticky: { width: 300, height: 260 } }
      })
      expect(nodeSizeResetPatch(s, 'sticky')).toEqual({ defaultNodeSizes: {} })
      expect(nodeSizeField(s, 'sticky').size).toEqual({ width: 240, height: 200 })
    }
  })
})
