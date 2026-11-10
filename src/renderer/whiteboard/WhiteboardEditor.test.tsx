// @vitest-environment jsdom
//
// The editor's save-and-finish rules with the real component. Excalidraw itself is replaced by a
// stub that hands over a fake imperative api: what is under test is when this component saves, and
// whether it lets editing END over work that is not on disk.
import { act, createRef, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type El = { id: string; version: number; isDeleted?: boolean }
const scene: { elements: El[] } = { elements: [] }
const appState = {
  selectedElementIds: {},
  editingTextElement: null,
  newElement: null,
  openMenu: null,
  openPopup: null,
  openDialog: null,
  zoom: { value: 1 },
  theme: 'dark'
}
const fakeApi = {
  getSceneElementsIncludingDeleted: () => scene.elements,
  getSceneElements: () => scene.elements,
  getAppState: () => appState,
  getFiles: () => ({}),
  updateScene: vi.fn(),
  refresh: vi.fn()
}
const excalidraw: { props: Record<string, unknown> | null } = { props: null }

vi.mock('@excalidraw/excalidraw/index.css', () => ({}))
vi.mock('@excalidraw/excalidraw', () => {
  const Nothing = () => null
  const MainMenu = Object.assign(Nothing, {
    DefaultItems: {
      SaveAsImage: Nothing,
      SearchMenu: Nothing,
      Help: Nothing,
      ClearCanvas: Nothing,
      ChangeCanvasBackground: Nothing
    },
    Separator: Nothing
  })
  return {
    Excalidraw: (props: { excalidrawAPI: (api: unknown) => void } & Record<string, unknown>) => {
      excalidraw.props = props
      useEffect(() => props.excalidrawAPI(fakeApi), [])
      return <div data-testid="excalidraw" />
    },
    MainMenu,
    exportToBlob: async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
    getNonDeletedElements: (els: El[]) => els.filter((e) => !e.isDeleted),
    hashElementsVersion: (els: El[]) => els.map((e) => `${e.id}@${e.version}`).join(','),
    restore: (d: { elements?: El[] }) => ({ elements: d.elements ?? [], appState: {}, files: {} }),
    serializeAsJSON: (els: El[]) => JSON.stringify({ type: 'excalidraw', elements: els })
  }
})

import WhiteboardEditor, { type WhiteboardEditorControl } from './WhiteboardEditor'

let host: HTMLDivElement
let root: Root
let overlay: HTMLDivElement

function mount(props: {
  onSave: (scene: string, thumb?: string) => Promise<boolean>
  onExit: (changed: boolean) => void
  readOnly?: boolean
  control?: { current: WhiteboardEditorControl | null }
}) {
  host = document.createElement('div')
  overlay = document.createElement('div')
  const frame = document.createElement('div')
  host.append(overlay, frame)
  document.body.append(host)
  const overlayRef = { current: overlay }
  const frameRef = { current: frame }
  root = createRoot(overlay)
  act(() =>
    root.render(
      <WhiteboardEditor
        initialScene={JSON.stringify({ type: 'excalidraw', elements: scene.elements })}
        theme="dark"
        canvasZoom={1}
        present={false}
        geometryKey="0"
        overlayRef={overlayRef}
        frameRef={frameRef}
        onSave={props.onSave}
        onExit={props.onExit}
        readOnly={props.readOnly}
        controlRef={props.control}
      />
    )
  )
}

/** The user draws: one element changes version, which is what makes the scene differ from disk. */
function draw() {
  scene.elements = [{ id: 'stroke', version: scene.elements.length + 2 }]
}

async function pressEscape() {
  await act(async () => {
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  scene.elements = [{ id: 'start', version: 1 }]
  excalidraw.props = null
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('finishing never closes the board over work that is not on disk', () => {
  it('a failed save keeps the board open, and a later save that succeeds finishes it', async () => {
    const onSave = vi.fn(async () => false)
    const onExit = vi.fn()
    mount({ onSave, onExit })
    draw()
    await pressEscape()
    expect(onSave).toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()

    onSave.mockImplementation(async () => true)
    await pressEscape()
    expect(onExit).toHaveBeenCalledWith(true)
  })

  it('a save that succeeds finishes at once', async () => {
    const onExit = vi.fn()
    mount({ onSave: async () => true, onExit })
    draw()
    await pressEscape()
    expect(onExit).toHaveBeenCalledWith(true)
  })

  it('discarding finishes without saving, and nothing is written when the editor goes away', async () => {
    const onSave = vi.fn(async () => false)
    const onExit = vi.fn()
    const control = createRef<WhiteboardEditorControl>() as { current: WhiteboardEditorControl | null }
    mount({ onSave, onExit, control })
    draw()
    await act(async () => control.current?.discard())
    expect(onExit).toHaveBeenCalledWith(false)
    act(() => root.unmount())
    root = createRoot(overlay)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('saveNow writes the pending changes on request (the header\'s "Keep mine")', async () => {
    const onSave = vi.fn(async () => true)
    const control = { current: null as WhiteboardEditorControl | null }
    mount({ onSave, onExit: vi.fn(), control })
    draw()
    let ok: boolean | undefined
    await act(async () => {
      ok = await control.current?.saveNow()
    })
    expect(ok).toBe(true)
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})

describe('a read-only board (a hosted-team Viewer)', () => {
  it('opens Excalidraw in view mode and never saves, so finishing loses nothing', async () => {
    const onSave = vi.fn(async () => true)
    const onExit = vi.fn()
    mount({ onSave, onExit, readOnly: true })
    expect(excalidraw.props?.viewModeEnabled).toBe(true)
    draw()
    await pressEscape()
    expect(onSave).not.toHaveBeenCalled()
    expect(onExit).toHaveBeenCalledWith(false)
  })
})

describe('quitting the app (or restarting to update) writes the pending strokes', () => {
  it('an open editor\'s unsaved changes are written by the quit flush', async () => {
    const { runQuitFlushes } = await import('../lib/quitFlush')
    const onSave = vi.fn(async () => true)
    mount({ onSave, onExit: vi.fn() })
    draw()
    await act(async () => runQuitFlushes())
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('a read-only board registers nothing to write', async () => {
    const { runQuitFlushes } = await import('../lib/quitFlush')
    const onSave = vi.fn(async () => true)
    mount({ onSave, onExit: vi.fn(), readOnly: true })
    draw()
    await act(async () => runQuitFlushes())
    expect(onSave).not.toHaveBeenCalled()
  })
})
