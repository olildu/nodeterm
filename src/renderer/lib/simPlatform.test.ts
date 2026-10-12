import { describe, expect, it } from 'vitest'
import { SIM_BUTTONS, type SimDeviceEntry } from '@shared/sim'
import {
  PLATFORM_BUTTONS,
  bootingTitle,
  deviceTerm,
  fallbackDeviceBox,
  nodePlatform,
  pickerRows,
  screenCornerFraction,
  touchEdge
} from './simPlatform'
import { cornerRadiusFraction } from './simPointer'

const IOS = 'AE342EEF-B624-4060-B9E6-AE6E9EAAC24A'
const iphone: SimDeviceEntry = { udid: IOS, name: 'iPhone 15', runtime: 'iOS 26.5', booted: true }
const nexus: SimDeviceEntry = { udid: 'android:Nexus_7', name: 'Nexus 7', runtime: 'Android 11', booted: false, platform: 'android' }
const pixel: SimDeviceEntry = { udid: 'android:Pixel_7', name: 'Pixel 7', runtime: 'Android 14', booted: true }

describe('nodePlatform', () => {
  it('trusts the device report, then the id prefix, then defaults to iOS', () => {
    expect(nodePlatform('android:Nexus_7')).toBe('android')
    expect(nodePlatform(IOS)).toBe('ios')
    expect(nodePlatform(undefined)).toBe('ios')
    expect(nodePlatform(IOS, { platform: 'android' })).toBe('android')
    expect(nodePlatform('android:Nexus_7', {})).toBe('android')
  })
  it('names the device the way its SDK does', () => {
    expect(deviceTerm('ios')).toBe('simulator')
    expect(deviceTerm('android')).toBe('emulator')
    expect(bootingTitle('android')).toBe('Booting emulator…')
  })
})

describe('header buttons', () => {
  it('iOS keeps its set; Android gets back / home / recents and the side buttons', () => {
    expect(PLATFORM_BUTTONS.ios.map((b) => b.name)).toEqual(['home', 'lock', 'voldown', 'volup', 'siri'])
    expect(PLATFORM_BUTTONS.android.map((b) => b.name)).toEqual(['back', 'home', 'recents', 'voldown', 'volup', 'power'])
  })
  it('never offers an iOS-only button on Android or the reverse', () => {
    const android = PLATFORM_BUTTONS.android.map((b) => b.name)
    for (const n of ['lock', 'siri', 'side', 'playpause'] as const) expect(android).not.toContain(n)
    const ios = PLATFORM_BUTTONS.ios.map((b) => b.name)
    for (const n of ['back', 'recents', 'power'] as const) expect(ios).not.toContain(n)
  })
  it('every button is one the shared vocabulary accepts, and has a title', () => {
    for (const list of Object.values(PLATFORM_BUTTONS)) {
      for (const b of list) {
        expect(SIM_BUTTONS).toContain(b.name)
        expect(b.title.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('frame shape', () => {
  it('falls back to a phone OF THAT PLATFORM until the device reports', () => {
    expect(fallbackDeviceBox('ios')).toEqual({ width: 393, height: 852 })
    expect(fallbackDeviceBox('android')).toEqual({ width: 411, height: 914 })
  })
  it('iOS corners are unchanged', () => {
    for (const box of [{ width: 393, height: 852 }, { width: 820, height: 1180 }]) {
      expect(screenCornerFraction('ios', box)).toBe(cornerRadiusFraction(box))
    }
  })
  it('a Nexus 7 tablet (600x960 points) is nearly square-cornered, a tall Pixel rounded', () => {
    const nexus7 = screenCornerFraction('android', { width: 600, height: 960 })
    const pixel7 = screenCornerFraction('android', { width: 411, height: 914 })
    expect(nexus7).toBeLessThan(0.02)
    expect(pixel7).toBeGreaterThan(nexus7)
    // never the iPhone amount: that would clip a tablet's status bar
    expect(nexus7).toBeLessThan(cornerRadiusFraction({ width: 393, height: 852 }))
    // landscape is the same device
    expect(screenCornerFraction('android', { width: 960, height: 600 })).toBe(nexus7)
  })
})

describe('touchEdge', () => {
  it('sends the iOS home-indicator edge flag, and nothing on Android', () => {
    const box = { width: 393, height: 852 }
    const bottom = { x: 196, y: 845 }
    expect(touchEdge('ios', bottom, box)).toBe('bottom')
    expect(touchEdge('android', bottom, box)).toBeUndefined()
    expect(touchEdge('android', { x: 2, y: 400 }, box)).toBeUndefined()
  })
})

describe('pickerRows', () => {
  it('keeps the flat iOS list when there are no emulators', () => {
    const rows = pickerRows({ devices: [iphone], current: IOS, availability: { ok: true } })
    expect(rows).toEqual([{ kind: 'device', device: iphone, current: true, label: '✓ iPhone 15 · iOS 26.5 · running' }])
  })
  it('sections iOS then Android once an emulator is listed, whatever order they came in', () => {
    const rows = pickerRows({ devices: [nexus, iphone, pixel], current: 'android:Nexus_7', availability: { ok: true } })
    expect(rows.map((r) => r.label)).toEqual([
      'iOS simulators',
      'iPhone 15 · iOS 26.5 · running',
      'Android emulators',
      '✓ Nexus 7 · Android 11',
      'Pixel 7 · Android 14 · running'
    ])
  })
  it('an Android-only host shows only the Android section', () => {
    const rows = pickerRows({ devices: [nexus], current: undefined, availability: { ok: true, platforms: { ios: false, android: true } } })
    expect(rows.map((r) => r.kind)).toEqual(['label', 'device'])
  })
  it('the empty row names what this host can show, or the error', () => {
    const empty = (availability: Parameters<typeof pickerRows>[0]['availability'], error?: string) =>
      pickerRows({ devices: [], current: undefined, availability, error })[0]
    expect(empty({ ok: true })).toEqual({ kind: 'empty', label: 'No iOS simulators found' })
    expect(empty({ ok: true, platforms: { ios: true, android: true } })).toMatchObject({ label: 'No iOS simulators or Android emulators found' })
    expect(empty({ ok: true, platforms: { ios: false, android: true } })).toMatchObject({ label: 'No Android emulators found' })
    expect(empty({ ok: true }, 'simctl failed')).toMatchObject({ label: 'simctl failed' })
  })
})
