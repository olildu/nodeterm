// Regression tests for the Server Edition auth findings of the 2026-10 security audit (S1, S3, S4,
// S5, S6). Each one ports a repro from the audit against the real handler on a loopback port.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Auth, MAX_FAILURES } from './auth'
import { createHttpHandler, SESSION_COOKIE, type HttpHandlerOpts } from './http'

const REAL = 'correct-horse-battery'
let dir: string, rendererDir: string, auth: Auth
let servers: http.Server[] = []

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-http-auth-'))
  rendererDir = path.join(dir, 'renderer')
  fs.mkdirSync(rendererDir)
  fs.writeFileSync(
    path.join(rendererDir, 'index.html'),
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'" /><div id="root"></div>`
  )
  auth = new Auth(dir)
  auth.setPassword(REAL)
  servers = []
})
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections()
    await new Promise((r) => s.close(r))
  }
  fs.rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function serve(extra: Partial<HttpHandlerOpts> = {}): Promise<number> {
  const srv = http.createServer(createHttpHandler({ auth, rendererDir, ...extra }))
  servers.push(srv)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return (srv.address() as { port: number }).port
}

interface Res {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

/** A raw request (fetch hides Set-Cookie attributes and refuses to set Host/Origin freely). With
 *  `bodyDelayMs`, the headers go out first and the body later — the S1 hold. */
function request(
  port: number,
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: string,
  bodyDelayMs = 0
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = { ...headers }
    if (body !== undefined) {
      h['content-type'] = 'application/x-www-form-urlencoded'
      h['content-length'] = String(Buffer.byteLength(body))
    }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      )
    })
    r.on('error', reject)
    if (bodyDelayMs > 0) {
      r.flushHeaders()
      setTimeout(() => r.end(body), bodyDelayMs)
    } else r.end(body)
  })
}

const login = (port: number, password: string, headers: Record<string, string> = {}, delay = 0): Promise<Res> =>
  request(port, 'POST', '/auth/login', headers, `password=${encodeURIComponent(password)}`, delay)

function cookieOf(res: Res): string {
  const raw = (res.headers['set-cookie'] ?? [])[0] ?? ''
  return raw.split(';')[0]
}

describe('S1: login lockout cannot be bypassed by holding request bodies', () => {
  it('60 concurrent guesses with held bodies: at most MAX_FAILURES are verified', async () => {
    const port = await serve()
    const N = 60
    const guesses = Array.from({ length: N }, (_, i) => (i === N - 1 ? REAL : `guess-${i}`))
    const results = await Promise.all(guesses.map((g) => login(port, g, {}, 200)))
    const verified = results.filter((r) => r.status === 303).length
    const refused = results.filter((r) => r.status === 429).length
    // Was: 60 verified, 0 refused — and the right password, last, got a session.
    expect(verified).toBeLessThanOrEqual(MAX_FAILURES)
    expect(refused).toBeGreaterThanOrEqual(N - MAX_FAILURES)
    expect(results[N - 1].status).toBe(429)
  }, 60_000)

  it('the slot is taken BEFORE the body is read: held bodies refuse the next attempt at once', async () => {
    const port = await serve()
    const c = { 'x-forwarded-for': '203.0.113.66' }
    // Five attempts whose bodies are still on their way...
    const held = Array.from({ length: MAX_FAILURES }, (_, i) => login(port, `held${i}`, c, 1500))
    await new Promise((r) => setTimeout(r, 300))
    // ...already hold this client's whole budget: a sixth, body and all, is refused right now.
    const sixth = await login(port, REAL, c)
    expect(sixth.status).toBe(429)
    expect((await Promise.all(held)).map((r) => r.status)).toEqual(Array(MAX_FAILURES).fill(303))
  }, 30_000)

  it('an attempt whose body never makes it releases its slot without charging a failure', async () => {
    const port = await serve()
    const huge = 'password=' + 'x'.repeat(20 * 1024) // over the 10 KB form cap → 400
    for (let i = 0; i < MAX_FAILURES + 2; i++) {
      // The server destroys an oversized body's socket, so the client sees a 400 or a hang-up.
      const status = await request(port, 'POST', '/auth/login', {}, huge).then((r) => r.status, () => 400)
      expect(status).toBe(400)
    }
    expect((await login(port, REAL)).status).toBe(303)
  })

  it('a refusal says when to come back (Retry-After), and a browser gets a page, not JSON', async () => {
    const port = await serve()
    for (let i = 0; i < MAX_FAILURES; i++) await login(port, `bad${i}`)
    const json = await login(port, REAL)
    expect(json.status).toBe(429)
    expect(Number(json.headers['retry-after'])).toBeGreaterThan(0)
    expect(JSON.parse(json.body)).toEqual({ error: 'too_many_attempts' })
    const page = await login(port, REAL, { accept: 'text/html' })
    expect(page.status).toBe(429)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.body).toMatch(/Too many attempts/)
  })
})

describe('S4: a stranger cannot lock the owner out', () => {
  it('five bad passwords from one client do not refuse another client', async () => {
    const port = await serve()
    // Behind a same-host proxy every request comes from loopback; the proxy names the client.
    for (let i = 0; i < MAX_FAILURES; i++) await login(port, `bad${i}`, { 'x-forwarded-for': '203.0.113.66' })
    expect((await login(port, REAL, { 'x-forwarded-for': '203.0.113.66' })).status).toBe(429)
    const owner = await login(port, REAL, { 'x-forwarded-for': '198.51.100.7' })
    expect(owner.status).toBe(303)
    expect(cookieOf(owner)).toContain(`${SESSION_COOKIE}=`)
  })

  it('auth POSTs refuse a cross-site Origin (a page the owner visits cannot post the login form)', async () => {
    const port = await serve({ publicOrigin: 'https://term.example.com' })
    const host = `127.0.0.1:${port}`
    for (const route of ['/auth/login', '/auth/logout', '/auth/logout-all', '/auth/setup']) {
      expect((await request(port, 'POST', route, { origin: 'https://evil.example' }, 'password=x')).status).toBe(403)
      expect((await request(port, 'POST', route, { origin: 'null' }, 'password=x')).status).toBe(403)
      // No Origin, but the browser says the request is cross-site.
      expect((await request(port, 'POST', route, { 'sec-fetch-site': 'cross-site' }, 'password=x')).status).toBe(403)
    }
    // Same origin by Host, or the configured public origin (a proxy that rewrites Host), passes.
    expect((await login(port, REAL, { origin: `http://${host}` })).status).toBe(303)
    expect((await login(port, REAL, { origin: 'https://term.example.com', host: 'internal:8443' })).status).toBe(303)
    // A non-browser client (no Origin, no fetch metadata) still signs in.
    expect((await login(port, REAL)).status).toBe(303)
    // A refused cross-site post is not charged to the lockout.
    for (let i = 0; i < MAX_FAILURES + 3; i++) {
      await request(port, 'POST', '/auth/login', { origin: 'https://evil.example' }, 'password=x')
    }
    expect((await login(port, REAL)).status).toBe(303)
  })
})

describe('S3: signing out ends the session on the server', () => {
  it('/auth/logout deletes the presented token: the same cookie no longer works', async () => {
    const port = await serve()
    const cookie = cookieOf(await login(port, REAL))
    expect((await request(port, 'GET', '/', { cookie, accept: 'application/json' })).status).toBe(200)
    const out = await request(port, 'POST', '/auth/logout', { cookie })
    expect(out.status).toBe(303)
    expect(out.headers['set-cookie']?.[0]).toContain('Max-Age=0')
    // Was 200: the token lived on in sessions.json for its whole 30-day TTL.
    expect((await request(port, 'GET', '/', { cookie, accept: 'application/json' })).status).toBe(401)
  })

  it('/auth/logout-all signs out every browser, and needs a signed-in caller', async () => {
    const port = await serve()
    const a = cookieOf(await login(port, REAL))
    const b = cookieOf(await login(port, REAL))
    // Unauthenticated callers cannot sign everyone out.
    expect((await request(port, 'POST', '/auth/logout-all', { accept: 'application/json' })).status).toBe(401)
    expect((await request(port, 'GET', '/', { cookie: b, accept: 'application/json' })).status).toBe(200)
    const out = await request(port, 'POST', '/auth/logout-all', { cookie: a })
    expect(out.status).toBe(303)
    expect(out.headers.location).toBe('/login')
    for (const c of [a, b]) {
      expect((await request(port, 'GET', '/', { cookie: c, accept: 'application/json' })).status).toBe(401)
    }
  })
})

describe('S5: Secure and HSTS', () => {
  it('without NODETERM_PUBLIC_ORIGIN: Secure follows X-Forwarded-Proto, no HSTS (unchanged)', async () => {
    const port = await serve()
    const plain = await login(port, REAL)
    expect(plain.headers['set-cookie']?.[0]).not.toContain('Secure')
    expect(plain.headers['strict-transport-security']).toBeUndefined()
    const viaProxy = await login(port, REAL, { 'x-forwarded-proto': 'https' })
    expect(viaProxy.headers['set-cookie']?.[0]).toContain('Secure')
  })

  it('with NODETERM_PUBLIC_ORIGIN: every cookie is Secure and every response sends HSTS', async () => {
    const port = await serve({ publicOrigin: 'https://term.example.com' })
    const res = await login(port, REAL)
    expect(res.headers['set-cookie']?.[0]).toContain('Secure')
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000')
    const cookie = cookieOf(res)
    const out = await request(port, 'POST', '/auth/logout', { cookie })
    expect(out.headers['set-cookie']?.[0]).toContain('Secure')
    for (const r of [
      await request(port, 'GET', '/login'),
      await request(port, 'GET', '/x.json'),
      await request(port, 'GET', '/', { cookie: cookieOf(await login(port, REAL)) })
    ]) {
      expect(r.headers['strict-transport-security']).toBe('max-age=31536000')
    }
  })

  it('warns once when a non-loopback Host arrives without NODETERM_PUBLIC_ORIGIN', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const port = await serve()
    await request(port, 'GET', '/login', { host: 'localhost:8443' })
    await request(port, 'GET', '/login', { host: '127.0.0.1:8443' })
    await request(port, 'GET', '/login', { host: '[::1]:8443' })
    expect(warn).not.toHaveBeenCalled()
    await request(port, 'GET', '/login', { host: 'attacker-chosen.invalid' })
    await request(port, 'GET', '/login', { host: 'attacker-chosen.invalid' })
    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0][0])
    expect(line).toMatch(/NODETERM_PUBLIC_ORIGIN/)
    // The Host header is the client's to write: none of it reaches the log (log injection).
    expect(line).not.toContain('attacker-chosen')
    // Configured: never warns.
    warn.mockClear()
    const port2 = await serve({ publicOrigin: 'https://term.example.com' })
    await request(port2, 'GET', '/login', { host: 'term.example.com' })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('S6: no framing, anywhere', () => {
  it('every response says DENY / frame-ancestors none — app, login, setup, errors', async () => {
    const port = await serve()
    const cookie = cookieOf(await login(port, REAL))
    const responses = [
      await request(port, 'GET', '/', { cookie }),
      await request(port, 'GET', '/login'),
      await request(port, 'GET', '/setup'),
      await request(port, 'GET', '/x.json'),
      await request(port, 'POST', '/auth/login', {}, 'password=nope')
    ]
    for (const r of responses) {
      expect(r.headers['x-frame-options']).toBe('DENY')
      expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'")
      expect(r.headers['x-content-type-options']).toBe('nosniff')
    }
    // The login page keeps its own strict policy, with frame-ancestors added — one header.
    const page = responses[1]
    expect(page.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"
    )
  })
})
