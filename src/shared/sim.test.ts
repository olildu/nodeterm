import { describe, expect, it } from 'vitest'
import {
  SIM_FPS,
  SIM_FRAME_HEADER_BYTES,
  combineSimViews,
  isQuietEligible,
  normalizeSimName,
  normalizeSimUdid,
  normalizeSimViewOptions,
  parseSimFrame,
  sanitizeSimCommand
} from './sim'

const UDID = 'AE342EEF-B624-4060-B9E6-AE6E9EAAC24A'

describe('normalizeSimUdid', () => {
  it('accepts a UUID in either case and returns it upper-cased', () => {
    expect(normalizeSimUdid(UDID)).toBe(UDID)
    expect(normalizeSimUdid(UDID.toLowerCase())).toBe(UDID)
  })
  it.each([undefined, null, 5, '', 'iPhone 15', `${UDID}x`, ` ${UDID}`, `${UDID}\n`, '../../etc/passwd', {}])(
    'refuses %j',
    (v) => expect(normalizeSimUdid(v)).toBeUndefined()
  )
})

describe('normalizeSimName', () => {
  it('keeps display text, strips control and bidi characters, caps the length', () => {
    expect(normalizeSimName('  iPhone 15 ‮')).toBe('iPhone 15')
    expect(normalizeSimName('a\u0000b')).toBe('ab')
    expect(normalizeSimName('x'.repeat(200))).toHaveLength(80)
  })
  it('is undefined for anything that is not a non-empty string', () => {
    expect(normalizeSimName(3)).toBeUndefined()
    expect(normalizeSimName('   ')).toBeUndefined()
  })
})

describe('sanitizeSimCommand', () => {
  const ok = (raw: unknown) => {
    const r = sanitizeSimCommand(raw)
    if (!r.ok) throw new Error(`expected ok, got ${r.error}`)
    return r.cmd
  }
  const refused = (raw: unknown) => {
    const r = sanitizeSimCommand(raw)
    expect(r.ok).toBe(false)
    return r.ok ? '' : r.error
  }

  it('passes a touch through with only the fields this build knows', () => {
    const cmd = ok({ cmd: 'touch', phase: 'down', x: 10, y: 20, edge: 'left', quiet: false, id: 99, evil: '$(rm -rf /)' })
    expect(cmd).toEqual({ cmd: 'touch', phase: 'down', x: 10, y: 20, edge: 'left' })
  })
  it('refuses non-objects, unknown commands and the helper-only `quit`', () => {
    refused(null)
    refused([])
    refused('touch')
    refused({ cmd: 'quit' })
    refused({ cmd: 'stream', on: false })
    refused({})
  })
  it.each([NaN, Infinity, '5', null, 1e9])('refuses a touch coordinate of %j', (bad) => {
    refused({ cmd: 'touch', phase: 'move', x: bad, y: 1 })
    refused({ cmd: 'tap', x: 1, y: bad })
  })
  it('refuses unknown phases, edges and buttons', () => {
    refused({ cmd: 'touch', phase: 'hover', x: 1, y: 1 })
    refused({ cmd: 'touch', phase: 'down', x: 1, y: 1, edge: 'middle' })
    refused({ cmd: 'button', name: 'power' })
    refused({ cmd: 'button', name: 'home; rm -rf' })
  })
  it('accepts every documented button', () => {
    for (const name of ['home', 'lock', 'side', 'siri', 'volup', 'voldown', 'playpause']) {
      expect(ok({ cmd: 'button', name })).toEqual({ cmd: 'button', name })
    }
  })
  it('bounds a HID key to usage page 7 and a closed modifier list', () => {
    expect(ok({ cmd: 'key', usage: 0x28, mods: ['shift', 'shift', 'cmd'] })).toEqual({ cmd: 'key', usage: 0x28, mods: ['shift', 'cmd'] })
    refused({ cmd: 'key', usage: 0x03 })
    refused({ cmd: 'key', usage: 0xe8 })
    refused({ cmd: 'key', usage: 4.5 })
    refused({ cmd: 'key', usage: 5, mods: ['super'] })
    refused({ cmd: 'key', usage: 5, down: 'yes' })
  })
  it('caps text and refuses empty text', () => {
    expect(ok({ cmd: 'text', text: 'héllo', paste: true })).toEqual({ cmd: 'text', text: 'héllo', paste: true })
    refused({ cmd: 'text', text: '' })
    refused({ cmd: 'text', text: 'a'.repeat(4001) })
    refused({ cmd: 'text', text: 7 })
  })
  it('validates gestures', () => {
    expect(ok({ cmd: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4, ms: 140, steps: 8.4 })).toEqual({
      cmd: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4, ms: 140, steps: 8
    })
    refused({ cmd: 'swipe', x1: 1, y1: 2, x2: 3 })
    refused({ cmd: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4, ms: 0 })
    refused({ cmd: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4, steps: 5000 })
    expect(ok({ cmd: 'pinch', cx: 1, cy: 2, r1: 30, r2: 80, ms: 350 })).toMatchObject({ cmd: 'pinch', r2: 80 })
    refused({ cmd: 'pinch', cx: 1, cy: 2, r1: -1, r2: 4 })
  })
  it('validates read-only commands', () => {
    expect(ok({ cmd: 'describe', flat: false })).toEqual({ cmd: 'describe', flat: false })
    refused({ cmd: 'describe', flat: 'no' })
    expect(ok({ cmd: 'describe-point', x: 1, y: 2 })).toEqual({ cmd: 'describe-point', x: 1, y: 2 })
    expect(ok({ cmd: 'info' })).toEqual({ cmd: 'info' })
    expect(ok({ cmd: 'screenshot', format: 'jpeg', scale: 0.5 })).toEqual({ cmd: 'screenshot', format: 'jpeg', scale: 0.5 })
    refused({ cmd: 'screenshot', format: 'gif' })
    refused({ cmd: 'screenshot', scale: 0 })
  })
  it('lets only input commands ride the fire-and-forget channel', () => {
    for (const c of ['touch', 'tap', 'swipe', 'pinch', 'button', 'key', 'text']) expect(isQuietEligible(c)).toBe(true)
    for (const c of ['describe', 'screenshot', 'info', 'stream', 'quit']) expect(isQuietEligible(c)).toBe(false)
  })
})

describe('stream policy', () => {
  it('reads a view option as off unless it names a level', () => {
    expect(normalizeSimViewOptions(undefined)).toEqual({ level: 'off' })
    expect(normalizeSimViewOptions({ level: 'ludicrous' })).toEqual({ level: 'off' })
    expect(normalizeSimViewOptions({ level: 'active', scale: 9 })).toEqual({ level: 'active', scale: 1 })
    expect(normalizeSimViewOptions({ level: 'background', scale: 0.01 })).toEqual({ level: 'background', scale: 0.2 })
  })
  it('lets the busiest viewer decide, and idles when nobody is watching', () => {
    expect(combineSimViews([])).toEqual({ maxFps: 0, scale: 0.5 })
    expect(combineSimViews([{ level: 'off' }, { level: 'off', scale: 1 }])).toEqual({ maxFps: 0, scale: 0.5 })
    expect(combineSimViews([{ level: 'background', scale: 0.4 }, { level: 'active', scale: 0.3 }])).toEqual({
      maxFps: SIM_FPS.active,
      scale: 0.4
    })
    // An `off` viewer's scale never raises the stream.
    expect(combineSimViews([{ level: 'active', scale: 0.3 }, { level: 'off', scale: 1 }]).scale).toBe(0.3)
  })
})

describe('parseSimFrame', () => {
  const frame = (w: number, h: number, jpeg: number[]): Uint8Array => {
    const b = new Uint8Array(SIM_FRAME_HEADER_BYTES + jpeg.length)
    const v = new DataView(b.buffer)
    v.setUint32(0, 1)
    v.setUint32(4, 2)
    v.setUint16(8, w)
    v.setUint16(10, h)
    b.set(jpeg, SIM_FRAME_HEADER_BYTES)
    return b
  }
  it('reads the header and views the JPEG without copying it', () => {
    const f = parseSimFrame(frame(590, 1278, [0xff, 0xd8, 0xff]))
    expect(f).toMatchObject({ width: 590, height: 1278, captureMicros: 0x1_0000_0002 })
    expect([...f!.jpeg]).toEqual([0xff, 0xd8, 0xff])
  })
  it('honours the byteOffset of a subarray', () => {
    const inner = frame(10, 20, [1, 2, 3])
    const padded = new Uint8Array(inner.length + 5)
    padded.set(inner, 5)
    expect(parseSimFrame(padded.subarray(5))).toMatchObject({ width: 10, height: 20 })
  })
  it('refuses a short frame and a zero-sized one', () => {
    expect(parseSimFrame(new Uint8Array(12))).toBeNull()
    expect(parseSimFrame(frame(0, 20, [1]))).toBeNull()
  })
})
