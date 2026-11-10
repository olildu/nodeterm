// The native transport pins the host key TYPE on record, against a REAL SSH protocol peer (ssh2's
// own Server, in-process, on loopback — runs the same on every CI leg).
//
// Before: ssh2 negotiated host keys in its own default order (ed25519 first) and the verifier read
// a key of a type known_hosts did not hold for that host as "first seen", recorded it and
// connected. So a man in the middle holding only an ed25519 key, against a host recorded under
// ECDSA (or RSA), was silently trusted — the changed-key check never ran, because no recorded key
// of the presented type existed to differ from.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AddressInfo } from 'net'
import { Server, utils, type Connection } from 'ssh2'
import { NativeMux } from './native-mux'
import { parseSshArgv } from './ssh-argv'
import { childArgs } from '../control-master'
import type { ResolvedHost } from './ssh-config'
import { ed25519KeyPair } from './test-keys'

const edKey = ed25519KeyPair()
const ecdsaKey = utils.generateKeyPairSync('ecdsa', { bits: 256 })
const clientKey = ed25519KeyPair()

let dir: string
const servers: Server[] = []
const live: Connection[] = []
const muxes: NativeMux[] = []

/** A server holding `hostKeys`, answering every exec with `ran`. Resolves its port. */
function startServer(hostKeys: string[]): Promise<number> {
  const server = new Server({ hostKeys }, (client) => {
    live.push(client)
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey'])
      const k = utils.parseKey(clientKey.public)
      const one = Array.isArray(k) ? k[0] : k
      if (one instanceof Error || ctx.key.algo !== one.type || !ctx.key.data.equals(one.getPublicSSH())) {
        return ctx.reject(['publickey'])
      }
      ctx.accept()
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('exec', (acceptExec) => {
          const ch = acceptExec()
          ch.write('ran\n')
          ch.exit(0)
          ch.end()
        })
      })
    })
    client.on('error', () => {})
  })
  servers.push(server)
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)))
}

const knownHosts = (): string => path.join(dir, 'known_hosts')
const kh = (port: number, key: string): string => {
  const k = utils.parseKey(key)
  const one = Array.isArray(k) ? k[0] : k
  if (one instanceof Error) throw one
  return `[127.0.0.1]:${port} ${one.type} ${one.getPublicSSH().toString('base64')}\n`
}

function mux(port: number): NativeMux {
  const host: ResolvedHost = {
    hostname: '127.0.0.1',
    port,
    user: 'dev',
    identityFiles: [path.join(dir, 'id')],
    identitiesOnly: true,
    userKnownHostsFiles: [knownHosts()],
    globalKnownHostsFiles: [],
    strictHostKeyChecking: 'ask'
  }
  const m = new NativeMux({ resolveHost: async () => host, defaultAgent: () => undefined })
  muxes.push(m)
  return m
}

async function run(port: number) {
  const p = parseSshArgv(
    childArgs({ user: 'dev', host: '127.0.0.1', port, identityFile: path.join(dir, 'id') }, path.join(dir, `cm-${port}.sock`), 'echo')
  )
  if (p.kind !== 'exec') throw new Error('not exec')
  return mux(port).exec(p)
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-native-hktype-'))
  fs.writeFileSync(path.join(dir, 'id'), clientKey.private)
})
afterEach(() => {
  for (const m of muxes.splice(0)) m.exitAll()
  for (const c of live.splice(0)) c.end()
  for (const s of servers.splice(0)) s.close()
  fs.rmSync(knownHosts(), { force: true })
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('native ssh: the recorded host key type is pinned', () => {
  it('a host serving several types presents the RECORDED one (order_hostkeyalgs), and nothing new is recorded', async () => {
    const port = await startServer([edKey.private, ecdsaKey.private])
    // Recorded under ECDSA only; ssh2's default order would have asked for ed25519 first.
    fs.writeFileSync(knownHosts(), kh(port, ecdsaKey.private))
    const r = await run(port)
    expect(r.stderr.toString()).toBe('')
    expect(r.code).toBe(0)
    expect(r.stdout.toString()).toBe('ran\n')
    expect(fs.readFileSync(knownHosts(), 'utf8')).toBe(kh(port, ecdsaKey.private))
  })

  it('a peer holding only ANOTHER type (the MITM) is refused, and its key is not recorded', async () => {
    const port = await startServer([edKey.private])
    fs.writeFileSync(knownHosts(), kh(port, ecdsaKey.private))
    const r = await run(port)
    expect(r.code).toBe(255)
    const err = r.stderr.toString()
    expect(err).toMatch(/REMOTE HOST IDENTIFICATION HAS CHANGED/)
    expect(err).toContain('ecdsa-sha2-nistp256')
    expect(err).toContain('ssh-ed25519')
    expect(err).toContain(`ssh-keygen -R [127.0.0.1]:${port}`)
    expect(fs.readFileSync(knownHosts(), 'utf8')).toBe(kh(port, ecdsaKey.private))
  })

  it('a host never seen before is still recorded and accepted (accept-new is unchanged)', async () => {
    const port = await startServer([edKey.private, ecdsaKey.private])
    const r = await run(port)
    expect(r.code).toBe(0)
    expect(fs.readFileSync(knownHosts(), 'utf8')).toBe(kh(port, edKey.private))
  })
})
