import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { isInputDOMNode } from '@xyflow/system'
import {
  XTERM_INPUT_CLASS,
  hasEditContext,
  isTerminalTarget,
  isTypingTarget,
  keyDispatchContextFor,
  KEYBOARD_OWNER_SELECTOR,
  isKeyboardOwnerTarget
} from './keyContext'

const el = (
  tagName: string,
  extra: Partial<{ isContentEditable: boolean; classes: string[]; editContext: unknown }> = {}
) => ({
  tagName,
  isContentEditable: extra.isContentEditable,
  editContext: extra.editContext,
  classList: { contains: (n: string) => (extra.classes ?? []).includes(n) }
})

describe('isTerminalTarget', () => {
  it('true only for the xterm helper textarea', () => {
    expect(isTerminalTarget(el('TEXTAREA', { classes: [XTERM_INPUT_CLASS] }))).toBe(true)
    expect(isTerminalTarget(el('TEXTAREA'))).toBe(false)
    expect(isTerminalTarget(null)).toBe(false)
  })
})

describe('isTypingTarget', () => {
  it('inputs, textareas and contentEditable are typing', () => {
    expect(isTypingTarget(el('INPUT'))).toBe(true)
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true)
    expect(isTypingTarget(el('DIV', { isContentEditable: true }))).toBe(true)
  })
  it('an element with an EditContext attached is typing — the Monaco editor (#930)', () => {
    // Monaco 0.56 types through `div.native-edit-context` + the EditContext API: no textarea, no
    // contentEditable. Missing it let canvas shortcuts (⌘T, ⌘⇧A, …) fire from inside an editor.
    expect(isTypingTarget(el('DIV', { editContext: {} }))).toBe(true)
    expect(hasEditContext(el('DIV', { editContext: {} }))).toBe(true)
    // `null` is what an element WITHOUT one reports (and what Monaco sets on dispose).
    expect(hasEditContext(el('DIV', { editContext: null }))).toBe(false)
    expect(hasEditContext(el('DIV'))).toBe(false)
    expect(hasEditContext(null)).toBe(false)
  })
  it('the xterm helper textarea is NOT typing (it is the terminal)', () => {
    expect(isTypingTarget(el('TEXTAREA', { classes: [XTERM_INPUT_CLASS] }))).toBe(false)
  })
  it('plain elements and null are not typing', () => {
    expect(isTypingTarget(el('DIV'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })

  // The whiteboard's Excalidraw focuses a plain container div. Without this, Space panned the canvas
  // and Delete/⌘Z reached canvas commands while drawing (measured in the dev build).
  it('a plain element inside a keyboard-owning surface is typing (the whiteboard editor)', () => {
    const inside = { ...el('DIV'), closest: (sel: string) => (sel === KEYBOARD_OWNER_SELECTOR ? {} : null) }
    const outside = { ...el('DIV'), closest: () => null }
    expect(isKeyboardOwnerTarget(inside)).toBe(true)
    expect(isTypingTarget(inside)).toBe(true)
    expect(isTypingTarget(outside)).toBe(false)
  })
})

describe('keyDispatchContextFor', () => {
  it('typing and terminal are disjoint by construction', () => {
    expect(
      keyDispatchContextFor(el('TEXTAREA', { classes: [XTERM_INPUT_CLASS] }), false, false)
    ).toEqual({
      typing: false,
      terminal: true,
      kanbanOpen: false,
      terminalFirst: false
    })
    expect(keyDispatchContextFor(el('INPUT'), true, false)).toEqual({
      typing: true,
      terminal: false,
      kanbanOpen: true,
      terminalFirst: false
    })
  })
  it('carries the terminal-first policy through as given', () => {
    expect(
      keyDispatchContextFor(el('TEXTAREA', { classes: [XTERM_INPUT_CLASS] }), false, true)
    ).toEqual({
      typing: false,
      terminal: true,
      kanbanOpen: false,
      terminalFirst: true
    })
  })
})

describe('xterm version pin', () => {
  it('the installed xterm dist still renders the helper-textarea class', () => {
    // The entire terminal-vs-typing split keys off this class name. If an xterm upgrade
    // renames it, this test fails instead of every terminal keystroke silently becoming 'app'.
    const dist = readFileSync('node_modules/@xterm/xterm/lib/xterm.js', 'utf8')
    expect(dist.includes(XTERM_INPUT_CLASS)).toBe(true)
  })
})

describe('Monaco EditContext pin (#930)', () => {
  it('the installed Monaco still types through an EditContext, on by default', () => {
    // Why `hasEditContext` exists at all. If a Monaco upgrade drops the EditContext input (or turns
    // it off by default) this fails, and the check can be re-evaluated rather than left to rot.
    const native = readFileSync(
      'node_modules/monaco-editor/esm/vs/editor/browser/controller/editContext/native/nativeEditContext.js',
      'utf8'
    )
    expect(native.includes('.editContext = this._editContext')).toBe(true)
    const options = readFileSync(
      'node_modules/monaco-editor/esm/vs/editor/common/config/editorOptions.js',
      'utf8'
    )
    expect(/'editContext', true/.test(options)).toBe(true)
  })
})

describe("React Flow's own key handling vs the Monaco editor (#930)", () => {
  // React Flow runs key handlers of its own (the node wrapper's arrow-key move, its key-press
  // hooks), and they stand down only for what `isInputDOMNode` recognises: an INPUT/SELECT/TEXTAREA,
  // a `contenteditable` ATTRIBUTE, or anything inside `.nokey`. Monaco's EditContext div is none of
  // the first three, so the Monaco mounts carry `nokey`.
  const editContextDiv = (insideNokey: boolean) => ({
    nodeType: 1,
    nodeName: 'DIV',
    editContext: {},
    hasAttribute: () => false,
    closest: (sel: string) => (insideNokey && sel === '.nokey' ? {} : null)
  })
  const keyEvent = (target: unknown) => ({ target }) as unknown as KeyboardEvent

  it('an EditContext div is NOT an input to React Flow on its own', () => {
    expect(isInputDOMNode(keyEvent(editContextDiv(false)))).toBe(false)
  })

  it('…and IS one inside `.nokey`', () => {
    expect(isInputDOMNode(keyEvent(editContextDiv(true)))).toBe(true)
  })

  it('every Monaco mount carries `nokey`', () => {
    for (const file of ['src/renderer/nodes/EditorNode.tsx', 'src/renderer/nodes/DiffNode.tsx']) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).toMatch(/className="[^"]*\bnokey\b[^"]*"\s+ref=\{bodyRef\}/)
    }
  })
})
