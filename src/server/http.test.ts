import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { Auth } from './auth'
import {
  createHttpHandler,
  sessionTokenFromCookie,
  negotiateEncoding,
  _resetStaticCacheForTest,
  SESSION_COOKIE
} from './http'
import { parseTrustedNets, PROXY_SECRET_HEADER } from './proxy-trust'
import { MAX_FAILURES } from './auth'

let dir: string, rendererDir: string, server: http.Server, base: string, auth: Auth

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-http-'))
  rendererDir = path.join(dir, 'renderer')
  fs.mkdirSync(rendererDir)
  fs.writeFileSync(
    path.join(rendererDir, 'index.html'),
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'" /><div id="root"></div>`
  )
  fs.writeFileSync(path.join(rendererDir, 'app.js'), 'console.log(1)')
  auth = new Auth(dir)
  server = http.createServer(createHttpHandler({ auth, rendererDir }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  await new Promise((r) => server.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
})

async function setupAndLogin(): Promise<string> {
  const tok = auth.setupToken()
  const res = await fetch(`${base}/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${tok}&password=hunter22-secret`,
    redirect: 'manual'
  })
  expect(res.status).toBe(303)
  const cookie = res.headers.get('set-cookie')!
  expect(cookie).toContain(`${SESSION_COOKIE}=`)
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Strict')
  return cookie.split(';')[0]
}

describe('http layer', () => {
  it('unauthenticated: html → /login redirect, api → 401; /login redirects to /setup when unconfigured', async () => {
    const r1 = await fetch(`${base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
    expect(r1.status).toBe(302)
    const r2 = await fetch(`${base}/anything.json`, { redirect: 'manual' })
    expect(r2.status).toBe(401)
    const r3 = await fetch(`${base}/login`, { redirect: 'manual' })
    expect(r3.status).toBe(302)
    expect(r3.headers.get('location')).toContain('/setup')
  })

  it('setup with the one-time token creates the password and a session; token single-use', async () => {
    const cookie = await setupAndLogin()
    const home = await fetch(`${base}/`, { headers: { cookie } })
    expect(home.status).toBe(200)
    const again = await fetch(`${base}/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=whatever&password=xxxxxxxxx`,
      redirect: 'manual'
    })
    expect(again.status).toBe(403)
  })

  it('login: wrong password → redirect with error; right → cookie; rate limit → 429', async () => {
    await setupAndLogin()
    for (let i = 0; i < 5; i++) {
      const bad = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=wrong',
        redirect: 'manual'
      })
      expect([303, 429]).toContain(bad.status)
    }
    const locked = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=hunter22-secret',
      redirect: 'manual'
    })
    expect(locked.status).toBe(429)
  })

  it('serves static with CSP rewrite on index.html and blocks traversal', async () => {
    const cookie = await setupAndLogin()
    const html = await (await fetch(`${base}/`, { headers: { cookie } })).text()
    // S6: same-origin only — a same-origin ws:/wss: URL is covered by 'self' (CSP3).
    expect(html).toContain(`connect-src 'self';`)
    expect(html).not.toContain('ws: wss:')
    const js = await fetch(`${base}/app.js`, { headers: { cookie } })
    expect(js.headers.get('content-type')).toContain('javascript')
    const evil = await fetch(`${base}/..%2f..%2fauth.json`, { headers: { cookie } })
    expect([400, 401, 404]).toContain(evil.status)
    expect(await evil.text()).not.toContain('salt')
  })

  it('warns (and still 200s) when index.html lacks the CSP rewrite marker', async () => {
    const cookie = await setupAndLogin()
    fs.writeFileSync(
      path.join(rendererDir, 'index.html'),
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'" /><div id="root"></div>`
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const res = await fetch(`${base}/`, { headers: { cookie } })
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).not.toContain('connect-src')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toContain('CSP')
      expect(warn.mock.calls[0][0]).toContain('WebSocket')
    } finally {
      warn.mockRestore()
    }
  })

  // The browser client is the whole point of the Server Edition and it is usually not on this
  // LAN, so how the bundle goes over the wire is a feature, not a detail: the entry chunk is
  // ~2.1 MB raw against ~0.46 MB gzipped, and a reload that revalidates costs a 304 instead of
  // the whole thing.
  describe('static delivery', () => {
    /** Raw request: `fetch` negotiates and transparently decodes, which is exactly what these
     *  assertions need to see. */
    function rawGet(
      pathname: string,
      headers: Record<string, string>
    ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
      return new Promise((resolve, reject) => {
        const req = http.get(`${base}${pathname}`, { headers }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
          )
        })
        req.on('error', reject)
      })
    }

    /** A hashed asset big enough to be worth compressing (see COMPRESS_MIN_BYTES). */
    function writeAsset(name: string, body: string): string {
      fs.mkdirSync(path.join(rendererDir, 'assets'), { recursive: true })
      fs.writeFileSync(path.join(rendererDir, 'assets', name), body)
      return body
    }

    afterEach(() => _resetStaticCacheForTest())

    it('negotiateEncoding prefers brotli, falls back to gzip, honours q=0', () => {
      expect(negotiateEncoding('gzip, deflate, br')).toBe('br')
      expect(negotiateEncoding('gzip, deflate')).toBe('gzip')
      expect(negotiateEncoding('br;q=0, gzip')).toBe('gzip')
      expect(negotiateEncoding('gzip;q=0')).toBeNull()
      expect(negotiateEncoding('identity')).toBeNull()
      expect(negotiateEncoding(undefined)).toBeNull()
    })

    it('compresses a large asset and serves the exact bytes back', async () => {
      const cookie = await setupAndLogin()
      const source = writeAsset('big-abc123.js', `export const x = "${'y'.repeat(4000)}"\n`)
      const gz = await rawGet('/assets/big-abc123.js', { cookie, 'accept-encoding': 'gzip' })
      expect(gz.headers['content-encoding']).toBe('gzip')
      expect(gz.headers['vary']).toBe('Accept-Encoding')
      expect(zlib.gunzipSync(gz.body).toString('utf8')).toBe(source)
      // Smaller on the wire is the entire point — assert it, so a future "simplification" that
      // quietly stops compressing fails here instead of only showing up as a slow load.
      expect(gz.body.length).toBeLessThan(source.length / 2)

      const br = await rawGet('/assets/big-abc123.js', { cookie, 'accept-encoding': 'br' })
      expect(br.headers['content-encoding']).toBe('br')
      expect(zlib.brotliDecompressSync(br.body).toString('utf8')).toBe(source)
    })

    it('serves identity when the client accepts no encoding, and never compresses tiny files', async () => {
      const cookie = await setupAndLogin()
      writeAsset('big-abc123.js', 'x'.repeat(4000))
      const identity = await rawGet('/assets/big-abc123.js', { cookie })
      expect(identity.headers['content-encoding']).toBeUndefined()
      expect(identity.body.length).toBe(4000)
      // app.js is 14 bytes: a compressed frame plus its headers would be bigger than the file.
      const tiny = await rawGet('/app.js', { cookie, 'accept-encoding': 'gzip, br' })
      expect(tiny.headers['content-encoding']).toBeUndefined()
      expect(tiny.body.toString('utf8')).toBe('console.log(1)')
    })

    it('revalidates by ETag (304) and marks hashed assets immutable', async () => {
      const cookie = await setupAndLogin()
      writeAsset('big-abc123.js', 'x'.repeat(4000))
      const first = await rawGet('/assets/big-abc123.js', { cookie, 'accept-encoding': 'gzip' })
      expect(first.status).toBe(200)
      expect(first.headers['cache-control']).toBe('private, max-age=31536000, immutable')
      const etag = first.headers['etag'] as string
      expect(etag).toBeTruthy()

      const again = await rawGet('/assets/big-abc123.js', {
        cookie,
        'accept-encoding': 'gzip',
        'if-none-match': etag
      })
      expect(again.status).toBe(304)
      expect(again.body.length).toBe(0)

      // index.html carries the app's entry point: it must revalidate, never be held for a year.
      const index = await rawGet('/', { cookie })
      expect(index.headers['cache-control']).toBe('private, no-cache')
      const indexAgain = await rawGet('/', {
        cookie,
        'if-none-match': index.headers['etag'] as string
      })
      expect(indexAgain.status).toBe(304)
    })

    it('keeps the index.html CSP rewrite through compression', async () => {
      const cookie = await setupAndLogin()
      // Pad past COMPRESS_MIN_BYTES so this actually exercises the compressed path — the rewrite
      // happens before compression, and a regression there would be invisible on a small file.
      fs.writeFileSync(
        path.join(rendererDir, 'index.html'),
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'" /><div id="root"></div><!--${'p'.repeat(4000)}-->`
      )
      const res = await rawGet('/', { cookie, 'accept-encoding': 'gzip' })
      expect(res.headers['content-encoding']).toBe('gzip')
      expect(zlib.gunzipSync(res.body).toString('utf8')).toContain(`connect-src 'self';`)
    })

    it('re-compresses after the file changes on disk (a rebuild must not serve stale bytes)', async () => {
      const cookie = await setupAndLogin()
      writeAsset('big-abc123.js', 'a'.repeat(4000))
      const before = await rawGet('/assets/big-abc123.js', { cookie, 'accept-encoding': 'gzip' })
      expect(zlib.gunzipSync(before.body).toString('utf8')).toBe('a'.repeat(4000))
      // A rebuild normally changes the hashed name too; same name + new bytes is the harder case.
      const later = new Date(Date.now() + 5000)
      const file = path.join(rendererDir, 'assets', 'big-abc123.js')
      fs.writeFileSync(file, 'b'.repeat(4000))
      fs.utimesSync(file, later, later)
      const after = await rawGet('/assets/big-abc123.js', { cookie, 'accept-encoding': 'gzip' })
      expect(zlib.gunzipSync(after.body).toString('utf8')).toBe('b'.repeat(4000))
      expect(after.headers['etag']).not.toBe(before.headers['etag'])
    })
  })

  it('sessionTokenFromCookie parses the session out of a multi-cookie header', () => {
    expect(sessionTokenFromCookie(`a=b; ${SESSION_COOKIE}=tok123; c=d`)).toBe('tok123')
    expect(sessionTokenFromCookie(undefined)).toBeUndefined()
  })
})

describe('http layer with proxy header trust', () => {
  const HDR = 'Cf-Access-Authenticated-User-Email'
  const SECRET = 'q'.repeat(48)
  const SEC = { [PROXY_SECRET_HEADER]: SECRET }

  function trustedServer(netsSpec: string, secret: string | undefined = SECRET): Promise<{ srv: http.Server; url: string }> {
    const srv = http.createServer(
      createHttpHandler({
        auth,
        rendererDir,
        trustProxy: { header: HDR, nets: parseTrustedNets(netsSpec), ...(secret ? { secret } : {}) }
      })
    )
    return new Promise((r) =>
      srv.listen(0, '127.0.0.1', () =>
        r({ srv, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` })
      )
    )
  }

  it('trusted peer + header + secret: serves the app with no cookie; /login and /setup redirect home', async () => {
    const { srv, url } = await trustedServer('127.0.0.0/8')
    try {
      const home = await fetch(`${url}/`, { headers: { ...SEC, [HDR]: 'dev@corp.com' } })
      expect(home.status).toBe(200)
      const login = await fetch(`${url}/login`, {
        headers: { ...SEC, [HDR]: 'dev@corp.com' },
        redirect: 'manual'
      })
      expect(login.status).toBe(302)
      expect(login.headers.get('location')).toBe('/')
      const setup = await fetch(`${url}/setup`, {
        headers: { ...SEC, [HDR]: 'dev@corp.com' },
        redirect: 'manual'
      })
      expect(setup.status).toBe(302)
      expect(setup.headers.get('location')).toBe('/')
    } finally {
      await new Promise((r) => srv.close(r))
    }
  })

  it('S2: from loopback, the header WITHOUT the secret is not an identity (any local process could send it)', async () => {
    const { srv, url } = await trustedServer('127.0.0.0/8')
    const { srv: srvNoSecret, url: urlNoSecret } = await trustedServer('127.0.0.0/8', undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // The audit's repro: no cookie, just the header from a local process → was 200.
      expect((await fetch(`${url}/x.json`, { headers: { [HDR]: 'anyone' }, redirect: 'manual' })).status).toBe(401)
      expect(
        (await fetch(`${url}/x.json`, { headers: { [HDR]: 'anyone', [PROXY_SECRET_HEADER]: 'guess' }, redirect: 'manual' }))
          .status
      ).toBe(401)
      // A config with loopback nets and no secret at all trusts no loopback peer.
      expect((await fetch(`${urlNoSecret}/x.json`, { headers: { [HDR]: 'anyone' }, redirect: 'manual' })).status).toBe(401)
      // The refusal is logged, without the value of any header.
      expect(warn.mock.calls.flat().join(' ')).not.toContain('anyone')
      expect(warn.mock.calls.flat().join(' ')).not.toContain('guess')
    } finally {
      warn.mockRestore()
      await new Promise((r) => srv.close(r))
      await new Promise((r) => srvNoSecret.close(r))
    }
  })

  it('missing/empty header, or a peer outside the nets, falls through to normal auth', async () => {
    const { srv, url } = await trustedServer('127.0.0.0/8')
    const { srv: srvFar, url: urlFar } = await trustedServer('10.0.0.0/8')
    try {
      expect((await fetch(`${url}/x.json`, { headers: SEC, redirect: 'manual' })).status).toBe(401)
      expect(
        (await fetch(`${url}/x.json`, { headers: { ...SEC, [HDR]: '  ' }, redirect: 'manual' })).status
      ).toBe(401)
      // Loopback peer, but the trusted nets exclude loopback → the header means nothing.
      expect(
        (await fetch(`${urlFar}/x.json`, { headers: { ...SEC, [HDR]: 'dev@corp.com' }, redirect: 'manual' }))
          .status
      ).toBe(401)
      // Password/cookie auth still works beside proxy trust.
      const cookie = await setupAndLogin()
      const viaCookie = await fetch(`${urlFar}/`, { headers: { cookie } })
      expect(viaCookie.status).toBe(200)
    } finally {
      await new Promise((r) => srv.close(r))
      await new Promise((r) => srvFar.close(r))
    }
  })
})
