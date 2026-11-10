// The browser guard against the REAL server, driven by the REAL clients' transports: curl over the
// unix socket and over loopback TCP (the generated sh clients and the SSH tunnel's host-side
// curl), Node's http over the socket (the codex relay daemon, the endpoint owner probe) and Node's
// fetch. A guard that refused any one of them would silently cost that client its hooks — the
// pure decision lives in hook-browser-guard.test.ts; this file proves it is wired in front of the
// bearer on BOTH listeners and that every shipped client shape still gets through.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { request } from 'node:http'
import { promisify } from 'node:util'
import { hookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'

const run = promisify(execFile)

let dir = ''
let reached = 0

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-browser-guard-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setControlHandler(async (cmd) => {
    reached++
    return { ok: true, message: `did ${cmd.verb}` }
  })
})

afterAll(() => {
  hookServer.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

const bearer = (): Record<string, string> => ({ 'X-Nodeterm-Hook-Token': hookServer.getToken() })

/** The real curl. `url` decides the Host curl sends, exactly as in the generated scripts. */
async function curl(
  transport: 'sock' | 'tcp',
  url: string,
  headers: Record<string, string>
): Promise<{ status: string; body: string }> {
  const out = path.join(dir, `curl-out-${Math.random().toString(36).slice(2)}`)
  const args = ['-sS', '-o', out, '-w', '%{http_code}', '-X', 'POST']
  if (transport === 'sock') args.push('--unix-socket', hookServer.getSockPath())
  args.push(url, '-H', 'Accept: text/plain')
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`)
  args.push('--data-urlencode', 'nodeId=node-1')
  const { stdout } = await run('curl', args)
  const body = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
  fs.rmSync(out, { force: true })
  return { status: stdout.trim(), body }
}

const tcpUrl = (p: string, host = '127.0.0.1'): string => `http://${host}:${hookServer.getPort()}${p}`

describe.skipIf(process.platform === 'win32')('the browser guard on the real hook server', () => {
  it('every shipped client transport still reaches the handler', async () => {
    reached = 0
    // The managed hook scripts, nodeterm.sh, context.sh and the failover probe over the socket.
    expect(await curl('sock', 'http://localhost/control/list', bearer())).toEqual({ status: '200', body: 'did list\n' })
    // The codex launcher's socket URL carries a port of 0 (`localhost:${NODETERM_HOOK_PORT-0}`).
    expect((await curl('sock', 'http://localhost:0/control/list', bearer())).status).toBe('200')
    // The same scripts over loopback TCP.
    expect((await curl('tcp', tcpUrl('/control/list'), bearer())).status).toBe('200')
    expect((await curl('tcp', tcpUrl('/control/list', 'localhost'), bearer())).status).toBe('200')
    // The SSH loopback-TCP fallback: the host-side curl names the HOST's listener port, which is
    // not ours. The bytes are forwarded unchanged, so that Host arrives here.
    expect((await curl('tcp', tcpUrl('/control/list'), { ...bearer(), Host: '127.0.0.1:52011' })).status).toBe('200')
    // Node's http over the socket (codex relay daemon, endpoint owner probe): Host is `localhost`.
    const viaNode = await new Promise<number>((resolve, reject) => {
      const req = request(
        { socketPath: hookServer.getSockPath(), path: '/verify', method: 'POST', headers: bearer() },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        }
      )
      req.on('error', reject)
      req.end()
    })
    expect(viaNode).toBe(204)
    // Node's fetch sends `sec-fetch-mode: cors` (measured) but no Origin.
    const viaFetch = await fetch(tcpUrl('/verify'), { method: 'POST', headers: bearer() })
    expect(viaFetch.status).toBe(204)
    expect(reached).toBe(5)
  })

  it('refuses a request carrying an Origin, on both listeners, even with the right bearer', async () => {
    reached = 0
    const evil = { ...bearer(), Origin: 'https://evil.example' }
    for (const r of [
      await curl('sock', 'http://localhost/control/list', evil),
      await curl('tcp', tcpUrl('/control/list'), evil),
      // A page served from the loopback origin itself (or a sandboxed iframe's `null`) is still a page.
      await curl('tcp', tcpUrl('/control/list'), { ...bearer(), Origin: `http://127.0.0.1:${hookServer.getPort()}` }),
      await curl('tcp', tcpUrl('/control/list'), { ...bearer(), Origin: 'null' })
    ]) {
      expect(r.status).toBe('403')
      expect(r.body).toMatch(/Origin/)
    }
    expect(reached).toBe(0)
  })

  it('refuses a DNS-rebound Host, even with the right bearer', async () => {
    reached = 0
    for (const host of [`evil.example:${hookServer.getPort()}`, `127.0.0.1.evil.example:${hookServer.getPort()}`]) {
      const r = await curl('tcp', tcpUrl('/control/list'), { ...bearer(), Host: host })
      expect(r.status, host).toBe('403')
      expect(r.body).toMatch(/Host/)
    }
    expect(reached).toBe(0)
  })

  it('a refused browser request learns nothing about the bearer (no 421 wrong-owner answer)', async () => {
    const r = await curl('tcp', tcpUrl('/control/list'), { 'X-Nodeterm-Hook-Token': 'guess', Origin: 'https://evil.example' })
    expect(r.status).toBe('403')
  })

  it('an HTTP/1.0 request with no Host header still reaches the bearer check', async () => {
    const status = await new Promise<string>((resolve, reject) => {
      const s = net.connect(hookServer.getPort(), '127.0.0.1', () => {
        s.write(`POST /verify HTTP/1.0\r\nX-Nodeterm-Hook-Token: ${hookServer.getToken()}\r\nContent-Length: 0\r\n\r\n`)
      })
      let buf = ''
      s.on('data', (d) => (buf += d.toString()))
      s.on('end', () => resolve(buf.split(' ')[1] ?? ''))
      s.on('error', reject)
    })
    expect(status).toBe('204')
  })
})
