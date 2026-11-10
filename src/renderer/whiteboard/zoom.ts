// The whiteboard's zoom is RELATIVE to the canvas (nodes/WhiteboardNode.tsx).
//
// On screen Excalidraw runs at `boardZoom × canvasZoom`, so the drawing grows and shrinks with the
// canvas exactly like the node's frame and its resting picture do — and stays sharp, because
// Excalidraw redraws at the real size instead of a CSS scale stretching its bitmap. The file keeps
// only the board zoom, so a board saved at 50% canvas zoom does not reopen half-size at 100%.

/** Excalidraw's own zoom range; anything outside it is clamped by Excalidraw anyway. */
export const EXCALIDRAW_ZOOM_MIN = 0.1
export const EXCALIDRAW_ZOOM_MAX = 30

export const clampZoom = (v: number): number =>
  Math.min(EXCALIDRAW_ZOOM_MAX, Math.max(EXCALIDRAW_ZOOM_MIN, Number.isFinite(v) && v > 0 ? v : 1))

/** The zoom Excalidraw should run at for a board zoom (from the file) on a canvas zoom. */
export const screenZoom = (boardZoom: number, canvasZoom: number): number => clampZoom(boardZoom * canvasZoom)

/** The board zoom to store, given what Excalidraw runs at on screen and the canvas zoom. */
export const boardZoom = (screen: number, canvasZoom: number): number =>
  clampZoom(screen / (Number.isFinite(canvasZoom) && canvasZoom > 0 ? canvasZoom : 1))

/** The canvas zoomed from `prev` to `next` while the board was open: Excalidraw's new zoom, keeping
 *  whatever board zoom the user had set inside it. */
export const rescaleForCanvas = (screen: number, prev: number, next: number): number =>
  screenZoom(boardZoom(screen, prev), next)
