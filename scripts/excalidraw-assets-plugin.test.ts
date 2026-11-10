import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { isServableFont, resolveExcalidrawAsset } from './excalidraw-assets-plugin'

const dist = '/app/node_modules/@excalidraw/excalidraw/dist/prod'

describe('excalidraw font serving', () => {
  it('maps a font request to the file under dist/prod', () => {
    expect(resolveExcalidrawAsset(dist, '/excalidraw-assets/fonts/Excalifont/Excalifont-Regular-abc.woff2')).toBe(
      join(dist, 'fonts/Excalifont/Excalifont-Regular-abc.woff2')
    )
  })

  it('refuses anything that walks out of the font folder, plain or encoded', () => {
    for (const url of [
      '/excalidraw-assets/fonts/../../../package.json',
      '/excalidraw-assets/fonts/%2e%2e/%2e%2e/package.json',
      '/excalidraw-assets/../index.js',
      '/excalidraw-assets/%E0%A4%A' // malformed escape
    ]) {
      expect(resolveExcalidrawAsset(dist, url), url).toBeNull()
    }
  })

  it('serves only .woff2 fonts, and never the 12 MB CJK family', () => {
    expect(isServableFont(join('fonts', 'Virgil', 'Virgil.woff2'))).toBe(true)
    expect(isServableFont(join('fonts', 'Xiaolai', 'Xiaolai-1.woff2'))).toBe(false)
    expect(isServableFont(join('fonts', 'Virgil', 'notes.txt'))).toBe(false)
    expect(isServableFont('index.js')).toBe(false)
  })
})
