import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac, randomBytes } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import {
  acceptNewHostKey,
  hostKeyAlgorithmsFor,
  hostPatternsMatch,
  keyTypeOfBlob,
  knownHostsName,
  orderHostKeyAlgorithms,
  recordedHostKeyTypes,
  SSH2_DEFAULT_SERVER_HOST_KEY,
  verifyHostKey
} from './known-hosts'
import { parseSshG, expandHomePath } from './ssh-config'

/** A wire-format public key blob: string keytype, then opaque key material. */
function blob(type: string, fill: number): Buffer {
  const t = Buffer.from(type)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(t.length)
  return Buffer.concat([len, t, Buffer.alloc(32, fill)])
}
const ED_A = blob('ssh-ed25519', 1)
const ED_B = blob('ssh-ed25519', 2)
const RSA = blob('ssh-rsa', 3)
const ECDSA = blob('ecdsa-sha2-nistp256', 4)
const line = (hosts: string, b: Buffer, marker = ''): string =>
  `${marker ? marker + ' ' : ''}${hosts} ${keyTypeOfBlob(b)} ${b.toString('base64')}`
const hashed = (name: string): string => {
  const salt = randomBytes(20)
  return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(name).digest('base64')}`
}

describe('known_hosts matching (OpenSSH semantics)', () => {
  it('names a non-22 port the way ssh records it', () => {
    expect(knownHostsName('h', 22)).toBe('h')
    expect(knownHostsName('h', 2222)).toBe('[h]:2222')
  })

  it('matches plain, wildcard, negated and hashed patterns', () => {
    expect(hostPatternsMatch('a.example,b.example', 'b.example')).toBe(true)
    expect(hostPatternsMatch('*.example', 'x.example')).toBe(true)
    expect(hostPatternsMatch('*.example,!bad.example', 'bad.example')).toBe(false)
    expect(hostPatternsMatch(hashed('[h]:2222'), '[h]:2222')).toBe(true)
    expect(hostPatternsMatch(hashed('[h]:2222'), 'h')).toBe(false)
  })

  it('match / mismatch / unknown / revoked', () => {
    const file = [line('h', ED_A), line(hashed('[k]:22022'), RSA)].join('\n')
    expect(verifyHostKey([file], 'h', ED_A)).toBe('match')
    expect(verifyHostKey([file], 'h', ED_B)).toBe('mismatch')
    // A different key TYPE for a host that already has a recorded key is a mismatch too: the
    // transport offers the recorded types first (hostKeyAlgorithmsFor), so a host that still has
    // its recorded key always presents it — only a host that lost it, or a MITM holding just
    // another type, presents something else.
    expect(verifyHostKey([file], 'h', RSA)).toBe('mismatch')
    expect(verifyHostKey([file], 'other', ED_A)).toBe('unknown')
    expect(verifyHostKey([file], '[k]:22022', RSA)).toBe('match')
    const revoked = [file, line('*', ED_A, '@revoked')].join('\n')
    expect(verifyHostKey([revoked], 'h', ED_A)).toBe('revoked')
  })

  it('ignores @cert-authority lines — they can only leave a host unknown', () => {
    expect(verifyHostKey([line('*', ED_A, '@cert-authority')], 'h', ED_A)).toBe('unknown')
    // ...and they never count as a recorded key that would refuse a first-seen one.
    expect(verifyHostKey([line('*', RSA, '@cert-authority')], 'h', ED_A)).toBe('unknown')
  })

  it('a @revoked line is not a recorded key: another type is still first-seen', () => {
    expect(verifyHostKey([line('h', RSA, '@revoked')], 'h', ED_A)).toBe('unknown')
  })

  it('a host serving several types, each recorded, matches whichever it presents', () => {
    const file = [line('h', ED_A), line('h', RSA)].join('\n')
    expect(verifyHostKey([file], 'h', ED_A)).toBe('match')
    expect(verifyHostKey([file], 'h', RSA)).toBe('match')
    expect(verifyHostKey([file], 'h', ECDSA)).toBe('mismatch')
  })

  it('the recorded keys in a GLOBAL file count as well', () => {
    expect(verifyHostKey(['', line('h', RSA)], 'h', ED_A)).toBe('mismatch')
  })
})

describe('host key algorithm order (OpenSSH order_hostkeyalgs)', () => {
  it("pins ssh2's own default list, so the order we hand it is one it accepts", () => {
    const require = createRequire(import.meta.url)
    const constants = require('ssh2/lib/protocol/constants.js') as { DEFAULT_SERVER_HOST_KEY: string[] }
    expect([...SSH2_DEFAULT_SERVER_HOST_KEY]).toEqual(constants.DEFAULT_SERVER_HOST_KEY)
  })

  it('lists the recorded key types for a host, revoked and CA lines excluded', () => {
    const file = [line('h', RSA), line('h', ECDSA, '@revoked'), line('*', ED_A, '@cert-authority'), line('other', ED_B)].join('\n')
    expect(recordedHostKeyTypes([file], 'h')).toEqual(['ssh-rsa'])
    expect(recordedHostKeyTypes([file], 'nowhere')).toEqual([])
  })

  it('moves the algorithms of the recorded types to the front, keeping the default order otherwise', () => {
    const d = [...SSH2_DEFAULT_SERVER_HOST_KEY]
    expect(orderHostKeyAlgorithms([])).toBeUndefined()
    expect(orderHostKeyAlgorithms(['ssh-rsa'])).toEqual([
      'rsa-sha2-512',
      'rsa-sha2-256',
      'ssh-rsa',
      ...d.filter((a) => !['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'].includes(a))
    ])
    expect(orderHostKeyAlgorithms(['ecdsa-sha2-nistp384', 'ssh-ed25519'])).toEqual([
      'ssh-ed25519',
      'ecdsa-sha2-nistp384',
      ...d.filter((a) => a !== 'ssh-ed25519' && a !== 'ecdsa-sha2-nistp384')
    ])
    // A recorded type no algorithm of ours speaks changes nothing (ssh2 would throw on it).
    expect(orderHostKeyAlgorithms(['ssh-dss'])).toBeUndefined()
    expect(orderHostKeyAlgorithms(['sk-ssh-ed25519@openssh.com'])).toBeUndefined()
    // Nothing is dropped and nothing is added: the same set, reordered.
    expect([...(orderHostKeyAlgorithms(['ssh-rsa']) ?? [])].sort()).toEqual([...d].sort())
  })

  it('reads the policy files for a host:port the way the verifier does', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-kh-order-'))
    try {
      const user = path.join(dir, 'known_hosts')
      fs.writeFileSync(user, line('[h]:2222', ECDSA) + '\n')
      const policy = { userFiles: [user, path.join(dir, 'missing')], globalFiles: [] }
      expect(hostKeyAlgorithmsFor(policy, 'h', 2222)?.[0]).toBe('ecdsa-sha2-nistp256')
      expect(hostKeyAlgorithmsFor(policy, 'h', 22)).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('acceptNewHostKey (StrictHostKeyChecking=accept-new)', () => {
  let dir: string
  let user: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-kh-'))
    user = path.join(dir, 'sub', 'known_hosts')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('records a first-seen host and accepts it; a changed key is then refused', () => {
    const policy = { userFiles: [user], globalFiles: [] }
    expect(acceptNewHostKey(policy, 'h', 2222, ED_A)).toMatchObject({ accept: true, verdict: 'unknown' })
    expect(fs.readFileSync(user, 'utf8')).toBe(`[h]:2222 ssh-ed25519 ${ED_A.toString('base64')}\n`)
    expect(acceptNewHostKey(policy, 'h', 2222, ED_A)).toMatchObject({ accept: true, verdict: 'match' })
    expect(acceptNewHostKey(policy, 'h', 2222, ED_B)).toMatchObject({ accept: false, verdict: 'mismatch' })
  })

  it('refuses a key of ANOTHER type for a recorded host, and records nothing', () => {
    const policy = { userFiles: [user], globalFiles: [] }
    acceptNewHostKey(policy, 'h', 22, ED_A)
    const before = fs.readFileSync(user, 'utf8')
    expect(acceptNewHostKey(policy, 'h', 22, RSA)).toEqual({
      accept: false,
      verdict: 'mismatch',
      presentedType: 'ssh-rsa',
      recordedTypes: ['ssh-ed25519']
    })
    expect(fs.readFileSync(user, 'utf8')).toBe(before)
  })

  it('appends without rewriting what another ssh wrote', () => {
    fs.mkdirSync(path.dirname(user), { recursive: true })
    fs.writeFileSync(user, 'x ssh-ed25519 AAAA') // no trailing newline
    acceptNewHostKey({ userFiles: [user], globalFiles: [] }, 'h', 22, ED_A)
    expect(fs.readFileSync(user, 'utf8').split('\n')).toEqual([
      'x ssh-ed25519 AAAA',
      `h ssh-ed25519 ${ED_A.toString('base64')}`,
      ''
    ])
  })

  it('a global file counts as known', () => {
    const global = path.join(dir, 'global')
    fs.writeFileSync(global, line('h', ED_A) + '\n')
    expect(acceptNewHostKey({ userFiles: [user], globalFiles: [global] }, 'h', 22, ED_B).verdict).toBe('mismatch')
  })
})

describe('parseSshG', () => {
  it('reads the fields the transport needs, expanding ~', () => {
    const out = [
      'user root',
      'hostname 95.217.38.239',
      'port 22',
      'identitiesonly no',
      'stricthostkeychecking ask',
      'identityfile ~/.ssh/id_rsa',
      'identityfile ~/.ssh/id_ed25519',
      'userknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2',
      'globalknownhostsfile /etc/ssh/ssh_known_hosts',
      'proxyjump none',
      'connecttimeout none',
      'identityagent SSH_AUTH_SOCK'
    ].join('\n')
    const r = parseSshG(out, '/home/me')
    expect(r).toMatchObject({
      hostname: '95.217.38.239',
      user: 'root',
      port: 22,
      identitiesOnly: false,
      identityFiles: [path.join('/home/me', '.ssh/id_rsa'), path.join('/home/me', '.ssh/id_ed25519')],
      userKnownHostsFiles: [path.join('/home/me', '.ssh/known_hosts'), path.join('/home/me', '.ssh/known_hosts2')],
      globalKnownHostsFiles: ['/etc/ssh/ssh_known_hosts'],
      identityAgent: 'SSH_AUTH_SOCK'
    })
    expect(r.proxyJump).toBeUndefined()
    expect(r.connectTimeout).toBeUndefined()
  })

  it('refuses output with no host/user', () => {
    expect(() => parseSshG('port 22')).toThrow()
  })

  it('expands a Windows-style home prefix too', () => {
    expect(expandHomePath('~\\.ssh\\id', 'C:\\Users\\me')).toBe(path.join('C:\\Users\\me', '.ssh\\id'))
  })
})
