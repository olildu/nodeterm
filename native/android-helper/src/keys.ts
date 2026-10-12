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
