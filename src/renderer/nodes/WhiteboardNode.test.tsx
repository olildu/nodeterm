// @vitest-environment jsdom
//
// The whiteboard node's own decisions, with the real component: what it sends when it saves, what
// it shows when a save fails or is refused. The live editor (Excalidraw) is replaced by a stub that
// records the props the node hands it — the node is what decides those, and the editor's own logic
// has its own test (whiteboard/WhiteboardEditor.test.tsx).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../state/workspace'
import type { WhiteboardFile } from '@shared/whiteboard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// jsdom has none; the node only uses it to follow its own box while editing.
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

interface EditorProps {
  initialScene: string | undefined
  readOnly?: boolean
  onSave: (scene: string, thumbnailBase64?: string) => Promise<boolean>
  onExit: (changed: boolean) => void
  controlRef?: { current: { saveNow: () => Promise<boolean>; discard: () => void } | null }
}
const editor: { props: EditorProps | null; discarded: number } = { props: null, discarded: 0 }
vi.mock('../whiteboard/WhiteboardEditor', () => ({
  default: (props: EditorProps) => {
    editor.props = props
    if (props.controlRef) {
      props.controlRef.current = {
        saveNow: () => props.onSave(JSON.stringify({ type: 'excalidraw', elements: [] })),
        discard: () => {
          editor.discarded++
          props.onExit(false)
        }
      }
    }
    return <div data-testid="editor" />
  }
}))

const files = {
  readWhiteboard: vi.fn<(...a: unknown[]) => Promise<WhiteboardFile | null>>(),
  saveWhiteboard: vi.fn<(...a: unknown[]) => Promise<unknown>>()
}
vi.mock('../session/session', () => ({
  useSession: () => ({ id: 'local', source: 'local', api: { files } })
}))

import { WhiteboardNode } from './WhiteboardNode'
import { useProjects } from '../state/projects'
import { useHostedTeams } from '../state/hostedTeams'

const SCENE = JSON.stringify({ type: 'excalidraw', elements: [] })

let host: HTMLDivElement
let root: Root

/** React Flow's node wrapper, as far as the React tree is concerned: the handlers it hangs on the
 *  node's parent element (select on click, focus on double-click, the node menu, keyboard
 *  select/move). The editor is portaled out of the node's DOM but NOT out of this React tree. */
type WrapperHandlers = Pick<
  React.HTMLAttributes<HTMLDivElement>,
  'onClick' | 'onDoubleClick' | 'onContextMenu' | 'onKeyDown'
>

function mount(data: Partial<CanvasNode['data']> = {}, wrapper: WrapperHandlers = {}) {
  host = document.createElement('div')
  // The overlay is portaled into `.canvas-root` and clipped to `.flow-wrap`; the node finds both
  // by ancestry before it mounts an editor.
  host.className = 'canvas-root'
  const wrap = document.createElement('div')
  wrap.className = 'flow-wrap'
  host.append(wrap)
  document.body.append(host)
  root = createRoot(wrap)
  const props = {
    id: 'whiteboard-1',
    data: { title: 'Whiteboard', color: '#64d2ff', group: null, ...data },
    selected: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    width: 900,
    height: 600
  } as unknown as NodeProps<CanvasNode>
  act(() =>
    root.render(
      <ReactFlowProvider>
        <div {...wrapper}>
          <WhiteboardNode {...props} />
        </div>
      </ReactFlowProvider>
    )
  )
}

/** Let the picture read, the scene read and the lazy editor chunk all settle. */
const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
})

async function openEditor(): Promise<EditorProps> {
  await settle()
  const body = host.querySelector('.whiteboard-node__body')!
  act(() => {
    body.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await settle()
  expect(editor.props).not.toBeNull()
  return editor.props!
}

beforeEach(() => {
  editor.props = null
  editor.discarded = 0
  useHostedTeams.getState().forget('local')
  files.readWhiteboard.mockReset()
  files.saveWhiteboard.mockReset()
  useProjects.setState({ activeProjectId: 'p1' })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('saving sends the revision the editor started from', () => {
  it('sends the loaded revision, then the one each save returns', async () => {
    files.readWhiteboard.mockResolvedValue({ scene: SCENE, updatedAt: 1, rev: 'r1', fromSource: false })
    files.saveWhiteboard
      .mockResolvedValueOnce({ ok: true, path: '/p/whiteboard-1.excalidraw', rev: 'r2' })
      .mockResolvedValueOnce({ ok: true, path: '/p/whiteboard-1.excalidraw', rev: 'r3' })
    mount()
    const props = await openEditor()
    await act(async () => void (await props.onSave(SCENE)))
    expect(files.saveWhiteboard.mock.calls[0]?.[4]).toBe('r1')
    await act(async () => void (await props.onSave(SCENE)))
    expect(files.saveWhiteboard.mock.calls[1]?.[4]).toBe('r2')
  })

  it('a copy still showing its source saves as "no board of my own yet" (null)', async () => {
    files.readWhiteboard.mockResolvedValue({ scene: SCENE, updatedAt: 1, rev: 'src-rev', fromSource: true })
    files.saveWhiteboard.mockResolvedValue({ ok: true, path: '/p/whiteboard-1.excalidraw', rev: 'r1' })
    mount({ whiteboardSource: 'whiteboard-0' })
    const props = await openEditor()
    await act(async () => void (await props.onSave(SCENE)))
    expect(files.saveWhiteboard.mock.calls[0]?.[4]).toBeNull()
  })

  it('a refused save (someone else saved meanwhile) is a failure the header names', async () => {
    files.readWhiteboard.mockResolvedValue({ scene: SCENE, updatedAt: 1, rev: 'r1', fromSource: false })
    files.saveWhiteboard.mockResolvedValue({ ok: false, conflict: true, currentRev: 'r9' })
    mount()
    const props = await openEditor()
    let saved: boolean | undefined
    await act(async () => {
      saved = await props.onSave(SCENE)
    })
    expect(saved).toBe(false)
    expect(host.querySelector('.whiteboard-node__save-failed')?.textContent).toMatch(/changed elsewhere/i)
  })

  it('a core on an older build (bare path answer, no revision) still counts as saved', async () => {
    files.readWhiteboard.mockResolvedValue({ scene: SCENE, updatedAt: 1, fromSource: false })
    files.saveWhiteboard.mockResolvedValue('/p/whiteboard-1.excalidraw')
    mount()
    const props = await openEditor()
    let saved: boolean | undefined
    await act(async () => {
      saved = await props.onSave(SCENE)
    })
    expect(saved).toBe(true)
    expect(files.saveWhiteboard.mock.calls[0]?.[4]).toBeUndefined()
    expect(host.querySelector('.whiteboard-node__save-failed')).toBeNull()
  })
})

const button = (label: RegExp): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => label.test(b.textContent ?? '') || label.test(b.getAttribute('aria-label') ?? ''))

describe('a save that did not land offers a way forward instead of losing the work', () => {
  it('"Keep mine" after a conflict saves over the other version, knowingly (its revision)', async () => {
    files.readWhiteboard.mockResolvedValue({ scene: SCENE, updatedAt: 1, rev: 'r1', fromSource: false })
    files.saveWhiteboard
      .mockResolvedValueOnce({ ok: false, conflict: true, currentRev: 'r9' })
      .mockResolvedValueOnce({ ok: true, path: '/p/whiteboard-1.excalidraw', rev: 'r10' })
    mount()
    const props = await openEditor()
    await act(async () => void (await props.onSave(SCENE)))
    const keep = button(/keep mine/i)
    expect(keep).toBeDefined()
    await act(async () => keep!.click())
    await settle()
    expect(files.saveWhiteboard.mock.calls[1]?.[4]).toBe('r9')
    expect(host.querySelector('.whiteboard-node__save-failed')).toBeNull()
  })

  it('"Discard my changes" appears while a save keeps failing and ends editing without them', async () => {
    files.readWhiteboard.mockResolvedValue({ scene: SCENE, updatedAt: 1, rev: 'r1', fromSource: false })
    files.saveWhiteboard.mockResolvedValue(null)
    mount()
    const props = await openEditor()
    expect(button(/discard my changes/i)).toBeUndefined()
    await act(async () => void (await props.onSave(SCENE)))
    const discard = button(/discard my changes/i)
    expect(discard).toBeDefined()
    await act(async () => discard!.click())
    expect(editor.discarded).toBe(1)
  })
})

describe('the live editor keeps its events away from the canvas node', () => {
  // Measured in the dev app: a right-click on the board opened Excalidraw's menu AND the node menu,
  // an arrow key nudging a shape also moved the node (every selected node), and a double-click
  // (Excalidraw's "add text") flew the camera to the node.
  async function openWithWrapper() {
    files.readWhiteboard.mockResolvedValue({ scene: SCENE, rev: 'r1' } as WhiteboardFile)
    const wrapper = {
      onClick: vi.fn(),
      onDoubleClick: vi.fn(),
      onContextMenu: vi.fn(),
      onKeyDown: vi.fn()
    }
    mount({}, wrapper)
    await settle()
    act(() => {
      host.querySelector('.whiteboard-node__body')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await settle()
    // The double-click that OPENED the board is the node's own and reaches the wrapper; only what
    // happens inside the editor must not.
    wrapper.onDoubleClick.mockClear()
    const target = host.querySelector('[data-testid="editor"]')!
    expect(target).not.toBeNull()
    return { wrapper, target }
  }

  it('a right-click, click or double-click on the board never reaches the node', async () => {
    const { wrapper, target } = await openWithWrapper()
    act(() => {
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(wrapper.onContextMenu).not.toHaveBeenCalled()
    expect(wrapper.onClick).not.toHaveBeenCalled()
    expect(wrapper.onDoubleClick).not.toHaveBeenCalled()
  })

  it('the keys the node wrapper acts on (arrows, Enter, Space, Escape) stay in the board', async () => {
    const { wrapper, target } = await openWithWrapper()
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Escape']) {
      act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      })
    }
    expect(wrapper.onKeyDown).not.toHaveBeenCalled()
    // Every other key is left alone: stopping a React event stops the native one at the root too.
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    })
    expect(wrapper.onKeyDown).toHaveBeenCalledTimes(1)
  })
})

describe('a hosted-team Viewer', () => {
  it('opens the board read-only (the host refuses their saves)', async () => {
    useHostedTeams.getState().set('local', { role: 'viewer', teamLabel: 'Team' })
    files.readWhiteboard.mockResolvedValue({ scene: SCENE, updatedAt: 1, rev: 'r1', fromSource: false })
    mount()
    const props = await openEditor()
    expect(props.readOnly).toBe(true)
  })

  it('an Editor does not', async () => {
    useHostedTeams.getState().set('local', { role: 'editor', teamLabel: 'Team' })
    files.readWhiteboard.mockResolvedValue({ scene: SCENE, updatedAt: 1, rev: 'r1', fromSource: false })
    mount()
    const props = await openEditor()
    expect(props.readOnly).toBeFalsy()
  })
})

describe('Copy as image', () => {
  // The app's CSP (`default-src 'self'`, no `connect-src data:`) refuses `fetch` of a data: URL —
  // measured in Chrome with the exact index.html policy: "TypeError: Failed to fetch". The stub
  // answers the same way, so a copy that goes through fetch fails here as it does in the app.
  const PNG_BASE64 = 'iVBORw0KGgo='
  let written: Array<Record<string, Blob>>
  const realFetch = globalThis.fetch

  beforeEach(() => {
    written = []
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    ;(globalThis as { ClipboardItem?: unknown }).ClipboardItem = class {
      constructor(public items: Record<string, Blob>) {}
    }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: vi.fn(async (items: Array<{ items: Record<string, Blob> }>) => {
          written.push(...items.map((i) => i.items))
        })
      }
    })
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('puts the board picture on the clipboard as a PNG without fetching a data: URL', async () => {
    files.readWhiteboard.mockResolvedValue({ thumbnailBase64: PNG_BASE64, updatedAt: 1, rev: 'r1', fromSource: false })
    mount()
    await settle()
    const copy = button(/copy whiteboard as image/i)
    expect(copy?.disabled).toBe(false)
    await act(async () => copy!.click())
    await settle()
    expect(written).toHaveLength(1)
    const blob = written[0]!['image/png']!
    expect(blob.type).toBe('image/png')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('a clipboard that refuses the image is reported, not swallowed', async () => {
    ;(navigator.clipboard.write as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('NotAllowedError'))
    const toasts: unknown[] = []
    const onToast = (e: Event) => toasts.push((e as CustomEvent).detail)
    window.addEventListener('nodeterm:toast', onToast)
    files.readWhiteboard.mockResolvedValue({ thumbnailBase64: 'iVBORw0KGgo=', updatedAt: 1, rev: 'r1', fromSource: false })
    mount()
    await settle()
    await act(async () => button(/copy whiteboard as image/i)!.click())
    await settle()
    window.removeEventListener('nodeterm:toast', onToast)
    expect(toasts).toEqual([expect.objectContaining({ kind: 'error' })])
  })
})
