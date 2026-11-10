import { hasEditContext, isKeyboardOwnerTarget } from './keyContext'

/**
 * Should a click on the EMPTY canvas take the keyboard away from `active`?
 *
 * Issue #86 — a user holding space to pan (a Figma reflex; this canvas has no space-pan) watched
 * the spaces land in a sticky note they were not editing. The note had DOM focus from earlier and
 * nothing ever took it back: `onPaneClick` cleared the agent selection and left the focused element
 * exactly where it was, so every keystroke after clicking away still went into that textarea.
 *
 * Space is only how it was noticed. The same focus keeps every canvas shortcut suppressed too —
 * undo, ⌘T, Delete all skip while an input has the keyboard — so from the user's side the canvas
 * had simply stopped responding.
 *
 * True only for a real EDITING surface. A button or a node div that happens to be focused is
 * harmless and blurring it would fight the browser's own focus handling; a `textarea`, an `input`
 * or a `contenteditable` is the one that swallows typing — and so is an element with an EditContext
 * attached, which is what a focused Monaco editor is since 0.56 (issue #930, see `hasEditContext`).
 *
 * `null`/`body` is the already-correct state and answers false, so the common click costs nothing.
 */
export function shouldReleasePaneFocus(active: Element | null): boolean {
  if (!active) return false
  const tag = active.tagName
  if (tag === 'TEXTAREA' || tag === 'INPUT') return true
  return (active as HTMLElement).isContentEditable === true || hasEditContext(active) || isKeyboardOwnerTarget(active)
}
