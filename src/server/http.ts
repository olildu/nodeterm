// Plain node:http request handler for the server edition.
// Deliberately NOT Fastify: the handler surface is tiny (a handful of auth
// routes + static renderer serving), it must be embeddable in an existing
// http.Server the WS upgrade also attaches to (Task 5), and avoiding a
// framework keeps the dependency/attack surface minimal. See task-4-brief.md.
import http from 'http'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { passwordTooShort, type Auth } from './auth'
import { noteProxyRefusal, proxyAuthDecision, type TrustProxyConfig } from './proxy-trust'
import { loginClientKey } from './client-address'
import { sameOriginRequest } from './origin'
import { handleDownload } from './download'
import type { DownloadTickets } from '../core/download-tickets'

export const SESSION_COOKIE = 'nt_session'

const MAX_BODY_BYTES = 10 * 1024 // 10KB POST body cap
/** A form body that has not arrived by now is abandoned. Login attempts hold a rate-limit slot
 *  while their body is read (S1), so a client that never sends one must not hold it for long. */
export const FORM_BODY_TIMEOUT_MS = 10_000

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

// CSP served with the inline login/setup pages (no app assets, no connections).
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"

/** Sent on EVERY response (S6). The app's own CSP is a `<meta>`, where `frame-ancestors` is
 *  ignored, so framing has to be refused by HTTP header; a second CSP header only adds a
 *  restriction (browsers enforce each policy). The login/setup pages send PAGE_CSP instead,
 *  which carries the same directive. */
const FRAME_CSP = "frame-ancestors 'none'"
/** HSTS when NODETERM_PUBLIC_ORIGIN says the server is reached over https (S5). */
const HSTS = 'max-age=31536000'

/** Types worth compressing. Everything else (png, woff2) is already compressed — running it
 *  through gzip only burns CPU and usually grows the payload. */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.map', '.json', '.svg'])
/** Below this, a compressed frame plus its headers is not worth the round of CPU. */
const COMPRESS_MIN_BYTES = 1024
/** Total bytes of compressed payloads held in memory. The renderer dir is ~100 files whose gzip
 *  total is a couple of MB, so this is headroom, not a working limit — when it is exceeded the
 *  whole cache is dropped (simplest correct eviction for a set this small). */
const COMPRESS_CACHE_MAX_BYTES = 32 * 1024 * 1024

export interface HttpHandlerOpts {
  auth: Auth
  rendererDir: string
  /**
   * Reverse-proxy SSO trust (issue #29): when set, a request whose TCP peer is inside the
   * trusted nets and which carries the header (non-empty) is authenticated without a
   * session cookie. Never *blocks* anything — a request that doesn't qualify simply falls
   * through to the normal cookie/login path.
   */
  trustProxy?: TrustProxyConfig
  /** Ticket store backing `GET /download` (Explorer file downloads). Omitted in tests that don't
   *  exercise it — the route then simply doesn't exist. */
  downloadTickets?: DownloadTickets
  /**
   * NODETERM_PUBLIC_ORIGIN (an https origin, normalized). When set the session cookie is always
   * `Secure`, every response carries HSTS, and an `Origin` equal to it passes the same-origin check
   * even when the proxy rewrites `Host`. See config.ts.
   */
  publicOrigin?: string
}

/** Parse the `nt_session=` value out of a Cookie header. Exported for the WS upgrade (Task 5). */
export function sessionTokenFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === SESSION_COOKIE) return part.slice(eq + 1).trim()
  }
  return undefined
}

function isHtmlNavigation(req: http.IncomingMessage): boolean {
  const accept = req.headers['accept']
  return typeof accept === 'string' && accept.includes('text/html')
}

/**
 * `Secure` is ALWAYS set when the operator declared an https public origin. Without one it follows
 * `X-Forwarded-Proto` as before (S5): a client can only use that header against itself, but a
 * proxy that does not send it silently loses `Secure` — hence the boot/first-request warning.
 */
function cookieAttributes(req: http.IncomingMessage, publicOrigin: string | undefined): string {
  let attrs = `HttpOnly; SameSite=Strict; Path=/`
  if (publicOrigin !== undefined || req.headers['x-forwarded-proto'] === 'https') attrs += '; Secure'
  return attrs
}

function setSessionCookie(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  publicOrigin: string | undefined
): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieAttributes(req, publicOrigin)}`)
}

function clearSessionCookie(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  publicOrigin: string | undefined
): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; ${cookieAttributes(req, publicOrigin)}`)
}

/** Is this `Host` header one of this machine's loopback names (no warning needed for it)? */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true
  let name = host.toLowerCase()
  if (name.startsWith('[')) name = name.slice(1, name.indexOf(']') === -1 ? undefined : name.indexOf(']'))
  else if (name.lastIndexOf(':') !== -1 && name.indexOf(':') === name.lastIndexOf(':')) name = name.slice(0, name.lastIndexOf(':'))
  return name === 'localhost' || name.endsWith('.localhost') || name === '::1' || /^127(\.\d{1,3}){3}$/.test(name)
}


function redirect(res: http.ServerResponse, status: number, location: string): void {
  res.writeHead(status, { Location: location })
  res.end()
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(s)
}

function sendPage(res: http.ServerResponse, status: number, html: string, extra: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, {
    ...extra,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': PAGE_CSP,
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(html)
}

/** Read a form-encoded POST body (capped, and abandoned after FORM_BODY_TIMEOUT_MS) and decode
 *  into URLSearchParams. */
function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    const abort = (err: Error): void => {
      if (aborted) return
      aborted = true
      clearTimeout(timer)
      reject(err)
      req.destroy()
    }
    const timer = setTimeout(() => abort(new Error('body timeout')), FORM_BODY_TIMEOUT_MS)
    if (timer.unref) timer.unref()
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        abort(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      clearTimeout(timer)
      resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('error', (err) => {
      if (aborted) return
      aborted = true
      clearTimeout(timer)
      reject(err)
    })
    // A client that hangs up before the body is complete fires neither 'end' nor 'error'.
    req.on('close', () => {
      if (!aborted && !req.complete) abort(new Error('client closed'))
    })
  })
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const PAGE_STYLE =
  "margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d10;color:#e6e6e6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
const CARD_STYLE =
  'background:#16191d;border:1px solid #26292e;border-radius:12px;padding:32px;width:320px;box-shadow:0 10px 40px rgba(0,0,0,0.4)'
const INPUT_STYLE =
  'width:100%;box-sizing:border-box;margin:8px 0;padding:10px 12px;border-radius:8px;border:1px solid #33373d;background:#0b0d10;color:#e6e6e6;font-size:14px'
const BUTTON_STYLE =
  'width:100%;box-sizing:border-box;margin-top:12px;padding:10px 12px;border-radius:8px;border:none;background:#2f6feb;color:#fff;font-size:14px;font-weight:600;cursor:pointer'
const H1_STYLE = 'margin:0 0 4px;font-size:18px;font-weight:600'
const SUB_STYLE = 'margin:0 0 16px;font-size:13px;color:#9aa0a6'
const ERR_STYLE = 'margin:0 0 12px;font-size:13px;color:#f26d6d'

function loginPage(error: 'wrong' | { retryAfterMs: number } | null): string {
  const errLine =
    error === 'wrong'
      ? `<p style="${ERR_STYLE}">Wrong password. Try again.</p>`
      : error !== null
        ? `<p style="${ERR_STYLE}">Too many attempts. Try again in ${Math.max(1, Math.ceil(error.retryAfterMs / 60_000))} minute${Math.ceil(error.retryAfterMs / 60_000) > 1 ? 's' : ''}.</p>`
        : ''
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in — nodeterm</title></head><body style="${PAGE_STYLE}"><form method="post" action="/auth/login" style="${CARD_STYLE}"><h1 style="${H1_STYLE}">nodeterm</h1><p style="${SUB_STYLE}">Sign in to continue</p>${errLine}<input style="${INPUT_STYLE}" type="password" name="password" placeholder="Password" autofocus autocomplete="current-password"><button style="${BUTTON_STYLE}" type="submit">Sign in</button></form></body></html>`
}

function setupNeedsTokenPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set up — nodeterm</title></head><body style="${PAGE_STYLE}"><div style="${CARD_STYLE}"><h1 style="${H1_STYLE}">Set up nodeterm</h1><p style="${SUB_STYLE}">Open the setup link printed in the server console — it carries a one-time token. This page can't be used without it.</p></div></body></html>`
}

function setupPage(token: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set up — nodeterm</title></head><body style="${PAGE_STYLE}"><form method="post" action="/auth/setup" style="${CARD_STYLE}"><h1 style="${H1_STYLE}">Welcome to nodeterm</h1><p style="${SUB_STYLE}">Choose a password to secure this server.</p><input type="hidden" name="token" value="${esc(token)}"><input style="${INPUT_STYLE}" type="password" name="password" placeholder="New password (min 8 chars)" autofocus autocomplete="new-password" minlength="8"><button style="${BUTTON_STYLE}" type="submit">Create password</button></form></body></html>`
}

/**
 * Resolve a URL path against the renderer root with traversal protection.
 * Returns the absolute file path, or null if it escapes the root.
 */
function resolveStaticPath(rendererDir: string, urlPath: string): string | null {
  // Decode percent-encoding so %2e%2e / %2f can't smuggle a traversal past the check.
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  // Normalize backslashes to forward slashes so Windows-style separators can't escape.
  decoded = decoded.replace(/\\/g, '/')
  if (decoded === '/' || decoded === '') decoded = '/index.html'
  // Strip the leading slash, then normalize. path.normalize collapses ../ segments.
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  const root = path.resolve(rendererDir)
  const candidate = path.resolve(root, '.' + (normalized.startsWith('/') ? normalized : '/' + normalized))
  // Containment check: the resolved path must be the root or sit under root + separator.
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null
  return candidate
}

/**
 * Pick a content encoding the client accepts. Brotli first (roughly 15% smaller than gzip on
 * our bundles), gzip as the universal fallback. A `;q=0` on a token is a refusal, so it is
 * honoured — everything else about the q-value ordering is ignored deliberately: we have two
 * candidates and a fixed preference between them.
 */
export function negotiateEncoding(header: string | undefined): 'br' | 'gzip' | null {
  if (!header) return null
  const accepted = new Set<string>()
  for (const part of header.split(',')) {
    const [tokenRaw, ...params] = part.split(';')
    const token = tokenRaw.trim().toLowerCase()
    if (!token) continue
    const refused = params.some((p) => /^\s*q\s*=\s*0(\.0+)?\s*$/i.test(p))
    if (!refused) accepted.add(token)
  }
  if (accepted.has('br')) return 'br'
  if (accepted.has('gzip')) return 'gzip'
  return null
}

/** `<encoding> <path>` → the compressed body for one exact file revision (`sig`). The promise is
 *  cached, not just its result, so N concurrent first-hits compress once. */
const compressCache = new Map<string, { sig: string; body: Promise<Buffer | null> }>()
let compressCacheBytes = 0

function compress(buf: Buffer, enc: 'br' | 'gzip'): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const done = (err: Error | null, out: Buffer): void => resolve(err ? null : out)
    if (enc === 'br') {
      zlib.brotliCompress(
        buf,
        // Quality 5 is the knee of the curve for JS/CSS: within a few percent of the default 11
        // at a small fraction of its CPU — and the answer is cached, so this runs once per build.
        { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } },
        done
      )
    } else {
      zlib.gzip(buf, { level: 6 }, done)
    }
  })
}

/** The compressed body for a file revision, or null when compression failed (→ serve identity). */
function compressedBody(
  key: string,
  sig: string,
  enc: 'br' | 'gzip',
  identity: () => Promise<Buffer>
): Promise<Buffer | null> {
  const hit = compressCache.get(key)
  if (hit && hit.sig === sig) return hit.body
  const body = identity()
    .then((buf) => compress(buf, enc))
    .then((out) => {
      if (!out) {
        compressCache.delete(key)
        return null
      }
      compressCacheBytes += out.length
      if (compressCacheBytes > COMPRESS_CACHE_MAX_BYTES) {
        compressCache.clear()
        compressCacheBytes = 0
      }
      return out
    })
    .catch(() => {
      compressCache.delete(key)
      return null
    })
  compressCache.set(key, { sig, body })
  return body
}

/** Test seam: drop the compressed-payload cache. */
export function _resetStaticCacheForTest(): void {
  compressCache.clear()
  compressCacheBytes = 0
}

/**
 * Serve one built renderer file.
 *
 * Three things beyond reading the bytes, all of which matter because the browser client is the
 * whole point of the Server Edition and it is usually NOT on the same LAN:
 *  - **Compression.** The entry bundle is ~2.1 MB raw / ~0.46 MB gzipped, and the lazy Monaco
 *    chunk 6.2 MB / 1.1 MB. Compressed payloads are cached per file revision, so the CPU is paid
 *    once per build, not per request.
 *  - **Caching.** Vite content-hashes everything under /assets, so those can be `immutable`;
 *    index.html revalidates by ETag (a 304 costs one small round trip instead of the bundle).
 *    `private` rather than `public`: the app sits behind auth and a shared proxy has no business
 *    holding it.
 *  - **Async reads.** This handler shares its event loop with every terminal's WS frames, so a
 *    `readFileSync` of a multi-MB chunk stalls output for every attached session.
 */
async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rendererDir: string,
  urlPath: string
): Promise<void> {
  const filePath = resolveStaticPath(rendererDir, urlPath)
  if (!filePath) {
    sendJson(res, 400, { error: 'bad_path' })
    return
  }
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(filePath)
  } catch {
    sendJson(res, 404, { error: 'not_found' })
    return
  }
  if (stat.isDirectory()) {
    sendJson(res, 404, { error: 'not_found' })
    return
  }
  const ext = path.extname(filePath).toLowerCase()
  const isIndex = path.basename(filePath) === 'index.html'
  const sig = `${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}`
  // Weak: index.html's body is rewritten below, so the tag describes the response, not the file.
  const etag = `W/"${sig}"`
  const headers: http.OutgoingHttpHeaders = {
    'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
    ETag: etag,
    Vary: 'Accept-Encoding',
    'Cache-Control': urlPath.startsWith('/assets/')
      ? 'private, max-age=31536000, immutable'
      : 'private, no-cache'
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }

  const identity = async (): Promise<Buffer> => {
    const raw = await fs.promises.readFile(filePath)
    // CSP rewrite ONLY on index.html: give the WS client a connect-src. `'self'` covers a
    // same-origin ws:/wss: URL (CSP3 matches ws↔http and wss↔https for 'self'), which is the only
    // socket the bridge opens — `ws: wss:` allowed a socket to ANY host (S6).
    if (!isIndex) return raw
    const html = raw.toString('utf8')
    const marker = "default-src 'self';"
    if (!html.includes(marker)) {
      // A silent no-op here would leave the desktop CSP intact and the browser
      // would block the ws:/wss: WebSocket with no visible error — make sure an
      // operator sees this in the server logs.
      console.warn(
        "[nodeterm-server] index.html CSP did not contain the expected `default-src 'self';` marker — the connect-src rewrite did not apply; the browser will block the WebSocket. Rebuild the renderer or update the rewrite."
      )
      return raw
    }
    return Buffer.from(html.replace(marker, "default-src 'self'; connect-src 'self';"))
  }

  const enc =
    COMPRESSIBLE.has(ext) && stat.size >= COMPRESS_MIN_BYTES
      ? negotiateEncoding(req.headers['accept-encoding'] as string | undefined)
      : null
  if (enc) {
    const packed = await compressedBody(`${enc} ${filePath}`, sig, enc, identity)
    if (packed) {
      res.writeHead(200, { ...headers, 'Content-Encoding': enc, 'Content-Length': packed.length })
      res.end(packed)
      return
    }
    // Compression failed (OOM, corrupt read): fall through and serve the bytes as they are.
  }
  let body: Buffer
  try {
    body = await identity()
  } catch {
    sendJson(res, 404, { error: 'not_found' })
    return
  }
  res.writeHead(200, { ...headers, 'Content-Length': body.length })
  res.end(body)
}

export function createHttpHandler(
  opts: HttpHandlerOpts
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const { auth, rendererDir, trustProxy, downloadTickets, publicOrigin } = opts
  let warnedNoPublicOrigin = false

  return function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
      else res.end()
    })
  }

  /** A refused login: 429 with Retry-After — a page for a browser, JSON otherwise. */
  function sendTooMany(req: http.IncomingMessage, res: http.ServerResponse, retryAfterMs: number): void {
    const retryAfter = String(Math.max(1, Math.ceil(retryAfterMs / 1000)))
    if (isHtmlNavigation(req)) {
      sendPage(res, 429, loginPage({ retryAfterMs }), { 'Retry-After': retryAfter })
      return
    }
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': retryAfter })
    res.end(JSON.stringify({ error: 'too_many_attempts' }))
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://x')
    const pathname = url.pathname
    const method = req.method || 'GET'

    // Every response, before any route can answer (S6, S5).
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', FRAME_CSP)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (publicOrigin !== undefined) res.setHeader('Strict-Transport-Security', HSTS)
    else if (!warnedNoPublicOrigin && !isLoopbackHost(req.headers['host'])) {
      warnedNoPublicOrigin = true
      // A fixed sentence: the Host header is the client's to write, so none of it reaches the log.
      console.warn(
        `[nodeterm-server] requests are arriving for a non-loopback host name but NODETERM_PUBLIC_ORIGIN is not set: the session cookie is marked Secure only when your proxy sends X-Forwarded-Proto: https, and no HSTS header is sent. Set NODETERM_PUBLIC_ORIGIN to the https address you open in the browser (for example https://term.example.com). See docs/SERVER.md.`
      )
    }

    const decision =
      trustProxy !== undefined ? proxyAuthDecision(trustProxy, req.headers, req.socket.remoteAddress) : 'none'
    noteProxyRefusal(decision)
    const proxyAuthed = decision === 'trusted'

    // A proxy-authed caller has no use for the password pages — send them home.
    if (proxyAuthed && method === 'GET' && (pathname === '/login' || pathname === '/setup')) {
      redirect(res, 302, '/')
      return
    }

    // Every auth POST changes who is signed in, so a cross-site page must not be able to send one
    // (login CSRF, forced logout, and — before S4 — locking the owner out from a page they visit).
    // Refused BEFORE any rate-limit slot is taken, so a refused post costs the lockout nothing.
    if (method === 'POST' && pathname.startsWith('/auth/') && !sameOriginRequest(req.headers, publicOrigin)) {
      sendJson(res, 403, { error: 'cross_origin' })
      return
    }

    // ---- Public auth routes (no session required) --------------------------

    if (pathname === '/setup' && method === 'GET') {
      if (auth.isConfigured()) {
        sendPage(res, 403, '<!doctype html><title>403</title><p style="color:#fff">Already configured.</p>')
        return
      }
      // The setup token is printed to the SERVER CONSOLE and must be presented as `?token=`.
      // Never serve the live token to a caller that hasn't already got it (otherwise anyone who
      // can reach /setup before a password is set could harvest it → POST /auth/setup → takeover).
      const provided = url.searchParams.get('token') || ''
      if (!auth.verifySetupToken(provided)) {
        sendPage(res, 403, setupNeedsTokenPage())
        return
      }
      sendPage(res, 200, setupPage(provided))
      return
    }

    if (pathname === '/login' && method === 'GET') {
      if (!auth.isConfigured()) {
        redirect(res, 302, '/setup')
        return
      }
      sendPage(res, 200, loginPage(url.searchParams.has('error') ? 'wrong' : null))
      return
    }

    if (pathname === '/auth/setup' && method === 'POST') {
      // Gate on !isConfigured FIRST: setupToken() regenerates a fresh token once
      // consumed, so we must never touch consumeSetupToken when already configured.
      if (auth.isConfigured()) {
        sendJson(res, 403, { error: 'already_configured' })
        return
      }
      let form: URLSearchParams
      try {
        form = await readForm(req)
      } catch {
        sendJson(res, 400, { error: 'bad_request' })
        return
      }
      const token = form.get('token') || ''
      const password = form.get('password') || ''
      if (passwordTooShort(password) || !auth.consumeSetupToken(token)) {
        sendJson(res, 403, { error: 'invalid_setup' })
        return
      }
      auth.setPassword(password)
      const session = auth.createSession()
      setSessionCookie(req, res, session, publicOrigin)
      redirect(res, 303, '/')
      return
    }

    if (pathname === '/auth/login' && method === 'POST') {
      // Reserve the attempt BEFORE reading the body (S1): the old check-then-read-then-charge let
      // every request whose body was held back pass the gate while the counter was still zero.
      const gate = auth.beginLoginAttempt(
        loginClientKey(req.socket.remoteAddress, req.headers['x-forwarded-for'], trustProxy)
      )
      if (!gate.ok) {
        sendTooMany(req, res, gate.retryAfterMs)
        return
      }
      let form: URLSearchParams
      try {
        form = await readForm(req)
      } catch {
        gate.finish('abandoned')
        sendJson(res, 400, { error: 'bad_request' })
        return
      }
      const password = form.get('password') || ''
      let ok: boolean
      try {
        ok = await auth.verifyPasswordAsync(password)
      } catch (err) {
        gate.finish('abandoned')
        throw err
      }
      if (ok) {
        gate.finish('success')
        const session = auth.createSession()
        setSessionCookie(req, res, session, publicOrigin)
        redirect(res, 303, '/')
        return
      }
      gate.finish('failure')
      redirect(res, 303, '/login?error=1')
      return
    }

    if (pathname === '/auth/logout' && method === 'POST') {
      // Sign out THIS browser: the token it presented is deleted on the server (S3), so a copy of
      // the cookie stops working too — clearing the cookie alone left it valid for 30 days.
      const presented = sessionTokenFromCookie(req.headers['cookie'])
      if (presented) auth.revokeSession(presented)
      clearSessionCookie(req, res, publicOrigin)
      redirect(res, 303, '/login')
      return
    }

    const token = sessionTokenFromCookie(req.headers['cookie'])

    if (pathname === '/auth/logout-all' && method === 'POST') {
      // Sign out EVERY browser (S3). Only a signed-in caller may, or anyone could log the owner out.
      if (!proxyAuthed && !auth.validateSession(token)) {
        if (isHtmlNavigation(req)) redirect(res, 303, '/login')
        else sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      auth.revokeAll()
      clearSessionCookie(req, res, publicOrigin)
      redirect(res, 303, '/login')
      return
    }

    // ---- Everything else requires a valid session --------------------------

    if (!proxyAuthed && !auth.validateSession(token)) {
      if (isHtmlNavigation(req)) redirect(res, 302, '/login')
      else sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    // Authenticated: an Explorer download redeems its one-shot ticket here (see download.ts).
    if (downloadTickets && (await handleDownload(req, res, url, downloadTickets))) return

    // Authenticated: serve static renderer files (index.html fallback for '/').
    await serveStatic(req, res, rendererDir, pathname)
  }
}
