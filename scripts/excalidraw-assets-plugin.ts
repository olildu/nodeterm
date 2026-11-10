import { createReadStream, readdirSync, readFileSync, statSync } from 'fs'
import { join, normalize, relative, resolve, sep } from 'path'
import type { Plugin } from 'vite'

/**
 * Serves Excalidraw's font files to the whiteboard node (nodes/WhiteboardNode.tsx) offline.
 *
 * Excalidraw fetches each font from `${window.EXCALIDRAW_ASSET_PATH}fonts/<Family>/<file>.woff2`
 * — an exact path, so Vite's ordinary asset handling (which hashes and flattens names) cannot
 * serve them, and the default (a CDN) is blocked by the renderer CSP and absent offline. This
 * mirrors `dist/prod/fonts` under `excalidraw-assets/`: served from node_modules in dev, emitted
 * into the build output otherwise. Xiaolai (the CJK family, ~12 MB of the ~12.4 MB) is left out;
 * Excalidraw falls back to a system font for CJK text without it.
 */
const URL_PREFIX = '/excalidraw-assets/'
const SKIPPED_FAMILIES = new Set(['Xiaolai'])

/** A path relative to `dist/prod` that may be served: a `.woff2` under `fonts/`, not Xiaolai. */
export function isServableFont(rel: string): boolean {
  const parts = rel.split(sep)
  return parts[0] === 'fonts' && !SKIPPED_FAMILIES.has(parts[1] ?? '') && rel.endsWith('.woff2')
}

/**
 * The file a dev-server request for `/excalidraw-assets/...` maps to, or null when it must 404.
 * `normalize` folds any `..` / `%2e%2e` first, then the result must still be inside `distDir` and
 * be a servable font — so no request can walk out of the font folder.
 */
export function resolveExcalidrawAsset(distDir: string, url: string): string | null {
  if (!url.startsWith(URL_PREFIX)) return null
  let rel: string
  try {
    rel = normalize(decodeURIComponent(url.slice(URL_PREFIX.length)))
  } catch {
    return null
  }
  const file = join(distDir, rel)
  if (relative(distDir, file).startsWith('..') || !isServableFont(rel)) return null
  return file
}

export function excalidrawAssetsPlugin(root: string): Plugin {
  const distDir = resolve(root, 'node_modules/@excalidraw/excalidraw/dist/prod')
  const fontsDir = join(distDir, 'fonts')

  return {
    name: 'nodeterm:excalidraw-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0]
        if (!url?.startsWith(URL_PREFIX)) return next()
        const file = resolveExcalidrawAsset(distDir, url)
        try {
          if (!file || !statSync(file).isFile()) throw new Error('not servable')
        } catch {
          res.statusCode = 404
          return res.end()
        }
        res.setHeader('Content-Type', 'font/woff2')
        createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
        )
      for (const file of walk(fontsDir)) {
        const rel = relative(distDir, file)
        if (!isServableFont(rel)) continue
        this.emitFile({
          type: 'asset',
          fileName: `excalidraw-assets/${rel.split(sep).join('/')}`,
          source: readFileSync(file)
        })
      }
    }
  }
}
