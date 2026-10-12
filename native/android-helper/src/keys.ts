/**
 * The iOS helper's keyboard vocabulary (HID usage page 7 + modifier names, PROTOCOL.md `key`) and
 * hardware buttons, mapped onto what the emulator's gRPC `sendKey` takes: a W3C
 * `KeyboardEvent.key` value. The emulator translates those to Android keycodes itself; MEASURED on
 * emulator 36.6: `GoHome` presses Home.
 */

/** HID usage → W3C key, for the keys that are not plain characters. */
const NAMED: Record<number, string> = {
  0x28: 'Enter',
  0x29: 'Escape',
  0x2a: 'Backspace',
  0x2b: 'Tab',
  0x2c: ' ',
  0x39: 'CapsLock',
  0x49: 'Insert',
  0x4a: 'Home',
  0x4b: 'PageUp',
  0x4c: 'Delete',
  0x4d: 'End',
  0x4e: 'PageDown',
  0x4f: 'ArrowRight',
  0x50: 'ArrowLeft',
  0x51: 'ArrowDown',
  0x52: 'ArrowUp',
  0xe0: 'Control',
  0xe1: 'Shift',
  0xe2: 'Alt',
  0xe3: 'Meta',
  0xe4: 'Control',
  0xe5: 'Shift',
  0xe6: 'Alt',
  0xe7: 'Meta'
}

/** HID usage 0x2d–0x38 (US layout), unshifted. */
const PUNCT = '-=[]\\#;\'`,./'

export function hidToKey(usage: number, shift = false): string | null {
  if (NAMED[usage]) return NAMED[usage]
  if (usage >= 0x04 && usage <= 0x1d) {
    const c = String.fromCharCode(97 + usage - 0x04)
    return shift ? c.toUpperCase() : c
  }
  if (usage >= 0x1e && usage <= 0x27) {
    const digits = '1234567890'
    const shifted = '!@#$%^&*()'
    const i = usage - 0x1e
    return shift ? shifted[i] : digits[i]
  }
  if (usage >= 0x2d && usage <= 0x38) {
    const shifted = '_+{}|~:"~<>?'
    const i = usage - 0x2d
    return shift ? shifted[i] : PUNCT[i]
  }
  if (usage >= 0x3a && usage <= 0x45) return `F${usage - 0x3a + 1}`
  return null
}

export const MODIFIER_KEYS: Record<string, string> = { shift: 'Shift', ctrl: 'Control', alt: 'Alt', cmd: 'Meta' }

/**
 * Hardware buttons. The iOS names that have an Android meaning map onto it (`home`, `lock`/`side` →
 * power, volume); `back` and `recents` exist only here. `siri` and `playpause` have no counterpart
 * worth faking and are refused.
 */
export const BUTTON_KEYS: Record<string, string> = {
  home: 'GoHome',
  back: 'GoBack',
  recents: 'AppSwitch',
  power: 'Power',
  lock: 'Power',
  side: 'Power',
  volup: 'AudioVolumeUp',
  voldown: 'AudioVolumeDown'
}

/** Text the emulator can type key by key (printable ASCII + newline); anything else is pasted. */
export function isTypable(text: string): boolean {
  return /^[\x20-\x7e\n]*$/.test(text)
}

// ─── adb `input` fallback (an emulator without a hardware keyboard) ─────────────────────────

/** Android KEYCODE_* for characters `input keyevent` can type without a modifier. */
const CHAR_KEYCODES: Record<string, number> = {
  ' ': 62, '\n': 66, '\t': 61, ',': 55, '.': 56, '`': 68, '-': 69, '=': 70, '[': 71, ']': 72, '\\': 73,
  ';': 74, "'": 75, '/': 76, '@': 77
}
for (let i = 0; i < 26; i++) CHAR_KEYCODES[String.fromCharCode(97 + i)] = 29 + i
for (let i = 0; i < 10; i++) CHAR_KEYCODES[String(i)] = 7 + i

/** HID usage → Android KEYCODE for the named keys (letters/digits/punctuation go through their char). */
const HID_KEYCODES: Record<number, number> = {
  0x28: 66, 0x29: 111, 0x2a: 67, 0x2b: 61, 0x2c: 62, 0x49: 124, 0x4a: 122, 0x4b: 92, 0x4c: 112, 0x4d: 123,
  0x4e: 93, 0x4f: 22, 0x50: 21, 0x51: 20, 0x52: 19
}

export const BUTTON_KEYCODES: Record<string, number> = {
  home: 3, back: 4, recents: 187, power: 26, lock: 26, side: 26, volup: 24, voldown: 25
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * One device-side shell line that types `text` with `input`: runs of characters that have a plain
 * keycode go as ONE `input keyevent a b c` (MEASURED: `input text` drops characters into a Flutter
 * field, a keyevent batch does not), anything else (uppercase, shifted punctuation) as `input text`
 * one character at a time. Every argument is single-quoted for the device's sh; only printable ASCII
 * reaches here (`isTypable`).
 */
export function inputTextScript(text: string): string {
  const parts: string[] = []
  let codes: number[] = []
  const flush = (): void => {
    if (codes.length) parts.push(`input keyevent ${codes.join(' ')}`)
    codes = []
  }
  for (const ch of text) {
    const code = CHAR_KEYCODES[ch]
    if (code !== undefined) codes.push(code)
    else {
      flush()
      parts.push(`input text ${shQuote(ch === '%' ? '\\%' : ch)}`)
    }
  }
  flush()
  return parts.join('; ')
}

/** `input` line for one HID key (+shift): a named key's KEYCODE, else its character. Null = no equivalent. */
export function inputKeyScript(usage: number, shift: boolean): string | null {
  const named = HID_KEYCODES[usage]
  if (named !== undefined) return `input keyevent ${named}`
  const ch = hidToKey(usage, shift)
  return ch && ch.length === 1 ? inputTextScript(ch) : null
}
