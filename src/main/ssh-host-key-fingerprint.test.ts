// The SSH host-key fingerprints the pairing QR carries (`sshHostKeys`), so the phone can pin this
// host's SSH key at pairing instead of trusting whatever answers its first connect. The format is
// OpenSSH's own `ssh-keygen -lf` spelling, which the iOS and Android apps compare byte for byte.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { testTmpDir } from '../core/test-tmp'
import {
  SSH_HOST_KEY_FILES,
  SSH_HOST_KEYS_MAX,
  readSshHostKeyFingerprints,
  sshHostKeyFingerprint
} from './ssh-host-key-fingerprint'

// Generated with OpenSSH 9.6p1 (`ssh-keygen -t <type> -C root@fixture-host`), fingerprints from
// `ssh-keygen -lf` on the same files.
const ED25519 =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKC7DsD2KJNQX1y60LFjSgttopJTsr4BwfEgjvupmrXR root@fixture-host'
const ED25519_FP = 'SHA256:4hkcemIeUAnjVwt5EwB/CU/rymSk1jz+o5uJWjj16e4'
const ECDSA =
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBJhd3p8HakvNgiR+qUNF83TxfmZGRJJy3GBatE5+pnHb2zo6H2LUcOdA1EI1yYd8Mm+f0iRFpAQakJt/4nH9Lp0= root@fixture-host'
const ECDSA_FP = 'SHA256:KvCpHJYyTp5MLlmTTswZrJdnfnG1ukad9uzDw1PHE8I'
const RSA =
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCpSMA1Kv1A5YZYaZjDQa9nPBUZN46uamTMHc2MRcx5gaCWQGbvsiznifl6KQN0+sCmQMSX4jagJVHPdr9h86l+qycm3+J09BycicV6q/ksON8rZiApjs0qpfQ4YHC0Jlu7rQp9FgErqE6KSLvQsXBDEakusjyXEXeTlwyZaAWLtCvwT1+7n3jw613vVjXgSE5pb1qg8o7xSXgOr+F6nrNGCDysD9mH7e/YiYMQYRSEegYx999RrElXEQNOp8KET8DOoI1qquYbBm3ae4cjkb13fClTw5NFfqxYI9UUDOggPMi3ccnwMuJ68vYHG1eK1/2NqIjyYacFV/AuZYijlQ5FipSg4F3f6hOzb8BDgr1BUb3evEma/BvIvpOZqJWoeQSKgixpNA+o9zfMzs+76V52cf+V2snhQ89kPc7/EZ1WAGqjmIZnItG0iU51559LCXYLD/3pEw8rD77uhN5m2nXyqC6Kly8POcqhsO+lT3U+u0k/kZL+qnToURHTWzFzJj0= root@fixture-host'
const RSA_FP = 'SHA256:13Wz/nq9riSY3UhwCTNTh+tHZoA2v/gMWgsnDt10ySY'

describe('sshHostKeyFingerprint', () => {
  it("matches ssh-keygen -lf for ed25519, ecdsa and rsa", () => {
    expect(sshHostKeyFingerprint(ED25519)).toBe(ED25519_FP)
    expect(sshHostKeyFingerprint(ECDSA)).toBe(ECDSA_FP)
    expect(sshHostKeyFingerprint(RSA)).toBe(RSA_FP)
  })

  it('reads the first key line of a file (a trailing newline, no comment, leading blank lines)', () => {
    expect(sshHostKeyFingerprint(ED25519 + '\n')).toBe(ED25519_FP)
    expect(sshHostKeyFingerprint(ED25519.split(' ').slice(0, 2).join(' '))).toBe(ED25519_FP)
    expect(sshHostKeyFingerprint('\n\n' + ED25519 + '\r\n')).toBe(ED25519_FP)
  })

  it('refuses a blob whose embedded algorithm does not match the line (an ed25519 blob labelled rsa)', () => {
    const blob = ED25519.split(' ')[1]
    expect(sshHostKeyFingerprint(`ssh-rsa ${blob} x`)).toBeNull()
    expect(sshHostKeyFingerprint(`ecdsa-sha2-nistp256 ${RSA.split(' ')[1]}`)).toBeNull()
  })

  it('refuses junk: no blob, non-base64, a truncated blob, a lying length prefix, non-canonical base64', () => {
    expect(sshHostKeyFingerprint('')).toBeNull()
    expect(sshHostKeyFingerprint('ssh-ed25519')).toBeNull()
    expect(sshHostKeyFingerprint('ssh-ed25519 !!!not-base64!!!')).toBeNull()
    expect(sshHostKeyFingerprint('ssh-ed25519 AAAA')).toBeNull()
    const lying = Buffer.concat([Buffer.from([0, 0, 0, 0xff]), Buffer.from('ssh-ed25519')]).toString('base64')
    expect(sshHostKeyFingerprint(`ssh-ed25519 ${lying}`)).toBeNull()
    // Node's decoder would skip the junk and hand back the real blob.
    expect(sshHostKeyFingerprint(`ssh-ed25519 !!${ED25519.split(' ')[1]}`)).toBeNull()
  })
})

/** An in-memory filesystem. A path in `denied` throws EACCES on every access. */
function memFs(files: Record<string, string>, denied: string[] = []) {
  const err = (code: string, p: string) => Object.assign(new Error(`${code}: ${p}`), { code })
  const isDir = (p: string) => Object.keys(files).some((f) => f.startsWith(p.endsWith('/') ? p : p + '/'))
  return {
    readFile: async (p: string) => {
      if (denied.includes(p)) throw err('EACCES', p)
      if (!(p in files)) throw err('ENOENT', p)
      return files[p]
    },
    stat: async (p: string) => {
      if (denied.includes(p)) throw err('EACCES', p)
      if (p in files) return { isFile: () => true }
      if (isDir(p)) return { isFile: () => false }
      throw err('ENOENT', p)
    },
    readdir: async (d: string) => {
      if (denied.includes(d)) throw err('EACCES', d)
      if (!isDir(d)) throw err('ENOENT', d)
      const pre = d.endsWith('/') ? d : d + '/'
      return [...new Set(Object.keys(files).filter((f) => f.startsWith(pre)).map((f) => f.slice(pre.length).split('/')[0]))]
    }
  }
}

const PRIV = 'PRIVATE KEY (never read)'
/** sshd's three default keys, private and public halves. */
const defaults = (): Record<string, string> => ({
  '/etc/ssh/ssh_host_ed25519_key': PRIV,
  '/etc/ssh/ssh_host_ed25519_key.pub': ED25519,
  '/etc/ssh/ssh_host_ecdsa_key': PRIV,
  '/etc/ssh/ssh_host_ecdsa_key.pub': ECDSA,
  '/etc/ssh/ssh_host_rsa_key': PRIV,
  '/etc/ssh/ssh_host_rsa_key.pub': RSA
})
const UBUNTU_CONFIG = 'Include /etc/ssh/sshd_config.d/*.conf\n#HostKey /etc/ssh/ssh_host_rsa_key\nPermitRootLogin no\n'
const read = (files: Record<string, string>, denied: string[] = []) => readSshHostKeyFingerprints(memFs(files, denied))

describe('readSshHostKeyFingerprints — complete or absent, never partial', () => {
  it('a config naming no HostKey: sshd\'s defaults, ordered ed25519, ecdsa, rsa', async () => {
    expect(SSH_HOST_KEY_FILES).toEqual([
      '/etc/ssh/ssh_host_ed25519_key.pub',
      '/etc/ssh/ssh_host_ecdsa_key.pub',
      '/etc/ssh/ssh_host_rsa_key.pub'
    ])
    expect(await read({ '/etc/ssh/sshd_config': UBUNTU_CONFIG, ...defaults() })).toEqual([ED25519_FP, ECDSA_FP, RSA_FP])
  })

  it('a default whose PRIVATE key does not exist is not served, so it is left out (still complete)', async () => {
    const f = defaults()
    delete f['/etc/ssh/ssh_host_ecdsa_key']
    delete f['/etc/ssh/ssh_host_ecdsa_key.pub']
    expect(await read({ '/etc/ssh/sshd_config': UBUNTU_CONFIG, ...f })).toEqual([ED25519_FP, RSA_FP])
  })

  it('a served key whose .pub is missing, unreadable or malformed drops the WHOLE field', async () => {
    const missing = defaults()
    delete missing['/etc/ssh/ssh_host_rsa_key.pub']
    expect(await read({ '/etc/ssh/sshd_config': UBUNTU_CONFIG, ...missing })).toEqual([])
    expect(await read({ '/etc/ssh/sshd_config': UBUNTU_CONFIG, ...defaults() }, ['/etc/ssh/ssh_host_rsa_key.pub'])).toEqual([])
    expect(await read({ '/etc/ssh/sshd_config': UBUNTU_CONFIG, ...defaults(), '/etc/ssh/ssh_host_rsa_key.pub': 'ssh-rsa junk' })).toEqual([])
  })

  it('a private key we cannot even stat (not ENOENT) drops the field: we cannot tell if it is served', async () => {
    expect(await read({ '/etc/ssh/sshd_config': UBUNTU_CONFIG, ...defaults() }, ['/etc/ssh/ssh_host_ecdsa_key'])).toEqual([])
  })

  it('HostKey lines decide the set exactly: the defaults are ignored even when present', async () => {
    const files = {
      '/etc/ssh/sshd_config': 'HostKey /srv/keys/host_rsa\nhostkey=/srv/keys/host_ed\nHostKey "/srv/keys/host_ed" # again\n',
      ...defaults(),
      '/srv/keys/host_rsa': PRIV,
      '/srv/keys/host_rsa.pub': RSA,
      '/srv/keys/host_ed': PRIV,
      '/srv/keys/host_ed.pub': ED25519
    }
    expect(await read(files)).toEqual([ED25519_FP, RSA_FP])
  })

  it('HostKey lines in an Included file count, and a commented one does not', async () => {
    const files = {
      '/etc/ssh/sshd_config': UBUNTU_CONFIG,
      '/etc/ssh/sshd_config.d/10-keys.conf': 'HostKey /srv/keys/host_ed\n',
      '/etc/ssh/sshd_config.d/20-other.txt': 'HostKey /srv/keys/not_included\n', // not *.conf
      '/etc/ssh/sshd_config.d/.hidden.conf': 'HostKey /srv/keys/hidden\n', // glob * skips dotfiles
      ...defaults(),
      '/srv/keys/host_ed': PRIV,
      '/srv/keys/host_ed.pub': ED25519
    }
    expect(await read(files)).toEqual([ED25519_FP])
  })

  it('a relative Include is under /etc/ssh, a missing literal Include is skipped (glob no-match)', async () => {
    const files = {
      '/etc/ssh/sshd_config': 'Include sshd_config.d/keys.conf\nInclude /etc/ssh/absent.conf\n',
      '/etc/ssh/sshd_config.d/keys.conf': 'HostKey /srv/keys/host_ed\n',
      '/srv/keys/host_ed': PRIV,
      '/srv/keys/host_ed.pub': ED25519
    }
    expect(await read(files)).toEqual([ED25519_FP])
  })

  it('config unreadable: the defaults only if ALL three are present and consistent', async () => {
    const denied = ['/etc/ssh/sshd_config']
    expect(await read(defaults(), denied)).toEqual([ED25519_FP, ECDSA_FP, RSA_FP])
    const two = defaults()
    delete two['/etc/ssh/ssh_host_ecdsa_key']
    delete two['/etc/ssh/ssh_host_ecdsa_key.pub']
    expect(await read(two, denied)).toEqual([])
    // An rsa key in the ed25519 file is not "consistent".
    expect(await read({ ...defaults(), '/etc/ssh/ssh_host_ed25519_key.pub': RSA }, denied)).toEqual([])
  })

  it('an Included file we cannot read counts as an unreadable config (strict defaults)', async () => {
    const files: Record<string, string> = {
      '/etc/ssh/sshd_config': UBUNTU_CONFIG,
      '/etc/ssh/sshd_config.d/10-keys.conf': 'HostKey /srv/keys/host_ed\n',
      ...defaults()
    }
    expect(await read(files, ['/etc/ssh/sshd_config.d/10-keys.conf'])).toEqual([ED25519_FP, ECDSA_FP, RSA_FP])
    const two: Record<string, string> = { ...files }
    delete two['/etc/ssh/ssh_host_rsa_key']
    expect(await read(two, ['/etc/ssh/sshd_config.d/10-keys.conf'])).toEqual([])
  })

  it('an Include cycle stops at sshd\'s depth limit and counts as unreadable', async () => {
    const files = { '/etc/ssh/sshd_config': 'Include /etc/ssh/sshd_config\n', ...defaults() }
    expect(await read(files)).toEqual([ED25519_FP, ECDSA_FP, RSA_FP]) // strict defaults, all present
  })

  it('what we cannot model drops the field: HostKeyAgent, a relative or tokenized path, a [glob]', async () => {
    for (const config of [
      'HostKeyAgent /run/agent.sock\n',
      'HostKey ssh_host_ed25519_key\n',
      'HostKey /etc/ssh/%h_key\n',
      'HostKey ~/key\n',
      'Include /etc/ssh/conf.[ab]\n',
      'Include /etc/*/x.conf\n',
      'HostKey "/unterminated\n'
    ]) {
      expect(await read({ '/etc/ssh/sshd_config': config, ...defaults() }), config).toEqual([])
    }
    expect(await read({ '/etc/ssh/sshd_config': 'HostKeyAgent none\n', ...defaults() })).toEqual([ED25519_FP, ECDSA_FP, RSA_FP])
  })

  it(`a host serving more than ${SSH_HOST_KEYS_MAX} keys gets none (a subset could lock the phone out)`, async () => {
    const lines = [ED25519, ECDSA, RSA]
    const files: Record<string, string> = { '/etc/ssh/sshd_config': '' }
    for (let i = 0; i < 5; i++) {
      // Five distinct keys: the three fixtures and two syntactically valid ed25519 lines.
      files['/etc/ssh/sshd_config'] += `HostKey /k/${i}\n`
      files[`/k/${i}`] = PRIV
    }
    files['/k/0.pub'] = lines[0]
    files['/k/1.pub'] = lines[1]
    files['/k/2.pub'] = lines[2]
    files['/k/3.pub'] = edLine(1)
    files['/k/4.pub'] = edLine(2)
    expect(await read(files)).toEqual([])
    delete files['/k/4']
    expect((await read(files)).length).toBe(4)
  })

  it('never throws, whatever the filesystem does', async () => {
    const boom = { readFile: async () => { throw new Error('x') }, stat: async () => { throw new Error('x') }, readdir: async () => { throw new Error('x') } }
    expect(await readSshHostKeyFingerprints(boom)).toEqual([])
  })
})

/** A syntactically valid ed25519 public key line with a fixed fake key (distinct per seed). */
function edLine(seed: number): string {
  const name = Buffer.from('ssh-ed25519')
  const len = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
  return `ssh-ed25519 ${Buffer.concat([len(name.length), name, len(32), Buffer.alloc(32, seed)]).toString('base64')} k`
}

// The fixtures above were checked against ssh-keygen once; this re-checks a FRESH key every run
// where an ssh-keygen exists, so a fixture typo cannot hide a wrong formula.
let sshKeygen = false
try {
  execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' })
  sshKeygen = true
} catch (e) {
  // `ssh-keygen -?` exits non-zero but runs; only a missing binary is ENOENT.
  sshKeygen = (e as NodeJS.ErrnoException).code !== 'ENOENT'
}

describe.skipIf(!sshKeygen || process.platform === 'win32')('against the real ssh-keygen', () => {
  for (const type of ['ed25519', 'ecdsa', 'rsa']) {
    it(`a freshly generated ${type} key`, () => {
      const dir = testTmpDir('nt-sshfp-')
      const key = path.join(dir, `k_${type}`)
      const size = type === 'rsa' ? ['-b', '2048'] : []
      execFileSync('ssh-keygen', ['-q', '-t', type, ...size, '-N', '', '-C', 'test', '-f', key], { stdio: 'ignore' })
      const want = execFileSync('ssh-keygen', ['-lf', `${key}.pub`], { encoding: 'utf8' }).split(' ')[1]
      expect(want).toMatch(/^SHA256:/)
      expect(sshHostKeyFingerprint(readFileSync(`${key}.pub`, 'utf8'))).toBe(want)
    }, 60_000) // key generation (rsa above all) is slow on a loaded CI box
  }
})
