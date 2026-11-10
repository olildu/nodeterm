// GET /download?t=<ticket> — the Server Edition's file-download route.
//
// The browser cannot reach the machine's filesystem, so "download this file from the Explorer"
// has to become a real HTTP transfer: it streams (no FS_READ_BINARY_MAX_BYTES ceiling, no base64
// inflation), the browser renders its own progress and lands the file in the user's Downloads
// folder, and none of it occupies the WS bridge that terminals are multiplexed over.
//
// The request carries a one-shot ticket, never a path (see core/download-tickets.ts): the ticket
// was minted over the authenticated RPC channel, so this route resolves a path from the server's
// OWN state and has no caller-supplied path to jail. It still sits BEHIND the session gate in
// http.ts — a ticket is a second factor, not a replacement for the session.
import type http from 'http'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import type { DownloadTickets } from '../core/download-tickets'

export const DOWNLOAD_PATH = '/download'

/**
 * `Content-Disposition` for an attachment named `name`. Both forms are emitted: `filename*` is
 * what every current browser reads (UTF-8, so "belgeler.txt" survives), and the quoted ASCII
 * `filename` is the fallback. The fallback is stripped of quotes, backslashes and control
 * characters — a filename is attacker-influenced input in the sense that it comes from a
 * filesystem, and an unescaped `"` there would let it forge further header parameters.
 */
export function contentDisposition(name: string): string {
  // eslint-disable-next-line no-control-regex
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download'
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** The name a download lands under: a directory arrives as a gzipped tarball. */
export function downloadName(p: string, dir: boolean): string {
  const base = path.basename(p) || 'download'
  return dir ? `${base}.tar.gz` : base
}

/**
 * Serve one download. Returns false when the request is not a download request at all (so the
 * caller falls through to the next route). Any failure AFTER the response has started can only be
 * a destroyed socket — a truncated file the browser reports as failed, which is the honest
 * outcome; we never end a broken transfer with a clean 200 body.
 */
export async function handleDownload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  tickets: DownloadTickets
): Promise<boolean> {
  if (url.pathname !== DOWNLOAD_PATH) return false
  if ((req.method || 'GET') !== 'GET') {
    res.writeHead(405, { Allow: 'GET' })
    res.end()
    return true
  }
  const entry = tickets.redeem(url.searchParams.get('t') || '')
  // Unknown, spent and expired tickets are one 404: which of the three it was is not the
  // caller's business, and a distinct 403 would confirm that a path exists.
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Download link expired. Try again from the Explorer.')
    return true
  }

  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(entry.path)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('File not found.')
    return true
  }

  if (stat.isDirectory()) {
    streamTarball(res, entry.path)
    return true
  }

  const name = downloadName(entry.path, false)
  const stream = fs.createReadStream(entry.path)
  let opened = false
  stream.on('error', () => {
    if (!opened && !res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Could not read the file.')
    } else {
      res.destroy()
    }
  })
  stream.on('open', () => {
    opened = true
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Content-Disposition': contentDisposition(name),
      'Cache-Control': 'no-store'
    })
    stream.pipe(res)
  })
  // A user who cancels mid-download (or closes the tab) leaves us piping into a dead socket.
  res.on('close', () => stream.destroy())
  return true
}

/** Stream a directory as `tar.gz`. No Content-Length — the archive is produced as it is sent. */
function streamTarball(res: http.ServerResponse, dirPath: string): void {
  const parent = path.dirname(dirPath)
  const base = path.basename(dirPath)
  // `--` before the name (security audit 2026-10, S7): a folder called `--transform=…` or
  // `--checkpoint-action=…` — committed in a cloned repository, say — was parsed by tar as an option.
  const child = spawn('tar', ['-czf', '-', '-C', parent, '--', base], { stdio: ['ignore', 'pipe', 'ignore'] })
  let started = false
  const fail = (): void => {
    if (started || res.headersSent) res.destroy()
    else {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Could not archive the folder.')
    }
  }
  child.on('error', fail)
  // Headers go out on the FIRST byte, not on spawn: a `tar` that is missing or refuses the path
  // fails before producing output, and that has to surface as a 500 rather than as a 200 with an
  // empty (corrupt) archive body.
  child.stdout.on('data', (chunk: Buffer) => {
    if (!started) {
      started = true
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': contentDisposition(downloadName(dirPath, true)),
        'Cache-Control': 'no-store'
      })
    }
    if (!res.write(chunk)) {
      child.stdout.pause()
      res.once('drain', () => child.stdout.resume())
    }
  })
  child.on('close', (code) => {
    if (code === 0 && started) res.end()
    else if (code === 0) {
      // An empty archive is still a valid one (an empty folder).
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': contentDisposition(downloadName(dirPath, true)),
        'Cache-Control': 'no-store'
      })
      res.end()
    } else fail()
  })
  res.on('close', () => child.kill())
}
