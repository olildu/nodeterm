/**
 * Keyboard → simulator input, for the simulator node's hidden capture field.
 *
 * Two routes to the device, both through core's validated commands:
 *  - a HID `key` (usage page 7) for keys that are not text: Enter, Backspace, Tab, arrows…
 *  - `text` for anything that types a character. The helper types pure ASCII as keystrokes and
 *    pastes everything else (overwriting the device pasteboard), so one route covers a Latin
 *    keyboard, Option-composed characters, and — through `compositionend` — an IME.
 *
 * **App chords are not ours.** A ⌘ or Ctrl chord (⌘K, ⌘W, ⌘M, Ctrl+Tab…) returns null so it keeps
 * bubbling to the keybinding dispatcher; only plain typing (and Shift/Option, which produce
 * characters) is claimed. ⌘V is the one deliberate exception, handled by the field's `paste`
 * event rather than here (the platform fires it, and it carries the clipboard text).
 */

export type SimKeyAction =
  | { kind: 'key'; usage: number; mods: Array<'shift' | 'alt'> }
  | { kind: 'text'; text: string }
  /** Escape: hand the keyboard back to the canvas instead of typing into the device. */
  | { kind: 'release' }

export interface KeyEventLike {
  key: string
  code?: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  isComposing?: boolean
  repeat?: boolean
}

/** HID usage page 7 for the non-text keys. */
export const HID_USAGE: Record<string, number> = {
  Enter: 0x28,
  Backspace: 0x2a,
  Tab: 0x2b,
  PageUp: 0x4b,
  PageDown: 0x4e,
  Home: 0x4a,
  End: 0x4d,
  Delete: 0x4c,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52
}

export function mapKeyEvent(e: KeyEventLike): SimKeyAction | null {
  // IME in progress: the composition's own events deliver the text (key is 'Process' / 229 here).
  if (e.isComposing || e.key === 'Process' || e.key === 'Dead') return null
  // App chords bubble to the dispatcher.
  if (e.metaKey || e.ctrlKey) return null
  if (e.key === 'Escape') return { kind: 'release' }
  const usage = HID_USAGE[e.key]
  if (usage !== undefined) {
    const mods: Array<'shift' | 'alt'> = []
    if (e.shiftKey) mods.push('shift')
    if (e.altKey) mods.push('alt')
    return { kind: 'key', usage, mods }
  }
  // One code point (a surrogate pair is two UTF-16 units); named keys like 'Shift' are longer.
  if ([...e.key].length === 1) return { kind: 'text', text: e.key }
  return null
}

/** Text from a finished IME composition or a paste: control characters stripped, capped. */
export function textFromInput(raw: string, max = 4000): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max)
}
