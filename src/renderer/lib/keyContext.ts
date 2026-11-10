/**
 * One shared answer to "who owns this keystroke's focus" for the global-keybinding
 * dispatcher. Replaces the three inline `tagName` guards the Canvas keydown effects carried
 * (which disagreed about contentEditable and counted xterm's hidden textarea as typing).
 *
 * **This is not the codebase's only "in terminal" notion, and the difference is the point.**
 * `presenceKeys.ts` (`closest(TYPING_ZONES)`, `.xterm` among them) and the copy gesture
 * (inline `closest('.monaco-editor, .xterm')`) both ask an ANCESTRY question, because they are
 * about a "/" keystroke or a mouse selection landing somewhere inside a terminal REGION, which
 * the `.xterm` wrapper answers and this module's class check would not.
 * DISPATCH asks a different question: who receives this keystroke. Whenever xterm owns the
 * keyboard the focused element IS the helper textarea, so the class check here is exact — and it
 * is what keeps `terminal` and `typing` disjoint (an ancestry check would report BOTH, and
 * `typing` wins, making every terminal-scope command unreachable).
 */
import type { KeyDispatchContext } from '@shared/keybindings'

/** xterm.js takes keyboard input through a hidden <textarea> with this class. Pinned against
 *  the installed dist by keyContext.test.ts — an upgrade that renames it must fail loudly. */
export const XTERM_INPUT_CLASS = 'xterm-helper-textarea'

/** Structural element shape so node-env tests need no DOM. */
export interface ContextElement {
  tagName: string
  isContentEditable?: boolean
  /** The element's attached EditContext (`HTMLElement.editContext`); null/absent when it has none. */
  editContext?: unknown
  classList?: { contains(name: string): boolean }
  /** DOM ancestry, when the element has it (a real Element does); absent = no ancestry answer. */
  closest?(selector: string): unknown
}

/** The ⌘M chat composer's box (nodes/ChatComposer.tsx carries this attribute). Matched
 *  STRUCTURALLY, never by a class: a class-keyed rule once matched the plan "Revise…" textarea and
 *  the question "Other" input (ChatAnswerControls, OUTSIDE the box), and dictation fired there went
 *  to the hidden pane showing that very dialog. */
export const CHAT_COMPOSER_BOX_SELECTOR = '[data-chat-composer-id]'

/** Focus inside the ⌘M composer box: a TYPING target like any other, with one exception the
 *  dispatcher makes — keyed dictation is allowed there, because the composer is the one text
 *  field dictation fills (lib/chatComposerDictation.ts). */
export function isChatComposerTarget(el: ContextElement | null): boolean {
  return !!el?.closest?.(CHAT_COMPOSER_BOX_SELECTOR)
}

/**
 * A surface that takes the WHOLE keyboard while it has focus, though no element in it is a text
 * field: the whiteboard's Excalidraw editor (nodes/WhiteboardNode.tsx), whose focused element is a
 * plain container `<div>`. Without this every canvas command fired over it: Delete/Backspace opened
 * the delete-node confirm, ⌘Z undid the canvas, Space panned it. Matched structurally by ancestry,
 * like the chat composer, so whatever element inside the surface holds focus is covered.
 */
export const KEYBOARD_OWNER_SELECTOR = '[data-nt-keyboard-owner]'

export function isKeyboardOwnerTarget(el: ContextElement | null): boolean {
  return !!el?.closest?.(KEYBOARD_OWNER_SELECTOR)
}

export function isTerminalTarget(el: ContextElement | null): boolean {
  return el?.classList?.contains(XTERM_INPUT_CLASS) === true
}

/**
 * Does this element take text through the EditContext API? Issue #930.
 *
 * The third kind of text surface, next to a field and a contentEditable, and the one every
 * `tagName` check misses: an element with an EditContext attached is a plain `<div>` that the
 * browser feeds text input to directly. Monaco 0.56 switched to it BY DEFAULT wherever the API
 * exists (`editContext: true`, gated on `typeof EditContext === 'function'`, which Electron's
 * Chromium passes), so a focused editor node is no longer Monaco's old hidden `<textarea>` but a
 * `div.native-edit-context` with `isContentEditable === false`. Space-to-pan took every space
 * typed there, and the canvas shortcuts stopped standing down inside the editor.
 *
 * Asked of the web-platform property rather than Monaco's class name on purpose: the property is
 * what makes the element a text surface, so any other EditContext-based input is covered too.
 * `keyContext.test.ts` pins that the installed Monaco still attaches one.
 */
export function hasEditContext(el: ContextElement | null): boolean {
  return el?.editContext != null
}

/** True when the keystroke belongs to text the user is editing. The xterm textarea is
 *  deliberately excluded — a focused terminal is `terminal`, never `typing`, and the two
 *  must stay disjoint (see KeyDispatchContext). */
export function isTypingTarget(el: ContextElement | null): boolean {
  if (!el || isTerminalTarget(el)) return false
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true
  return el.isContentEditable === true || hasEditContext(el) || isKeyboardOwnerTarget(el)
}

/** `terminalFirst` is REQUIRED, not defaulted: it is a user policy, and a default here would let
 *  a call site silently answer "app-first" for a user who chose otherwise. Every caller decides. */
export function keyDispatchContextFor(
  el: ContextElement | null,
  kanbanOpen: boolean,
  terminalFirst: boolean
): KeyDispatchContext {
  return { typing: isTypingTarget(el), terminal: isTerminalTarget(el), kanbanOpen, terminalFirst }
}
