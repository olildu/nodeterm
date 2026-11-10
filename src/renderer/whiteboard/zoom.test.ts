import { describe, expect, it } from 'vitest'
import { EXCALIDRAW_ZOOM_MAX, EXCALIDRAW_ZOOM_MIN, boardZoom, rescaleForCanvas, screenZoom } from './zoom'

describe('whiteboard zoom follows the canvas', () => {
  it('a board opens at its own zoom times the canvas zoom', () => {
    expect(screenZoom(1, 0.5)).toBe(0.5)
    expect(screenZoom(2, 1.5)).toBe(3)
  })

  it('stores the board zoom without the canvas part, so it reopens the same at any canvas zoom', () => {
    expect(boardZoom(0.5, 0.5)).toBe(1)
    expect(screenZoom(boardZoom(0.75, 0.5), 1)).toBe(1.5)
  })

  it('zooming the canvas rescales the open board by the same factor, keeping the user’s board zoom', () => {
    expect(rescaleForCanvas(1.665, 1.665, 0.49)).toBeCloseTo(0.49)
    // The user had zoomed into the board 2× at canvas 100%; the canvas goes to 50%: board shows 1×.
    expect(rescaleForCanvas(2, 1, 0.5)).toBe(1)
  })

  it('stays inside Excalidraw’s range and survives a bad stored zoom', () => {
    expect(screenZoom(100, 1)).toBe(EXCALIDRAW_ZOOM_MAX)
    expect(screenZoom(0.01, 0.1)).toBe(EXCALIDRAW_ZOOM_MIN)
    expect(screenZoom(Number.NaN, 1)).toBe(1)
    expect(boardZoom(1, 0)).toBe(1)
  })
})
