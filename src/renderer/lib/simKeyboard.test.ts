import { describe, expect, it } from 'vitest'
import { HID_USAGE, mapKeyEvent, textFromInput, type KeyEventLike } from './simKeyboard'

const ev = (key: string, over: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...over
})

describe('mapKeyEvent', () => {
  it('types printable characters as text', () => {
    expect(mapKeyEvent(ev('a'))).toEqual({ kind: 'text', text: 'a' })
    expect(mapKeyEvent(ev('A', { shiftKey: true }))).toEqual({ kind: 'text', text: 'A' })
    expect(mapKeyEvent(ev(' '))).toEqual({ kind: 'text', text: ' ' })
    expect(mapKeyEvent(ev('€', { altKey: true }))).toEqual({ kind: 'text', text: '€' })
  })
  it('sends a character outside the BMP as ONE text, not two halves', () => {
    expect(mapKeyEvent(ev('😀'))).toEqual({ kind: 'text', text: '😀' })
  })
  it('maps the named keys to HID usage page 7', () => {
    expect(mapKeyEvent(ev('Enter'))).toEqual({ kind: 'key', usage: 0x28, mods: [] })
    expect(mapKeyEvent(ev('Backspace'))).toEqual({ kind: 'key', usage: 0x2a, mods: [] })
    expect(mapKeyEvent(ev('Tab', { shiftKey: true }))).toEqual({ kind: 'key', usage: 0x2b, mods: ['shift'] })
    expect(mapKeyEvent(ev('ArrowRight'))).toMatchObject({ usage: 79 })
    expect(mapKeyEvent(ev('ArrowLeft'))).toMatchObject({ usage: 80 })
    expect(mapKeyEvent(ev('ArrowDown'))).toMatchObject({ usage: 81 })
    expect(mapKeyEvent(ev('ArrowUp'))).toMatchObject({ usage: 82 })
    expect(mapKeyEvent(ev('ArrowUp', { shiftKey: true, altKey: true }))).toMatchObject({ mods: ['shift', 'alt'] })
  })
  it('every mapped usage is one core accepts (0x04–0xE7)', () => {
    for (const usage of Object.values(HID_USAGE)) {
      expect(usage).toBeGreaterThanOrEqual(0x04)
      expect(usage).toBeLessThanOrEqual(0xe7)
    }
  })
  it('never claims an app chord — ⌘ and Ctrl bubble to the dispatcher', () => {
    for (const k of ['k', 'w', 'm', 'v', 'a', 'Enter', 'ArrowLeft', 'Tab', ',']) {
      expect(mapKeyEvent(ev(k, { metaKey: true }))).toBeNull()
      expect(mapKeyEvent(ev(k, { ctrlKey: true }))).toBeNull()
    }
  })
  it('hands Escape back to the canvas instead of typing it', () => {
    expect(mapKeyEvent(ev('Escape'))).toEqual({ kind: 'release' })
  })
  it('ignores modifier-only, dead, function and IME keys', () => {
    for (const k of ['Shift', 'Alt', 'Meta', 'Control', 'CapsLock', 'F5', 'Dead', 'Process', 'Unidentified']) {
      expect(mapKeyEvent(ev(k)), k).toBeNull()
    }
    expect(mapKeyEvent(ev('a', { isComposing: true }))).toBeNull()
  })
})

describe('textFromInput', () => {
  it('keeps text, newlines and tabs, strips other control characters, caps the length', () => {
    expect(textFromInput('héllo\tworld\nok')).toBe('héllo\tworld\nok')
    expect(textFromInput('a\u0000b\u001bc\u007fd')).toBe('abcd')
    expect(textFromInput('x'.repeat(5000))).toHaveLength(4000)
    expect(textFromInput('漢字かな')).toBe('漢字かな')
  })
})
