import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { promises as fs, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { request as httpRequest } from 'http'
import path from 'path'

const TEMP_HOME_MARKER = 'nt-pairing-'

// pairing-service computes AGENT_DIR / AGENT_JSON_PATH / AUTH_KEYS_PATH from `os.homedir()` at
// MODULE LOAD time, so the redirect has to be in place before the import — hence the mock factory
// (hoisted by vitest) minting the temp home itself. `networkInterfaces` is faked too so start()
// finds a LAN IP on a CI box with none. Everything else about `os` stays real.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const { mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(actual.tmpdir(), 'nt-pairing-'))
  const homedir = (): string => home
  const networkInterfaces = (): NodeJS.Dict<import('os').NetworkInterfaceInfo[]> => ({
    eth0: [
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
  return {
    ...actual,
    homedir,
    networkInterfaces,
    default: { ...base, homedir, networkInterfaces }
  }
})

// The relay mint stamps this host's anonymous device id, which is read out of the CorePlatform's
// userData dir — uninitialized here, and its throw would be swallowed into a silent LAN-only
// pairing. Pinned to a constant so the mint body is fully assertable.
vi.mock('../core/device-id', () => ({ getDeviceId: () => 'test-host-device-id' }))

import os from 'os'
import { createPairingService, type PairingRelayDeps } from './pairing-service'
import { rewriteKeyComment, type DeviceEntry } from './pairing-core'
import nacl from 'tweetnacl'
import { encrypt, genKeyPair, publicKeyToB64 } from './remote/e2ee'
import type { Settings } from '../shared/types'

const HOME = os.homedir()
const AGENT_JSON = path.join(HOME, '.nodeterm', 'agent.json')
const AUTH_KEYS = path.join(HOME, '.ssh', 'authorized_keys')

/**
 * This file deletes directories under HOME. If the `os` mock above ever breaks or is dropped,
 * HOME becomes the developer's REAL home and those deletes take out `~/.ssh` — silently, because
 * nothing else in the suite can tell the difference. Refuse to run unless HOME is demonstrably one
 * of our mkdtemp dirs. Called at module scope (so nothing runs at all) and again before the
 * afterAll wipe.
 */
function assertTempHome(): void {
  if (!path.basename(HOME).startsWith(TEMP_HOME_MARKER)) {
    throw new Error(
      `pairing-service.test refuses to run: homedir() is "${HOME}", not a ${TEMP_HOME_MARKER}* ` +
        'temp dir. The os mock is not in effect and this file would delete the real ~/.ssh.'
    )
  }
}
assertTempHome()

// Stamped exactly the way pairing minted them, so `filterAuthorizedKeys` really matches.
// dev-a is an iPhone paired BEFORE the rename (legacy `nodeterm-ios-` stamp, written literally);
// dev-b was paired after it (stamped exactly the way pairing mints keys now). A revoke must find
// both — the first is what every existing user's authorized_keys looks like.
const KEY_A = 'ssh-ed25519 AAAAblobAAAA nodeterm-ios-dev-a'
const KEY_B = rewriteKeyComment('ssh-ed25519 AAAAblobBBBB phone-b@ios', 'dev-b')
// Not ours: no revoke may ever touch it (a fix that "passes" by truncating the file must fail).
const KEY_OTHER = 'ssh-rsa AAAAlaptopblob jdub@laptop'

const device = (id: string, name: string): DeviceEntry => ({
  id,
  name,
  token: `agent-token-${id}`,
  pairedAt: 1_700_000_000_000,
  lastSeenAt: 0
})

/** Agent.json as the host agent leaves it: our devices plus fields we don't own. */
const seed = (): void => {
  rmSync(path.join(HOME, '.nodeterm'), { recursive: true, force: true })
  rmSync(path.join(HOME, '.ssh'), { recursive: true, force: true })
  mkdirSync(path.join(HOME, '.nodeterm'), { recursive: true, mode: 0o700 })
  mkdirSync(path.join(HOME, '.ssh'), { recursive: true, mode: 0o700 })
  writeFileSync(
    AGENT_JSON,
    JSON.stringify(
      { hostId: 'host-keep-me', devices: [device('dev-a', 'Phone A'), device('dev-b', 'Phone B')] },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  )
  writeFileSync(AUTH_KEYS, `${KEY_OTHER}\n${KEY_A}\n${KEY_B}\n`, { mode: 0o600 })
}

const authKeys = (): string => readFileSync(AUTH_KEYS, 'utf8')
const agentJson = (): Record<string, unknown> => JSON.parse(readFileSync(AGENT_JSON, 'utf8'))
const deviceIds = (): string[] =>
  ((agentJson().devices as DeviceEntry[] | undefined) ?? []).map((d) => d.id)

/**
 * Hold the first read of each watched path until EITHER a second read of that path lands (the
 * unfixed code overlaps, so both revokes see the same stale bytes and each drops only its own
 * device) OR a short timer fires (the fixed code serializes them, so the second read never
 * overlaps and the test just runs ~150ms slower). Bytes are captured BEFORE the hold, so a
 * released writer can never hand the still-waiting reader fresh content by accident — and the
 * timer means this can never hang into an opaque vitest timeout.
 */
const OVERLAP_WAIT_MS = 150
function gateReads(watched: string[]): void {
  const captured = new Map<string, number>()
  const waiters = new Map<string, Array<() => void>>()
  const realReadFile = fs.readFile
  vi.spyOn(fs, 'readFile').mockImplementation((async (p: any, ...rest: any[]) => {
    const key = String(p)
    if (!watched.includes(key)) return (realReadFile as any)(p, ...rest)
    const bytes = await (realReadFile as any)(p, ...rest)
    const n = (captured.get(key) ?? 0) + 1
    captured.set(key, n)
    if (n >= 2) {
      for (const w of waiters.get(key) ?? []) w()
      waiters.set(key, [])
    } else {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, OVERLAP_WAIT_MS)
        // Released early → drop the timer, so a killed run leaves nothing pending.
        waiters.set(key, [
          ...(waiters.get(key) ?? []),
          () => {
            clearTimeout(t)
            resolve()
          }
        ])
      })
    }
    return bytes
  }) as any)
}

/** A key line the phone could really have sent: OpenSSH wire format the validator decodes. */
function freshEd25519Line(comment = 'phone@ios'): string {
  const name = Buffer.from('ssh-ed25519', 'ascii')
  const len = (n: number): Buffer => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n, 0)
    return b
  }
  const blob = Buffer.concat([len(name.length), name, len(32), randomBytes(32)])
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`
}

/** POST /pair the way the phone does (plaintext branch — no host key, so no `epk` envelope). */
function post(port: number, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/pair',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve(text))
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
}

beforeEach(() => {
  seed()
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  assertTempHome()
  rmSync(HOME, { recursive: true, force: true })
})

describe('revokeDevice', () => {
  // revokeDevice is a read-modify-write over BOTH files (agent.json, then authorized_keys) and
  // src/main/index.ts hands every `pairing:revoke-device` invoke straight to it, unserialized. Two
  // overlapping revokes each read the ORIGINAL file and filter out only their own device, so
  // whichever write lands last republishes the other's — a revoked phone keeps its SSH key line,
  // and its agent.json entry comes back WITH the bearer token for the host-agent socket.
  it('two concurrent revokes both stick (no lost update in either file)', async () => {
    gateReads([AGENT_JSON, AUTH_KEYS])
    const service = createPairingService()

    const results = await Promise.allSettled([
      service.revokeDevice('dev-a'),
      service.revokeDevice('dev-b')
    ])

    const keys = authKeys()
    expect(keys).not.toContain('nodeterm-ios-dev-a')
    expect(keys).not.toContain('nodeterm-mobile-dev-b')
    expect(keys).toContain(KEY_OTHER) // the user's own key was never in scope
    expect(deviceIds()).toEqual([])
    expect(agentJson().hostId).toBe('host-keep-me') // fields we don't own survive the rewrite
    // Neither revoke may report failure to its caller either.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
  })

  it('a failed revoke reports local:false to its caller and does not block the next one', async () => {
    const service = createPairingService()
    // First rename is agent.json's, inside the failing revoke.
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' })
    )

    // The failure is REPORTED, not thrown (the server leg still has to run, and the UI turns
    // `local:false` into a retry note — a rejection here reached nobody).
    expect((await service.revokeDevice('dev-a')).local).toBe(false)
    // A serializer that chains failures onto its successors would strand every later revoke.
    await service.revokeDevice('dev-b')

    const keys = authKeys()
    expect(keys).not.toContain('nodeterm-mobile-dev-b')
    expect(keys).toContain('nodeterm-ios-dev-a') // the failed revoke really did fail
    expect(deviceIds()).toEqual(['dev-a'])
  })

  it('revokes the SSH key first, so a mid-revoke failure leaves access cut and the device retryable', async () => {
    // Order matters on partial failure. authorized_keys is full shell access; agent.json is the
    // host-agent bearer token and the visible device list. If the SSH key is removed FIRST, a
    // failure on the second step leaves the bigger capability already revoked AND the device still
    // listed — so the owner sees it and can retry. The reverse order (drop the listing first) would
    // hide a device whose SSH key is still live, with no button left to finish the job.
    const service = createPairingService()
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes('agent.json')) {
        throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' })
      }
      return realRename(from, to)
    })

    // …and the half-finished revoke says so (`local:false`) instead of resolving like a clean one.
    expect((await service.revokeDevice('dev-a')).local).toBe(false)

    expect(authKeys()).not.toContain('nodeterm-ios-dev-a') // SSH access really was cut
    expect(deviceIds()).toContain('dev-a') // still listed, so the owner can retry
  })

  it('a single revoke drops exactly its own device, leaving the file 0600', async () => {
    const service = createPairingService()

    await service.revokeDevice('dev-a')

    const keys = authKeys()
    expect(keys).toBe(`${KEY_OTHER}\n${KEY_B}\n`)
    expect(deviceIds()).toEqual(['dev-b'])
    expect(agentJson().hostId).toBe('host-keep-me')
    expect(statSync(AUTH_KEYS).mode & 0o777).toBe(0o600)
    expect(statSync(AGENT_JSON).mode & 0o777).toBe(0o600)
  })
})

describe('the QR carries this host\'s SSH host-key fingerprints', () => {
  const FP = 'SHA256:4hkcemIeUAnjVwt5EwB/CU/rymSk1jz+o5uJWjj16e4'
  it('as `sshHostKeys`, from the reader, so the phone pins its first SSH connect', async () => {
    const service = createPairingService(undefined, { readSshHostKeys: async () => [FP] })
    try {
      const started = await service.start(() => {})
      expect(JSON.parse(started.payload).sshHostKeys).toEqual([FP])
    } finally {
      service.stop()
    }
  })

  it('omits the field when the reader finds none or fails (the phone falls back to TOFU, as before)', async () => {
    for (const readSshHostKeys of [async () => [], async () => Promise.reject(new Error('EACCES'))]) {
      const service = createPairingService(undefined, { readSshHostKeys })
      try {
        const started = await service.start(() => {})
        expect(JSON.parse(started.payload)).not.toHaveProperty('sshHostKeys')
      } finally {
        service.stop()
      }
    }
  })
})

describe('pairing POST vs revoke', () => {
  // The pairing POST mutates the same two files: it APPENDS to authorized_keys and upserts into
  // agent.json. Overlapping a revoke, an unserialized pairing either appends onto the inode the
  // revoke is about to rename over, or loses its agent.json entry to the revoke's stale read —
  // and the revoke can equally be undone by the pairing's. Both mutations must share ONE queue.
  it('a pairing landing mid-revoke keeps both changes', async () => {
    const service = createPairingService()
    try {
      const started = await service.start(() => {})
      const { token, pairPort } = JSON.parse(started.payload) as {
        token: string
        pairPort: number
      }
      gateReads([AGENT_JSON, AUTH_KEYS])

      const [respText] = await Promise.all([
        post(pairPort, { token, publicKey: freshEd25519Line(), deviceName: 'New Phone' }),
        service.revokeDevice('dev-a')
      ])

      const { deviceId } = JSON.parse(respText) as { deviceId: string }
      const keys = authKeys()
      expect(keys).not.toContain('nodeterm-ios-dev-a') // the revoke stuck
      expect(keys).toContain(`nodeterm-mobile-${deviceId}`) // …and so did the pairing
      expect(keys).toContain(KEY_OTHER)
      expect(deviceIds()).toEqual(['dev-b', deviceId])
    } finally {
      service.stop()
    }
  })
})

describe('pairing remembers the phone’s relay device id', () => {
  // Two ids are in play and only ONE of them means anything to the relay backend: the desktop
  // mints a local `deviceId` (it stamps the authorized_keys comment), while `relay_devices` is
  // keyed on the id the PHONE sends. agent.json used to keep only the local one — the phone's was
  // computed for the mint and thrown away — so "Remove device" had no way to name the row the
  // server holds.
  const hostKeys = genKeyPair()
  const relayDeps = (): PairingRelayDeps => ({
    getSettings: () => ({ phoneAccessEnabled: true }) as unknown as Settings,
    getEntitlement: () => null,
    loadHostKeyPair: async () => hostKeys,
    relayEndpoint: 'wss://relay.example/ws',
    apiBase: 'https://api.example',
    relayAllowed: () => true
  })

  const devices = (): DeviceEntry[] => (agentJson().devices as DeviceEntry[] | undefined) ?? []
  const paired = (id: string): DeviceEntry => {
    const entry = devices().find((d) => d.id === id)
    if (!entry) throw new Error(`no agent.json entry for ${id}`)
    return entry
  }

  it('persists the id the phone sent, alongside the local one it does not replace', async () => {
    const service = createPairingService()
    try {
      const started = await service.start(() => {})
      const { token, pairPort } = JSON.parse(started.payload) as { token: string; pairPort: number }

      const respText = await post(pairPort, {
        token,
        publicKey: freshEd25519Line(),
        deviceName: 'New Phone',
        deviceId: 'phone-abc'
      })

      const { deviceId } = JSON.parse(respText) as { deviceId: string }
      expect(paired(deviceId).relayDeviceId).toBe('phone-abc')
      // The local id still stamps the key line and still identifies the entry — the new field is
      // an addition, not a rename.
      expect(deviceId).not.toBe('phone-abc')
      expect(authKeys()).toContain(`nodeterm-mobile-${deviceId}`)
    } finally {
      service.stop()
    }
  })

  it('falls back to the local id when the phone sent none, so the two coincide', async () => {
    const service = createPairingService()
    try {
      const started = await service.start(() => {})
      const { token, pairPort } = JSON.parse(started.payload) as { token: string; pairPort: number }

      const respText = await post(pairPort, {
        token,
        publicKey: freshEd25519Line(),
        deviceName: 'Quiet Phone'
      })

      const { deviceId } = JSON.parse(respText) as { deviceId: string }
      expect(paired(deviceId).relayDeviceId).toBe(deviceId)
    } finally {
      service.stop()
    }
  })

  it('sends the SAME id to /v1/relay/device that it records, and sends nothing else new', async () => {
    // Computing `phoneDeviceId` earlier (so persistDevice can have it) must not change one byte
    // of the mint body — this pins the whole body, so a reorder that accidentally passed the
    // LOCAL id, or added a field, fails here rather than in production.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ deviceToken: 'device-token', hostId: 'host-id', exp: 0 })
    } as unknown as Response)
    const service = createPairingService(relayDeps())
    try {
      const started = await service.start(() => {})
      const { token, pairPort } = JSON.parse(started.payload) as { token: string; pairPort: number }

      const respText = await post(pairPort, {
        token,
        publicKey: freshEd25519Line(),
        deviceName: 'Relay Phone',
        deviceId: 'phone-relay-1'
      })

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.example/v1/relay/device')
      expect(JSON.parse(String(init.body))).toEqual({
        deviceId: 'phone-relay-1',
        hostDeviceId: 'test-host-device-id',
        hostPublicKeyB64: publicKeyToB64(hostKeys.publicKey),
        label: 'Relay Phone'
      })

      const { deviceId } = JSON.parse(respText) as { deviceId: string }
      expect(paired(deviceId).relayDeviceId).toBe('phone-relay-1')
    } finally {
      service.stop()
    }
  })

  it('refuses a sealed /pair whose epk is a low-order key (a public-constant shared key), pairing nothing', async () => {
    const service = createPairingService(relayDeps())
    try {
      const started = await service.start(() => {})
      const { token, pairPort, hostKey } = JSON.parse(started.payload) as { token: string; pairPort: number; hostKey: string }
      expect(hostKey).toBe(publicKeyToB64(hostKeys.publicKey))
      // Sealed under HSalsa20(0): the key ANY secret derives with a low-order epk — no secret needed.
      const constant = nacl.box.before(new Uint8Array(32), nacl.randomBytes(32))
      const plain = Buffer.from(JSON.stringify({ token, publicKey: freshEd25519Line(), deviceName: 'Weak' }))
      const box = encrypt(Uint8Array.from(plain), constant)
      const text = await post(pairPort, {
        epk: Buffer.from(new Uint8Array(32)).toString('base64'),
        box: Buffer.from(box).toString('base64')
      })
      expect(text).toBe('bad epk')
      expect(devices().map((d) => d.name)).not.toContain('Weak')
    } finally {
      service.stop()
    }
  })
})

describe('pairing names the phone platform-neutrally', () => {
  const nameOf = (id: string): string | undefined =>
    ((agentJson().devices as DeviceEntry[] | undefined) ?? []).find((d) => d.id === id)?.name

  async function pairWith(body: Record<string, unknown>): Promise<string> {
    const service = createPairingService()
    try {
      const started = await service.start(() => {})
      const { token, pairPort } = JSON.parse(started.payload) as { token: string; pairPort: number }
      const respText = await post(pairPort, { token, ...body })
      return (JSON.parse(respText) as { deviceId: string }).deviceId
    } finally {
      service.stop()
    }
  }

  it('an iOS app pairing (no deviceName, nodeterm-ios key) is still listed as iPhone', async () => {
    const deviceId = await pairWith({ publicKey: freshEd25519Line('nodeterm-ios') })
    expect(nameOf(deviceId)).toBe('iPhone')
    // ...and its key is stamped with the NEW comment, not the phone's own one.
    expect(authKeys()).toContain(`nodeterm-mobile-${deviceId}`)
    expect(authKeys()).not.toContain(`nodeterm-ios-${deviceId}`)
  })

  it('an Android pairing keeps the name it sent', async () => {
    const deviceId = await pairWith({
      publicKey: freshEd25519Line('nodeterm-android'),
      deviceName: 'Android'
    })
    expect(nameOf(deviceId)).toBe('Android')
  })

  it('a nameless pairing from an unknown client is "Phone", never "iPhone"', async () => {
    const deviceId = await pairWith({ publicKey: freshEd25519Line('someone@else') })
    expect(nameOf(deviceId)).toBe('Phone')
  })

  it('a hostile multi-line name lands as one capped line', async () => {
    const deviceId = await pairWith({
      publicKey: freshEd25519Line('nodeterm-android'),
      deviceName: `Evil\nName\r\n${'y'.repeat(500)}`
    })
    const stored = nameOf(deviceId) ?? ''
    expect(stored).not.toMatch(/[\r\n]/)
    expect(Array.from(stored).length).toBeLessThanOrEqual(64)
    expect(stored.startsWith('Evil Name y')).toBe(true)
  })
})
