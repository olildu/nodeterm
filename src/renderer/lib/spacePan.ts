/**
 * Space-to-pan — the Figma/Miro reflex, asked for in issue #86.
 *
 * Holding SPACE turns a left-drag on the canvas into a pan for as long as it is held. The pure
 * decisions live here because the failure modes are all about WHEN it may engage, and every one of
 * them is testable without a DOM.
 */
import { hasEditContext, isKeyboardOwnerTarget } from './keyContext'

/** What a space keydown should do. */
export type SpacePanAction = 'engage' | 'ignore'

/**
 * Is this element one that a space keystroke BELONGS to?
 *
 * The whole feature turns on this question, because space is not a spare key: it is a character in
 * every terminal and every note on the canvas. Getting it wrong does not degrade panning, it
 * corrupts what the user is typing.
 *
 * xterm is covered without a special case, and that is not luck: xterm takes the keyboard through a
 * hidden `<textarea>`, so a focused terminal answers true here exactly like a sticky note does.
 * Monaco is NOT a textarea any more (issue #930): it types through an EditContext, which
 * `hasEditContext` recognises — without it, every space typed in an editor node became a pan.
 */
export function typingTarget(active: Element | null): boolean {
  if (!active) return false
  const tag = active.tagName
  if (tag === 'TEXTAREA' || tag === 'INPUT') return true
  return (active as HTMLElement).isContentEditable === true || hasEditContext(active) || isKeyboardOwnerTarget(active)
}

/** The event shape this reads — a `KeyboardEvent` satisfies it, and so does a test literal. */
export interface SpaceKeyEvent {
  key: string
  /** True for the auto-repeat that follows a held key. */
  repeat?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

/**
 * Should this keydown engage space-pan?
 *
 * Ignored, and each for its own reason:
 *  - not the space bar;
 *  - a MODIFIED space (⌘Space is the OS switcher, Ctrl/Alt+Space belong to other bindings) — taking
 *    those would break something the user meant for someone else;
 *  - the auto-REPEAT of a held key, so engaging happens once per press rather than sixty times a
 *    second;
 *  - anything typed into a terminal, a note or a field, which is the case that matters most: a
 *    space swallowed there is a wrong character in the user's text, not a missing pan;
 *  - any space at all while a board covers the canvas (see `canvasCovered`).
 */
export function spacePanKeydown(
  e: SpaceKeyEvent,
  active: Element | null,
  /** A board view covers the canvas (it stays mounted underneath): there is nothing to pan, and
   *  the space belongs to the board — its focused buttons and its "open the card" key. */
  canvasCovered = false
): SpacePanAction {
  if (canvasCovered) return 'ignore'
  if (e.key !== ' ' && e.key !== 'Spacebar') return 'ignore'
  if (e.repeat) return 'ignore'
  if (e.ctrlKey || e.metaKey || e.altKey) return 'ignore'
  if (typingTarget(active)) return 'ignore'
  return 'engage'
}

/** Is this keyup the release of the space bar? Modifier-blind on purpose: a user who taps ⌘ while
 *  panning still gets a keyup for space, and a pan that never released would strand the canvas in
 *  grab mode. */
export function isSpaceRelease(e: SpaceKeyEvent): boolean {
  return e.key === ' ' || e.key === 'Spacebar'
}
