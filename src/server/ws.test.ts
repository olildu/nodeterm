import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'
import { Auth } from './auth'
import { ServerPlatform } from './platform-server'
import { attachWsServer, WS_MAX_PAYLOAD, WS_CLOSE_SIGNED_OUT } from './ws'
import { SESSION_COOKIE } from './http'
import { parseTrustedNets, PROXY_SECRET_HEADER } from './proxy-trust'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { presenceHub } from '../core/presence/hub'
import { IPC } from '../shared/ipc'

let dir: string, server: http.Server, port: number, auth: Auth, platform: ServerPlatform, cookie: string
/** Every socket this file opens, so afterEach can tear them all down (see below). */
let sockets: WebSocket[] = []
/** uiIds reported gone by the WS close hook (wired to PtyManager.dropClient at boot). */
let gone: number[] = []

/** Poll until `pred` holds (or throw after ~2s) — socket teardown is async. */
async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for: ${what}`)
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-ws-'))
  auth = new Auth(dir)
  platform = new ServerPlatform({ userDataDir: dir, appVersion: '0.0.0' })
  // The connection handler joins the presence hub, and the hub reaches its shell through the
  // core platform singleton — so this unit test must install the platform, exactly as boot does.
  initPlatform(platform)
  server = http.createServer((_q, s) => { s.statusCode = 404; s.end() })
  gone = []
  attachWsServer(server, { platform, auth, onClientGone: (uiId) => gone.push(uiId) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
  cookie = `${SESSION_COOKIE}=${auth.createSession()}`
  sockets = []
})
afterEach(async () => {
  // Tear the sockets down BEFORE the platform, and wait for the server side to notice. The
  // presence hub is a process-wide singleton while each test builds a fresh ServerPlatform whose
  // uiIds restart at 1 — so a socket whose 'close' (→ presenceHub.leave(uiId)) lands after the
  // test boundary would leave/join against the NEXT test's peers. Draining the hub is the
  // authoritative signal that every server-side 'close' handler has run.
  for (const ws of sockets) ws.terminate()
  sockets = []
  await until(() => presenceHub.peers().length === 0, 'presence hub drains')
  await new Promise((r) => server.close(r))
  // Safe now: no socket, so no late callback can reach a torn-out platform.
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Text frames each socket received, recorded from before 'open' so nothing pushed at connect
 *  time (presence:sync) can be missed by a listener attached one tick too late. */
const recorded = new WeakMap<WebSocket, string[]>()
function received(ws: WebSocket): string[] {
  return recorded.get(ws) ?? []
}

function connect(headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers })
    sockets.push(ws)
    const rec: string[] = []
    recorded.set(ws, rec)
    ws.on('message', (d, isBinary) => { if (!isBinary) rec.push(d.toString()) })
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

describe('ws endpoint', () => {
  it('rejects without a valid session cookie and with a cross-site Origin', async () => {
    await expect(connect({})).rejects.toThrow()
    await expect(connect({ cookie: `${SESSION_COOKIE}=bogus` })).rejects.toThrow()
    await expect(
      connect({ cookie, origin: 'https://evil.example.com' })
    ).rejects.toThrow()
  })

  it('an authenticated browser socket is attached as the OWNER (the only way a held launch reaches it)', async () => {
    // core/canvas-sync.ts forwards a node's machine-local held launch only owner→owner. A browser
    // that got past the cookie check is the server's one user, and must be the owner.
    await connect({ cookie, origin: `http://127.0.0.1:${port}` })
    await until(() => platform.clientIds().length === 1, 'the socket attached')
    const [uiId] = platform.clientIds()
    expect(platform.isOwnerClient(uiId)).toBe(true)
  })

  it('accepts a valid cookie (same-host Origin ok), dispatches req and cast, pushes events', async () => {
    platform.handle('echo:x', (v: string) => `got:${v}`)
    const casts: unknown[] = []
    platform.on('fire', (v: unknown) => casts.push(v))
    const ws = await connect({ cookie, origin: `http://127.0.0.1:${port}` })
    const messages: string[] = []
    ws.on('message', (d, isBinary) => { if (!isBinary) messages.push(d.toString()) })

    ws.send(JSON.stringify({ t: 'req', id: 7, method: 'echo:x', args: ['hi'] }))
    ws.send(JSON.stringify({ t: 'cast', method: 'fire', args: [123] }))
    await new Promise((r) => setTimeout(r, 200))
    expect(messages.map((m) => JSON.parse(m))).toContainEqual({
      t: 'res', id: 7, ok: true, result: 'got:hi'
    })
    expect(casts).toEqual([123])

    // server push (JSON event + binary pty frame) reaches the client
    const bins: Buffer[] = []
    ws.on('message', (d, isBinary) => { if (isBinary) bins.push(d as Buffer) })
    platform.broadcast('pty:exit:s9', 0)
    platform.broadcast('pty:data:s9', 'chunk')
    await new Promise((r) => setTimeout(r, 200))
    expect(messages.map((m) => JSON.parse(m))).toContainEqual({
      t: 'ev', channel: 'pty:exit:s9', args: [0]
    })
    expect(bins.length).toBe(1)
    ws.close()
  })

  it('survives a receiver protocol error on one connection; others keep working', async () => {
    platform.handle('echo:x', (v: string) => `got:${v}`)
    const ws1 = await connect({ cookie, origin: `http://127.0.0.1:${port}` })
    const ws2 = await connect({ cookie, origin: `http://127.0.0.1:${port}` })
    // Swallow the expected client-side error when the server closes ws1's bad frame.
    ws1.on('error', () => {})

    // Corrupt ws1: write a raw UNMASKED text frame straight to its TCP socket.
    // RFC 6455 requires client→server frames to be masked, so the server's receiver
    // emits 'error' — which, without our listener, would throw and exit the process.
    // 0x81 = FIN+text, 0x00 = mask bit unset + length 0.
    ;(ws1 as unknown as { _socket: NodeJS.WritableStream })._socket.write(
      Buffer.from([0x81, 0x00])
    )
    await new Promise((r) => setTimeout(r, 100))

    // The process is still alive and ws2 round-trips a request.
    const messages: string[] = []
    ws2.on('message', (d, isBinary) => { if (!isBinary) messages.push(d.toString()) })
    ws2.send(JSON.stringify({ t: 'req', id: 9, method: 'echo:x', args: ['ok'] }))
    await new Promise((r) => setTimeout(r, 200))
    expect(messages.map((m) => JSON.parse(m))).toContainEqual({
      t: 'res', id: 9, ok: true, result: 'got:ok'
    })
    ws1.close()
    ws2.close()
  })

  // An ORDERED PAIR guarding afterEach's teardown. The presence hub is process-wide, but each test
  // builds a fresh ServerPlatform whose uiIds restart at 1 — so a socket outliving its test would
  // either leave() the next test's first peer or make its join() hit the hub's already-present
  // early return (and that socket would then never get presence:sync). The first test deliberately
  // abandons its socket; the second asserts the next test still starts clean.
  it('joins the presence hub (socket deliberately left open for the next test)', async () => {
    await connect({ cookie })
    await until(() => presenceHub.peers().length === 1, 'the socket joins the hub')
  })

  it('starts with an empty hub, and its first socket receives its own presence:sync', async () => {
    expect(presenceHub.peers()).toHaveLength(0)
    const ws = await connect({ cookie })
    await until(
      () => received(ws).some((m) => JSON.parse(m).channel === IPC.presenceSync),
      'presence:sync on connect'
    )
    ws.close()
  })

  it('refuses an oversized frame instead of buffering it (maxPayload), and never dispatches it', async () => {
    // Without an explicit maxPayload, `ws` defaults to 100 MiB: any client holding the single
    // shared password could push 100 MB frames in a loop and OOM the process, killing every
    // user's ptys. The cap must be enforced by the receiver, before the frame reaches dispatch.
    const casts: unknown[] = []
    platform.on('fire', (v: unknown) => casts.push(v))
    const ws = await connect({ cookie })
    ws.on('error', () => {}) // the server closes the socket under us — expected

    const huge = 'a'.repeat(WS_MAX_PAYLOAD + 1024)
    ws.send(JSON.stringify({ t: 'cast', method: 'fire', args: [huge] }))

    // 1009 = "message too big" — the protocol-level refusal.
    const code = await new Promise<number>((resolve) => ws.on('close', resolve))
    expect(code).toBe(1009)
    expect(casts).toEqual([])
  })

  it('a closed connection is reported gone, so its pty subscriptions are dropped', async () => {
    // A closed tab (or a reload) is the NORMAL way to leave the Server Edition and sends no
    // `pty:kill`. Without this hook the client stays a subscriber of every session it was
    // watching: the pty is never released, its final scrollback snapshot is skipped, and a
    // session it had paused would freeze the next client that co-attaches to that node.
    const ws = await connect({ cookie })
    ws.close()
    await until(() => gone.length === 1, 'the close hook fires')
    expect(gone).toEqual([1]) // the uiId this socket attached as
  })

  it('proxy header trust: upgrade allowed via trusted header + secret, still origin-checked (S2)', async () => {
    const HDR = 'Tailscale-User-Login'
    const SECRET = 'w'.repeat(40)
    const mk = async (netsSpec: string, secret?: string): Promise<{ srv: http.Server; p: number }> => {
      const srv = http.createServer((_q, s2) => { s2.statusCode = 404; s2.end() })
      attachWsServer(srv, {
        platform,
        auth,
        trustProxy: { header: HDR, nets: parseTrustedNets(netsSpec), ...(secret ? { secret } : {}) }
      })
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
      return { srv, p: (srv.address() as { port: number }).port }
    }
    const dial = (p2: number, headers: Record<string, string>): Promise<WebSocket> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${p2}/ws`, { headers })
        sockets.push(ws)
        ws.on('open', () => resolve(ws))
        ws.on('error', reject)
      })

    const { srv, p: pTrusted } = await mk('127.0.0.0/8', SECRET)
    const { srv: srvBare, p: pBare } = await mk('127.0.0.0/8')
    const { srv: srvFar, p: pFar } = await mk('10.0.0.0/8', SECRET)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const sec = { [PROXY_SECRET_HEADER]: SECRET }
      // No cookie, trusted peer + header + secret → accepted (same-host Origin passes the origin check).
      const ok = await dial(pTrusted, { ...sec, [HDR]: 'dev@corp', origin: `http://127.0.0.1:${pTrusted}` })
      expect(ok.readyState).toBe(WebSocket.OPEN)
      // S2, the audit's repro: a local process with the header and no secret → was accepted as OWNER.
      await expect(dial(pTrusted, { [HDR]: 'x' })).rejects.toThrow()
      await expect(dial(pTrusted, { [HDR]: 'x', [PROXY_SECRET_HEADER]: 'nope' })).rejects.toThrow()
      await expect(dial(pBare, { [HDR]: 'x' })).rejects.toThrow()
      // Cross-site Origin is still rejected even when proxy-authed.
      await expect(
        dial(pTrusted, { ...sec, [HDR]: 'dev@corp', origin: 'https://evil.example.com' })
      ).rejects.toThrow()
      // Header without cookie from a peer outside the trusted nets → rejected.
      await expect(dial(pFar, { ...sec, [HDR]: 'dev@corp' })).rejects.toThrow()
      // Cookie still works on a trust-enabled server.
      const viaCookie = await dial(pFar, { cookie })
      expect(viaCookie.readyState).toBe(WebSocket.OPEN)
      expect(warn.mock.calls.flat().join(' ')).not.toContain('nope')
      for (const ws of sockets) ws.terminate()
      sockets = []
      await until(() => presenceHub.peers().length === 0, 'trust-test peers drain')
    } finally {
      warn.mockRestore()
      await new Promise((r) => srv.close(r))
      await new Promise((r) => srvBare.close(r))
      await new Promise((r) => srvFar.close(r))
    }
  }, 30_000)

  it('NODETERM_PUBLIC_ORIGIN: an Origin equal to it passes even when the proxy rewrote Host', async () => {
    const srv = http.createServer((_q, s2) => { s2.statusCode = 404; s2.end() })
    attachWsServer(srv, { platform, auth, publicOrigin: 'https://term.example.com' })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const p2 = (srv.address() as { port: number }).port
    const dial = (headers: Record<string, string>): Promise<WebSocket> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${p2}/ws`, { headers })
        sockets.push(ws)
        ws.on('open', () => resolve(ws))
        ws.on('error', reject)
      })
    try {
      const ok = await dial({ cookie, origin: 'https://term.example.com' })
      expect(ok.readyState).toBe(WebSocket.OPEN)
      await expect(dial({ cookie, origin: 'https://evil.example.com' })).rejects.toThrow()
      for (const ws of sockets) ws.terminate()
      sockets = []
      await until(() => presenceHub.peers().length === 0, 'public-origin peers drain')
    } finally {
      await new Promise((r) => srv.close(r))
    }
  }, 30_000)

  // S3: an open WebSocket was authenticated once, at upgrade, and never again.
  describe('signing out closes the sockets riding on that session (S3)', () => {
    const closeCode = (ws: WebSocket): Promise<number> =>
      new Promise((resolve) => ws.on('close', (code) => resolve(code)))

    it('/auth/logout of one session closes exactly its sockets, and nothing it sends after reaches dispatch', async () => {
      const casts: unknown[] = []
      platform.on('fire', (v: unknown) => casts.push(v))
      const other = `${SESSION_COOKIE}=${auth.createSession()}`
      const mine = await connect({ cookie })
      const theirs = await connect({ cookie: other })
      const closed = closeCode(mine)
      auth.revokeSession(cookie.split('=')[1])
      mine.send(JSON.stringify({ t: 'cast', method: 'fire', args: ['after-revoke'] }))
      expect(await closed).toBe(WS_CLOSE_SIGNED_OUT)
      expect(casts).toEqual([])
      expect(theirs.readyState).toBe(WebSocket.OPEN)
      // And it cannot come back with the same cookie.
      await expect(connect({ cookie })).rejects.toThrow()
    }, 30_000)

    it('sign out everywhere closes every cookie socket; a proxy-authenticated one stays (its identity is the proxy)', async () => {
      const SECRET = 'v'.repeat(40)
      const HDR = 'X-Forwarded-User'
      const srv = http.createServer((_q, s2) => { s2.statusCode = 404; s2.end() })
      attachWsServer(srv, {
        platform,
        auth,
        trustProxy: { header: HDR, nets: parseTrustedNets('127.0.0.0/8'), secret: SECRET }
      })
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
      const p2 = (srv.address() as { port: number }).port
      try {
        const viaProxy = await new Promise<WebSocket>((resolve, reject) => {
          // It carries a cookie too: the socket is bound to the proxy's identity, not to that cookie.
          const ws = new WebSocket(`ws://127.0.0.1:${p2}/ws`, {
            headers: { [HDR]: 'dev', [PROXY_SECRET_HEADER]: SECRET, cookie: `${SESSION_COOKIE}=${auth.createSession()}` }
          })
          sockets.push(ws)
          ws.on('open', () => resolve(ws))
          ws.on('error', reject)
        })
        const a = await connect({ cookie })
        const b = await connect({ cookie: `${SESSION_COOKIE}=${auth.createSession()}` })
        const codes = Promise.all([closeCode(a), closeCode(b)])
        auth.revokeAll()
        expect(await codes).toEqual([WS_CLOSE_SIGNED_OUT, WS_CLOSE_SIGNED_OUT])
        expect(viaProxy.readyState).toBe(WebSocket.OPEN)
        for (const ws of sockets) ws.terminate()
        sockets = []
        await until(() => presenceHub.peers().length === 0, 'peers drain')
      } finally {
        await new Promise((r) => srv.close(r))
      }
    }, 30_000)

    it('a session that EXPIRES is noticed by the heartbeat (expiry announces nothing)', async () => {
      const hbServer = http.createServer((_q, s) => { s.statusCode = 404; s.end() })
      attachWsServer(hbServer, { platform, auth, heartbeatMs: 50 })
      await new Promise<void>((r) => hbServer.listen(0, '127.0.0.1', r))
      const hbPort = (hbServer.address() as { port: number }).port
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${hbPort}/ws`, { headers: { cookie } })
        sockets.push(ws)
        await new Promise<void>((res, rej) => {
          ws.on('open', () => res())
          ws.on('error', rej)
        })
        const closed = closeCode(ws)
        // Only Date moves: the heartbeat's real timer keeps running.
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000)
        expect(await closed).toBe(WS_CLOSE_SIGNED_OUT)
      } finally {
        vi.useRealTimers()
        await until(() => presenceHub.peers().length === 0, 'expired peer drains')
        await new Promise((r) => hbServer.close(r))
      }
    }, 30_000)
  })

  it('heartbeat: terminates a socket that never answers a ping, dropping its presence peer', async () => {
    // Its own listener, so the heartbeat can run at test speed (production: WS_HEARTBEAT_MS).
    const hbServer = http.createServer((_q, s) => { s.statusCode = 404; s.end() })
    attachWsServer(hbServer, { platform, auth, heartbeatMs: 50 })
    await new Promise<void>((r) => hbServer.listen(0, '127.0.0.1', r))
    const hbPort = (hbServer.address() as { port: number }).port

    const ws = new WebSocket(`ws://127.0.0.1:${hbPort}/ws`, { headers: { cookie } })
    sockets.push(ws)
    await new Promise<void>((res, rej) => {
      ws.on('open', () => res())
      ws.on('error', rej)
    })
    // Expected once the server terminates it (RST on a half-open socket).
    ws.on('error', () => {})
    await until(() => presenceHub.peers().length === 1, 'the peer joined')

    // A vanished browser (laptop asleep, wifi dropped, NAT idle-reap): the TCP socket stays
    // half-open — no FIN — so the peer never answers the ping and 'close' never fires on its own.
    // Pausing the client's socket reproduces exactly that: frames arrive, nothing reads them, so
    // the `ws` client never auto-pongs.
    ;(ws as unknown as { _socket: { pause(): void } })._socket.pause()

    // The heartbeat must terminate it — and termination fires 'close' → presenceHub.leave().
    await until(() => presenceHub.peers().length === 0, 'the ghost peer is reaped')
    await new Promise((r) => hbServer.close(r))
  })
})
