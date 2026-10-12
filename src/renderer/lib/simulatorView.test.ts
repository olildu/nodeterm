import { describe, expect, it } from 'vitest'
import type { SimAvailability, SimDeviceInfo, SimStatus } from '@shared/sim'
import { desiredStreamScale, simView, simulatorUnavailableReason, viewLevel } from './simulatorView'

const UDID = 'AE342EEF-B624-4060-B9E6-AE6E9EAAC24A'
const OK: SimAvailability = { ok: true }
const device = (over: Partial<SimDeviceInfo> = {}): SimDeviceInfo => ({
  udid: UDID, name: 'iPhone 15', pixelWidth: 1179, pixelHeight: 2556, pointWidth: 393, pointHeight: 852, scale: 3, ready: true, ...over
})
const NONE = Symbol('no device')
const view = (status: SimStatus | null, udid: string | typeof NONE = UDID, availability: SimAvailability | null = OK) =>
  simView({ availability, udid: udid === NONE ? undefined : udid, status })

describe('simView', () => {
  it('says why the helper is missing, or the platform wrong, before anything else', () => {
    const missing = view(null, UDID, { ok: false, code: 'no-helper', message: 'This build does not include sim-helper.' })
    expect(missing).toMatchObject({ kind: 'unavailable', action: null, detail: 'This build does not include sim-helper.' })
    expect(view(null, NONE, { ok: false, code: 'unsupported', message: 'macOS only' })).toMatchObject({ kind: 'unavailable' })
  })
  it('asks for a device when none is chosen', () => {
    expect(view(null, NONE)).toMatchObject({ kind: 'pick', action: 'pick' })
  })
  it('waits quietly for the first status', () => {
    expect(view(null)).toMatchObject({ kind: 'connecting', action: null })
  })
  it('is live with the device name; a non-fatal error is a notice, not a state', () => {
    expect(view({ phase: 'live', device: device() })).toMatchObject({ kind: 'live', title: 'iPhone 15' })
    expect(view({ phase: 'live', device: device(), error: { code: 'stream-failed', message: 'capture hiccup' } })).toMatchObject({
      kind: 'live',
      notice: 'capture hiccup'
    })
    expect(view({ phase: 'connecting', error: { code: 'setup-failed', message: 'no display yet' } })).toMatchObject({
      kind: 'connecting',
      notice: 'no display yet'
    })
  })
  it('offers Boot for a shut-down device and names it', () => {
    expect(view({ phase: 'shutdown', device: device({ ready: false }) })).toMatchObject({
      kind: 'shutdown',
      title: 'Device shut down',
      action: 'boot',
      detail: expect.stringContaining('iPhone 15')
    })
  })
  it('offers Reconnect after a crash or a refused attach', () => {
    for (const code of ['helper-exited', 'spawn-failed', 'already-attached', 'stream-failed'] as const) {
      expect(view({ phase: 'error', error: { code, message: 'x' } }), code).toMatchObject({ kind: 'error', action: 'reconnect' })
    }
  })
  it('offers NO reconnect where nothing short of an install can help', () => {
    for (const code of ['no-helper', 'no-xcode', 'unsupported'] as const) {
      expect(view({ phase: 'error', error: { code, message: 'x' } }), code).toMatchObject({ kind: 'error', action: null })
    }
  })
  it('sends a vanished device back to the picker', () => {
    expect(view({ phase: 'error', error: { code: 'device-not-found', message: 'gone' } })).toMatchObject({ action: 'pick' })
  })
  it('falls back to the helper-exited copy for an error status with no error', () => {
    expect(view({ phase: 'error' })).toMatchObject({ kind: 'error', title: 'The simulator helper stopped' })
  })
})

describe('viewLevel', () => {
  const base = { onScreen: true, collapsed: false, documentHidden: false, windowFocused: true }
  it('streams at full rate only for a visible node in a focused window', () => {
    expect(viewLevel(base)).toBe('active')
  })
  it('trickles when the window is merely unfocused (a second monitor)', () => {
    expect(viewLevel({ ...base, windowFocused: false })).toBe('background')
  })
  it('stops for an offscreen, collapsed or hidden node', () => {
    expect(viewLevel({ ...base, onScreen: false })).toBe('off')
    expect(viewLevel({ ...base, collapsed: true })).toBe('off')
    expect(viewLevel({ ...base, documentHidden: true, windowFocused: false })).toBe('off')
  })
})

describe('desiredStreamScale', () => {
  it('asks for about one device pixel per screen pixel, quantized and clamped', () => {
    // 390 css px × dpr 2 = 780 device px of a 1179 px wide screen → 0.66 → 0.7
    expect(desiredStreamScale(390, 2, 1179)).toBe(0.7)
    expect(desiredStreamScale(40, 1, 1179)).toBe(0.2)
    expect(desiredStreamScale(4000, 2, 1179)).toBe(1)
  })
  it('does not re-configure the encoder for every pixel of a resize drag', () => {
    expect(desiredStreamScale(300, 2, 1179)).toBe(desiredStreamScale(303, 2, 1179))
  })
  it('falls back when the device size is not known yet', () => {
    expect(desiredStreamScale(300, 2, 0)).toBe(0.5)
    expect(desiredStreamScale(0, 2, 1179)).toBe(0.5)
  })
})

describe('simulatorUnavailableReason', () => {
  it('is undefined only in the desktop app on macOS, in a local tab', () => {
    expect(simulatorUnavailableReason({ browser: false, relay: false, mac: true })).toBeUndefined()
  })
  it('names why for a browser tab, a team tab and a non-Mac desktop — and never says "this Mac"', () => {
    const reasons = [
      simulatorUnavailableReason({ browser: true, relay: false, mac: false }),
      simulatorUnavailableReason({ browser: false, relay: true, mac: true }),
      simulatorUnavailableReason({ browser: false, relay: false, mac: false })
    ]
    for (const r of reasons) {
      expect(r).toBeTruthy()
      expect(r).not.toMatch(/this Mac/i)
    }
    expect(new Set(reasons).size).toBe(3)
  })
})
