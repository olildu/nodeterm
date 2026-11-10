import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NodeResizer, useReactFlow, useStore, type NodeProps } from '@xyflow/react'
import { Tooltip } from '../components/Tooltip'
import { IconCheck, IconClose, IconCopy, IconPlay } from '../components/icons'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import type { CanvasNode } from '../state/workspace'
import { useAppTheme } from '../state/useAppTheme'
import { useProjects } from '../state/projects'
import { markWorkspaceDirty } from '../state/workspaceDirty'
import { useSession } from '../session/session'
import { useHostedReadOnly } from '../state/hostedTeams'
import { MaximizeButton, useNodeMaximize } from './MaximizeButton'
import type { WhiteboardEditorControl } from '../whiteboard/WhiteboardEditor'

// Excalidraw (~1.7 MB of JS + CSS) loads the first time a board is opened for editing, never at
// startup and never for a board that is only being looked at. The asset path must be set before
// the chunk evaluates: Excalidraw builds its font list once and caches it.
const WhiteboardEditor = lazy(async () => {
  ;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = new URL(
    'excalidraw-assets/',
    window.location.href
  ).href
  return import('../whiteboard/WhiteboardEditor')
})

/** The canvas transform as a primitive key: re-measure the overlay whenever it pans or zooms. */
const transformKey = (s: { transform: [number, number, number] }): string => s.transform.join(',')

interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** Where the live editor goes: the canvas area (`clip`, relative to `.canvas-root`) and the
 *  node's body inside it (`board`, relative to the clip). */
interface Geometry {
  root: HTMLElement
  clip: Box
  board: Box
}

const pngDataUrl = (base64: string): string => `data:image/png;base64,${base64}`

/** The keys React Flow's node wrapper acts on: Enter / Space / Escape (select, unselect) and the
 *  arrows (move every selected node). */
const NODE_WRAPPER_KEYS = new Set(['Enter', ' ', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

/**
 * The editor is portaled out of the node's DOM but not out of its React tree, so React bubbles
 * the editor's events into React Flow's node wrapper. Measured in the dev app: a right-click on
 * the board opened the node menu over Excalidraw's own, an arrow key nudging a shape also moved
 * the node (and every other selected node), and a double-click (Excalidraw's "add text") flew the
 * camera to the node. Excalidraw's handlers sit below this point and run first.
 *
 * Stopping a React event also stops the native one at the React root, so document and window
 * listeners do not see it. That is why the keyboard is narrowed to the keys the wrapper acts on:
 * every other key still reaches them, and the canvas dispatcher already stands down for the
 * overlay (`data-nt-keyboard-owner`).
 */
const keepInBoard = (e: React.SyntheticEvent): void => e.stopPropagation()
const keepWrapperKeysInBoard = (e: React.KeyboardEvent): void => {
  if (NODE_WRAPPER_KEYS.has(e.key)) e.stopPropagation()
}

/** The resting picture's bytes as a PNG Blob, decoded here. NOT `fetch(dataUrl)`: the app's CSP
 *  (`default-src 'self'`, no `connect-src data:`) refuses a fetch of a data: URL, which is how
 *  "Copy as image" used to fail without a word. */
export function pngBlobFromBase64(base64: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: 'image/png' })
}

/**
 * A whiteboard: an infinite Excalidraw canvas inside a canvas node.
 *
 * At rest the body shows a picture of the board. Editing does NOT happen inside the node: React
 * Flow scales every node with `transform: scale(zoom)`, and Excalidraw sizes its canvas and maps
 * the pointer from `getBoundingClientRect()`, so inside a scaled node it draws off the pointer and
 * goes soft. Instead one live editor is portaled into `.canvas-root` — OUTSIDE `.flow-wrap`, whose
 * capture-phase wheel listener always zooms the canvas on ⌘-wheel / pinch — and laid exactly over
 * the node's on-screen box, clipped to the canvas area and stacked under the sidebar and Dock. It
 * follows the box as the canvas pans or zooms and the node moves, resizes or maximizes.
 *
 * The drawing lives in a side file the core addresses by (project, node id) — core/whiteboards.ts.
 * Node data carries only `whiteboardSource` (a copy's original, by id) and `boardRev` (bumped once
 * per editing session that changed the board), so strokes never reach the workspace save, canvas
 * undo or team sync.
 */
export function WhiteboardNode({ id, data, selected, positionAbsoluteX, positionAbsoluteY, width, height }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements } = useReactFlow()
  const session = useSession()
  const { api } = session
  // A hosted-team Viewer or Commenter: the host refuses their saves, so the board opens view-only
  // rather than letting them draw what can never be written.
  const readOnly = useHostedReadOnly(session.id)
  const theme = useAppTheme()
  const setMaximized = useNodeMaximize(id)
  // A node renders only inside its own project, and a project switch unmounts it — after the
  // active id has already moved on. Capture the owner once so a flush on the way out still lands
  // in THIS project's folder.
  const projectIdRef = useRef(useProjects.getState().activeProjectId)
  const dataRef = useRef(data)
  dataRef.current = data

  const frameRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<null | 'edit' | 'present'>(null)
  const [geom, setGeom] = useState<Geometry | null>(null)
  // The resting picture, base64 (the data: URL for the <img> is derived at render).
  const [thumb, setThumb] = useState<string>()
  // Bumped when editing ends, so the resting picture is read again: after "Discard my changes" the
  // board on disk may be someone else's newer version, which no node-data change announces here.
  const [pictureTick, setPictureTick] = useState(0)
  const sceneRef = useRef<string | undefined>(undefined)
  // The revision of the board file this editing session started from, then of each save it made —
  // what every save sends, so the core can refuse one made over somebody else's newer board
  // (core/whiteboards.ts, compare-and-set). `null`: this node has no board of its own yet (a new
  // board, or a copy still showing its source). `undefined`: unknown (a core on an older build
  // reports none), and the save is then not checked.
  const revRef = useRef<string | null | undefined>(undefined)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'unreadable'>('loading')
  // `conflict`: the core refused the last save because someone else saved this board meanwhile.
  const [saveState, setSaveState] = useState<'saved' | 'failed' | 'conflict'>('saved')
  // The revision on disk when the last save was refused: "Keep mine" saves over exactly that one.
  const conflictRevRef = useRef<string | null>(null)
  const editorControl = useRef<WhiteboardEditorControl | null>(null)
  const [copied, setCopied] = useState(false)
  const maximizedByPresentRef = useRef(false)
  const viewKey = useStore(transformKey)
  const canvasZoom = useStore((s) => s.transform[2])

  // Load the board (and again when a copy saves its own file, or a session elsewhere bumps the rev).
  useEffect(() => {
    let live = true
    // Through a promise chain so a session api without the channel at all (a relay host on an older
    // build answers with no `readWhiteboard`) lands in the catch below instead of throwing in render.
    Promise.resolve()
      // Picture only: the scene (megabytes once screenshots are pasted in) is fetched on open.
      .then(() => api.files.readWhiteboard(projectIdRef.current, id, data.whiteboardSource, false))
      .then((file) => {
        if (!live) return
        setThumb(file?.thumbnailBase64 || undefined)
        setLoadState('ready')
      })
      .catch(() => {
        // A relay host on an older build has no such channel, or the read failed outright. Not
        // "empty": opening an editor here and saving would overwrite a board we could not read.
        if (live) setLoadState('unreadable')
      })
    return () => {
      live = false
    }
  }, [api, id, data.whiteboardSource, data.boardRev, pictureTick])

  const measure = useCallback(() => {
    const body = bodyRef.current
    const wrap = body?.closest<HTMLElement>('.flow-wrap')
    const root = body?.closest<HTMLElement>('.canvas-root')
    if (!body || !wrap || !root) return
    const r = root.getBoundingClientRect()
    const w = wrap.getBoundingClientRect()
    const b = body.getBoundingClientRect()
    setGeom({
      root,
      clip: { left: w.left - r.left, top: w.top - r.top, width: w.width, height: w.height },
      board: { left: b.left - w.left, top: b.top - w.top, width: b.width, height: b.height }
    })
  }, [])

  // Follow the node's on-screen box while editing: pan/zoom (viewKey), drag (position), resize.
  useLayoutEffect(() => {
    if (mode) measure()
  }, [mode, measure, viewKey, positionAbsoluteX, positionAbsoluteY, width, height])
  useEffect(() => {
    if (!mode || !bodyRef.current) return
    const ro = new ResizeObserver(measure)
    ro.observe(bodyRef.current)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [mode, measure])

  const save = useCallback(
    async (scene: string, thumbnailBase64?: string): Promise<boolean> => {
      const res = await Promise.resolve()
        .then(() => api.files.saveWhiteboard(projectIdRef.current, id, scene, thumbnailBase64, revRef.current))
        .catch(() => null)
      if (!res) {
        setSaveState('failed')
        return false
      }
      if (typeof res === 'object' && !res.ok) {
        conflictRevRef.current = res.currentRev
        setSaveState('conflict')
        return false
      }
      // A core on an older build answers the bare path and no revision: the next save goes unchecked.
      revRef.current = typeof res === 'string' ? undefined : res.rev
      setSaveState('saved')
      sceneRef.current = scene
      if (thumbnailBase64 !== undefined) setThumb(thumbnailBase64 || undefined)
      // A copy has its own file now; it stops reading the original's.
      if (dataRef.current.whiteboardSource) {
        updateNodeData(id, { whiteboardSource: undefined })
        markWorkspaceDirty()
      }
      return true
    },
    [api, id, updateNodeData]
  )

  const openingRef = useRef(false)
  const start = useCallback(
    async (next: 'edit' | 'present') => {
      if (loadState !== 'ready' || openingRef.current) return
      openingRef.current = true
      try {
        const file = await Promise.resolve()
          .then(() => api.files.readWhiteboard(projectIdRef.current, id, dataRef.current.whiteboardSource))
          .catch(() => undefined)
        if (file === undefined) return setLoadState('unreadable')
        if (file?.scene !== undefined) {
          try {
            JSON.parse(file.scene)
          } catch {
            // Corrupt, or written by something else: never open an editor over it, or its first
            // autosave would overwrite the board.
            return setLoadState('unreadable')
          }
        }
        sceneRef.current = file?.scene
        revRef.current = !file || file.fromSource ? null : file.rev
        setSaveState('saved')
        if (next === 'present' && !dataRef.current.premaxRect) {
          setMaximized(false)
          maximizedByPresentRef.current = true
        }
        setMode(next)
      } finally {
        openingRef.current = false
      }
    },
    [api, id, loadState, setMaximized]
  )

  // A new board opens straight into drawing — the reason you made one.
  useEffect(() => {
    if (data.autoEdit && loadState === 'ready') {
      updateNodeData(id, { autoEdit: undefined })
      void start('edit')
    }
  }, [data.autoEdit, loadState, id, updateNodeData, start])

  const end = useCallback(
    (changed: boolean) => {
      if (maximizedByPresentRef.current && dataRef.current.premaxRect) setMaximized(true)
      maximizedByPresentRef.current = false
      setMode(null)
      setSaveState('saved')
      setPictureTick((t) => t + 1)
      // Read again on the next open; a board at rest keeps only its picture.
      sceneRef.current = undefined
      if (changed) {
        // Once per session, never per stroke: what a linked agent and the save cadence key on.
        updateNodeData(id, { boardRev: Date.now() })
        markWorkspaceDirty()
      }
    },
    [id, setMaximized, updateNodeData]
  )

  const copyImage = useCallback(async () => {
    if (!thumb) return
    try {
      const blob = pngBlobFromBase64(thumb)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard refused (no focus, no permission, a browser without image clipboard): say so — a
      // copy button that does nothing reads as broken.
      window.dispatchEvent(
        new CustomEvent('nodeterm:toast', {
          detail: { kind: 'error', message: 'Could not copy the whiteboard: the clipboard refused the image.' }
        })
      )
    }
  }, [thumb])

  return (
    <>
      <div
        ref={frameRef}
        className={`whiteboard-node${selected ? ' selected' : ''}${mode ? ' editing' : ''}`}
        style={{ borderColor: data.color }}
      >
        <NodeResizer isVisible={selected} color={data.color} lineClassName="nt-resize-ghost" handleClassName="nt-resize-ghost" />
        <div className="whiteboard-node__header" style={{ background: `${data.color}33` }}>
          <span className="term-node__color" style={{ background: data.color }} />
          <input
            className="term-node__title nodrag"
            value={data.title}
            spellCheck={false}
            onChange={(e) => updateNodeData(id, { title: e.target.value })}
          />
          {saveState !== 'saved' && (
            <span
              className="whiteboard-node__save-failed"
              role="status"
              title={
                saveState === 'conflict'
                  ? 'Someone else saved this board while it was open here (another tab, another computer on this folder, or a teammate). Their version was kept; your changes are not saved.'
                  : 'The last change could not be written. The board stays open and finishing waits until a save succeeds; it retries on the next change.'
              }
            >
              {saveState === 'conflict' ? 'Changed elsewhere' : 'Not saved'}
            </span>
          )}
          {mode && saveState === 'conflict' && (
            <Tooltip label="Save your version over the one saved elsewhere">
              <button
                className="whiteboard-node__save-action nodrag"
                onClick={(e) => {
                  e.stopPropagation()
                  revRef.current = conflictRevRef.current
                  void editorControl.current?.saveNow()
                }}
              >
                Keep mine
              </button>
            </Tooltip>
          )}
          {mode && saveState !== 'saved' && (
            <Tooltip label="Stop editing without your unsaved changes; the board on disk is kept as it is">
              <button
                className="whiteboard-node__save-action nodrag"
                onClick={(e) => {
                  e.stopPropagation()
                  editorControl.current?.discard()
                }}
              >
                Discard my changes
              </button>
            </Tooltip>
          )}
          <span className="term-node__spacer" />
          <Tooltip label={copied ? 'Copied' : 'Copy as image'}>
            <button
              className="term-node__maximize nodrag"
              aria-label="Copy whiteboard as image"
              disabled={!thumb}
              onClick={(e) => {
                e.stopPropagation()
                void copyImage()
              }}
            >
              {copied ? <IconCheck /> : <IconCopy />}
            </button>
          </Tooltip>
          <Tooltip label="Present — fill the canvas and hide the toolbars (Esc to finish)">
            <button
              className="term-node__maximize nodrag"
              aria-label="Present whiteboard"
              aria-pressed={mode === 'present'}
              onClick={(e) => {
                e.stopPropagation()
                if (mode === 'present') setMode('edit')
                else void start('present')
              }}
            >
              <IconPlay />
            </button>
          </Tooltip>
          <MaximizeButton id={id} maximized={!!data.premaxRect} />
          <Tooltip label="Close">
            <button className="term-node__close" aria-label="Close" onClick={() => deleteElements({ nodes: [{ id }] })}>
              <IconClose />
            </button>
          </Tooltip>
        </div>
        <div
          ref={bodyRef}
          className="whiteboard-node__body nodrag nowheel"
          onDoubleClick={() => void start('edit')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void start('edit')
          }}
          tabIndex={0}
          role="button"
          aria-label="Open whiteboard for drawing"
        >
          {loadState === 'unreadable' ? (
            <span className="whiteboard-node__hint">This board could not be read here</span>
          ) : thumb ? (
            <img className="whiteboard-node__thumb" src={pngDataUrl(thumb)} alt="" draggable={false} />
          ) : loadState === 'ready' ? (
            <span className="whiteboard-node__hint">Double-click to draw</span>
          ) : null}
        </div>
      </div>
      <NodeResizer
        minWidth={NODE_MIN_SIZES.whiteboard.width}
        minHeight={NODE_MIN_SIZES.whiteboard.height}
        isVisible={selected}
        color={data.color}
      />
      {mode &&
        geom &&
        createPortal(
          <div
            className="whiteboard-clip"
            style={geom.clip}
            onClick={keepInBoard}
            onDoubleClick={keepInBoard}
            onContextMenu={keepInBoard}
            onKeyDown={keepWrapperKeysInBoard}
          >
            <div ref={overlayRef} className="whiteboard-overlay" data-nt-keyboard-owner="" style={geom.board}>
              <Suspense fallback={<div className="whiteboard-overlay__loading">Loading whiteboard…</div>}>
                <WhiteboardEditor
                  initialScene={sceneRef.current}
                  theme={theme}
                  canvasZoom={canvasZoom}
                  present={mode === 'present'}
                  readOnly={readOnly}
                  controlRef={editorControl}
                  geometryKey={`${geom.board.left},${geom.board.top},${geom.board.width},${geom.board.height},${geom.clip.left},${geom.clip.top}`}
                  overlayRef={overlayRef}
                  frameRef={frameRef}
                  onSave={save}
                  onExit={end}
                />
              </Suspense>
            </div>
          </div>,
          geom.root
        )}
    </>
  )
}
