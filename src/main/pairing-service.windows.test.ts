// Windows pairing is relay-only (issue #758 / the Windows phone breakpoint map): no SSH key, a
// `"ssh":false` QR, a failed relay mint pairs nothing, and revoke also sweeps the machine-wide
// administrators key file. The platform is INJECTED, so every case here runs on the Linux job and
// on windows-latest alike.
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { request as httpRequest } from 'http'
import path from 'path'

const TEMP_HOME_MARKER = 'nt-pairing-win-'

// Same reason as pairing-service.test.ts: the key paths are frozen from os.homedir() at module load.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const { mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(actual.tmpdir(), 'nt-pairing-win-'))
  const homedir = (): string => home
  const networkInterfaces = (): NodeJS.Dict<import('os').NetworkInterfaceInfo[]> => ({
    'vEthernet (WSL)': [
      {
        address: '172.20.48.1',
        netmask: '255.255.240.0',
        family: 'IPv4',
        mac: '00:15:5d:00:00:01',
        internal: false,
        cidr: '172.20.48.1/20'
      }
    ],
    'Wi-Fi': [
      {
        address: '192.168.1.42',
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: '02:00:00:00:00:01',
        internal: false,
        cidr: '192.168.1.42/24'
      }
    ]
  })
  const base = (actual as unknown as { default?: typeof actual }).default ?? actual
  return { ...actual, homedir, networkInterfaces, default: { ...base, homedir, networkInterfaces } }
})
vi.mock('../core/device-id', () => ({ getDeviceId: () => 'test-host-device-id' }))

import os from 'os'
import { createPairingService, type PairingDone, type PairingRelayDeps } from './pairing-service'
import { type DeviceEntry } from './pairing-core'
import { genKeyPair } from './remote/e2ee'
import type { Settings } from '../shared/types'

const HOME = os.homedir()
if (!path.basename(HOME).startsWith(TEMP_HOME_MARKER)) {
  throw new Error(`refusing to run: homedir() is "${HOME}", the os mock is not in effect`)
}
const AGENT_JSON = path.join(HOME, '.nodeterm', 'agent.json')
const AUTH_KEYS = path.join(HOME, '.ssh', 'authorized_keys')
const ADMIN_KEYS = path.join(HOME, 'ProgramData-ssh', 'administrators_authorized_keys')

const hostKeys = genKeyPair()
const relayDeps = (): PairingRelayDeps => ({
  getSettings: () => ({ phoneAccessEnabled: true }) as unknown as Settings,
  getEntitlement: () => null,
  loadHostKeyPair: async () => hostKeys,
  relayEndpoint: 'wss://relay.example/ws',
  apiBase: 'https://api.example',
  relayAllowed: () => true
})
const win = {
  platform: 'win32' as const,
  detectKeyFile: async () => 'administrators' as const,
  administratorsKeysPath: ADMIN_KEYS,
  defaultRouteAddress: async () => null
}

function freshEd25519Line(): string {
  const name = Buffer.from('ssh-ed25519', 'ascii')
  const len = (n: number): Buffer => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n, 0)
    return b
  }
  const blob = Buffer.concat([len(name.length), name, len(32), randomBytes(32)])
  return `ssh-ed25519 ${blob.toString('base64')} phone@ios`
}

function post(port: number, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/pair',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
}

const devices = (): DeviceEntry[] =>
  existsSync(AGENT_JSON)
    ? ((JSON.parse(readFileSync(AGENT_JSON, 'utf8')).devices as DeviceEntry[] | undefined) ?? [])
    : []

const reset = (): void => {
  for (const d of ['.nodeterm', '.ssh', 'ProgramData-ssh']) rmSync(path.join(HOME, d), { recursive: true, force: true })
}

afterEach(() => {
  vi.restoreAllMocks()
  reset()
})
afterAll(() => rmSync(HOME, { recursive: true, force: true }))

describe('Windows pairing: relay-only', () => {
  it('says so in the start result and the QR, and prefers the real adapter over vEthernet', async () => {
    reset()
    const service = createPairingService(relayDeps(), win)
    try {
      const started = await service.start(() => {})
      expect(started.sshKey).toBe(false)
      expect(started.windowsKeyFile).toBe('administrators')
      expect(started.relayPlan).toBe('ok')
      const payload = JSON.parse(started.payload) as Record<string, unknown>
      expect(payload.ssh).toBe(false)
      expect(payload.host).toBe('192.168.1.42')
    } finally {
      service.stop()
    }
  })

  it('never reads or carries SSH host-key fingerprints (no SSH to pin on this host)', async () => {
    reset()
    const readSshHostKeys = vi.fn(async () => ['SHA256:' + 'A'.repeat(43)])
    const service = createPairingService(relayDeps(), { ...win, readSshHostKeys })
    try {
      const started = await service.start(() => {})
      expect(readSshHostKeys).not.toHaveBeenCalled()
      expect(JSON.parse(started.payload)).not.toHaveProperty('sshHostKeys')
    } finally {
      service.stop()
    }
  })

  it('takes the default-route address when it belongs to this machine', async () => {
    const service = createPairingService(relayDeps(), { ...win, defaultRouteAddress: async () => '172.20.48.1' })
    try {
      const payload = JSON.parse((await service.start(() => {})).payload) as { host: string }
      expect(payload.host).toBe('172.20.48.1')
    } finally {
      service.stop()
    }
  })

  it('installs NO key and records the device as ssh:false when the relay mint succeeds', async () => {
    reset()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ deviceToken: 'device-token', hostId: 'host-id', exp: 0 })
    } as unknown as Response)
    const done: PairingDone[] = []
    const service = createPairingService(relayDeps(), win)
    try {
      const { payload } = await service.start((r) => done.push(r))
      const { token, pairPort } = JSON.parse(payload) as { token: string; pairPort: number }
      const res = await post(pairPort, { token, publicKey: freshEd25519Line(), deviceId: 'phone-w' })
      expect(res.status).toBe(200)
      const body = JSON.parse(res.text) as { ok: boolean; deviceId: string; relayDeviceToken: string }
      expect(body.relayDeviceToken).toBe('device-token')
      expect(existsSync(AUTH_KEYS)).toBe(false)
      expect(devices()).toHaveLength(1)
      expect(devices()[0]).toMatchObject({ id: body.deviceId, relayDeviceId: 'phone-w', ssh: false })
      expect(done).toEqual([{ ok: true, relay: 'ok' }])
    } finally {
      service.stop()
    }
  })

  it('pairs NOTHING when the relay mint fails, and tells both ends', async () => {
    reset()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, json: async () => ({}) } as unknown as Response)
    const done: PairingDone[] = []
    const service = createPairingService(relayDeps(), win)
    try {
      const { payload } = await service.start((r) => done.push(r))
      const { token, pairPort } = JSON.parse(payload) as { token: string; pairPort: number }
      const res = await post(pairPort, { token, publicKey: freshEd25519Line() })
      expect(res.status).toBe(502)
      expect(res.text).toMatch(/remote access/)
      expect(existsSync(AUTH_KEYS)).toBe(false)
      expect(devices()).toEqual([])
      expect(done).toEqual([{ ok: false, reason: 'relay-failed', reached: true }])
    } finally {
      service.stop()
    }
  })

  it('refuses a scan while remote access is off, without consuming the pairing', async () => {
    reset()
    const done: PairingDone[] = []
    const service = createPairingService(undefined, win)
    try {
      const started = await service.start((r) => done.push(r))
      expect(started.relayPlan).toBe('off')
      const { token, pairPort } = JSON.parse(started.payload) as { token: string; pairPort: number }
      const res = await post(pairPort, { token, publicKey: freshEd25519Line() })
      expect(res.status).toBe(409)
      expect(existsSync(AUTH_KEYS)).toBe(false)
      expect(devices()).toEqual([])
      expect(done).toEqual([])
    } finally {
      service.stop()
    }
  })

  it('reports whether anything reached the listener when it times out', async () => {
    const quiet: PairingDone[] = []
    const service = createPairingService(relayDeps(), { ...win, timeoutMs: 50 })
    await service.start((r) => quiet.push(r))
    await new Promise((r) => setTimeout(r, 150))
    expect(quiet).toEqual([{ ok: false, reason: 'timeout', reached: false }])

    const knocked: PairingDone[] = []
    const again = createPairingService(relayDeps(), { ...win, timeoutMs: 300 })
    const { pairPort } = JSON.parse((await again.start((r) => knocked.push(r))).payload) as { pairPort: number }
    await post(pairPort, { token: 'wrong', publicKey: freshEd25519Line() })
    await new Promise((r) => setTimeout(r, 450))
    expect(knocked).toEqual([{ ok: false, reason: 'timeout', reached: true }])
  })
})

describe('Windows revoke sweeps the administrators key file', () => {
  // A #758 manual copy made from an iPhone paired before the rename: the legacy stamp.
  const KEY_A = 'ssh-ed25519 AAAAblobAAAA nodeterm-ios-dev-a'
  const OTHER = 'ssh-ed25519 AAAAadminlaptop admin@laptop'
  const seed = (): void => {
    reset()
    mkdirSync(path.join(HOME, '.nodeterm'), { recursive: true })
    mkdirSync(path.dirname(ADMIN_KEYS), { recursive: true })
    writeFileSync(
      AGENT_JSON,
      JSON.stringify({ devices: [{ id: 'dev-a', name: 'A', token: 't', pairedAt: 1, lastSeenAt: 0 }] })
    )
    writeFileSync(ADMIN_KEYS, `${OTHER}\n${KEY_A}\n`)
  }

  it('removes the device line (the #758 manual-workaround copy) and keeps everyone else', async () => {
    seed()
    const result = await createPairingService(undefined, win).revokeDevice('dev-a')
    expect(result.local).toBe(true)
    expect(readFileSync(ADMIN_KEYS, 'utf8')).toBe(`${OTHER}\n`)
    expect(devices()).toEqual([])
  })

  it('never touches that file off Windows', async () => {
    seed()
    await createPairingService(undefined, { ...win, platform: 'linux' }).revokeDevice('dev-a')
    expect(readFileSync(ADMIN_KEYS, 'utf8')).toBe(`${OTHER}\n${KEY_A}\n`)
  })

  // The unelevated case: that file's ACL denies even a read. Skipped (see the KNOWN RESIDUAL note on
  // removeAdministratorsKeysForDevice) — a missing file stands in for an unreadable one here.
  it('does not fail a revoke over a file it cannot read — the normal, unelevated case', async () => {
    seed()
    rmSync(ADMIN_KEYS)
    const result = await createPairingService(undefined, win).revokeDevice('dev-a')
    expect(result.local).toBe(true)
  })

  it('reports local:false when the line is there but cannot be removed', async () => {
    seed()
    const realWrite = (await import('fs')).promises.writeFile
    vi.spyOn((await import('fs')).promises, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p) === ADMIN_KEYS) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      return (realWrite as any)(p, ...rest)
    }) as any)
    const result = await createPairingService(undefined, win).revokeDevice('dev-a')
    expect(result.local).toBe(false)
    expect(readFileSync(ADMIN_KEYS, 'utf8')).toContain('nodeterm-ios-dev-a')
    // Reported, not half-done: the device stays listed so the owner can retry.
    expect(devices().map((d) => d.id)).toEqual(['dev-a'])
  })
})
