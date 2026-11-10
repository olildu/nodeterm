// known_hosts for the in-process transport, with the semantics the argv builders ask OpenSSH for:
// `StrictHostKeyChecking=accept-new` — a host never seen before is recorded and accepted; a host
// whose recorded key CHANGED is refused (the MITM case), and so is a key marked @revoked.
//
// A host that has a recorded key is never "first seen" again, whatever key TYPE it presents.
// The transport offers the recorded types first (`hostKeyAlgorithmsFor`, OpenSSH's
// order_hostkeyalgs), so a host that still holds its recorded key always presents it; one that
// presents another type has either dropped that key or is not the host — a MITM that holds only an
// RSA key against a host recorded under ed25519. Recording that key as new (what a type-blind
// accept-new did) let the swap through silently. It is refused like a changed key, with the remedy
// named; this is stricter than OpenSSH's accept-new, which records a new type for a known host.
//
// The file format is OpenSSH's (sshd(8) "SSH_KNOWN_HOSTS FILE FORMAT"), read from the same files
// `ssh -G` reports (userknownhostsfile + globalknownhostsfile), so a host the user already trusts
// with their own ssh is trusted here, and one we record is trusted by their ssh too:
//   [@marker] host-patterns keytype base64-key [comment]
// Host patterns are comma-separated; `[host]:port` for a non-22 port; `*`/`?` wildcards; `!`
// negation; `|1|salt|hmac` for HashKnownHosts entries (HMAC-SHA1 of the name, keyed by the salt).
// @cert-authority lines are ignored (the native transport does not do host certificates), which
// can only make a host look UNKNOWN, never trusted.

import { createHmac } from 'crypto'
import fs from 'fs'
import path from 'path'

export type HostKeyVerdict = 'match' | 'mismatch' | 'revoked' | 'unknown'

/** The key type out of an ssh wire-format public key blob (`string keytype` comes first). */
export function keyTypeOfBlob(blob: Buffer): string | null {
  if (blob.length < 4) return null
  const n = blob.readUInt32BE(0)
  if (n <= 0 || 4 + n > blob.length || n > 64) return null
  return blob.subarray(4, 4 + n).toString('latin1')
}

/** The name a host is looked up under: bare for port 22, `[host]:port` otherwise. */
export function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

function globMatch(pattern: string, name: string): boolean {
  let re = '^'
  for (const ch of pattern) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(re + '$', 'i').test(name)
}

function hashedMatch(entry: string, name: string): boolean {
  // |1|base64(salt)|base64(hmac-sha1(salt, name))
  // HMAC-SHA1 is not our choice: it is what OpenSSH's HashKnownHosts writes, and we only READ the
  // user's existing entries — any other algorithm could never match them. The input is a host name
  // (the hash only hides it from someone reading the file), not a secret. CodeQL's weak-crypto
  // alert on this line was reviewed and dismissed as a false positive for that reason.
  const parts = entry.split('|')
  if (parts.length !== 4 || parts[1] !== '1') return false
  try {
    const salt = Buffer.from(parts[2], 'base64')
    const want = Buffer.from(parts[3], 'base64')
    const got = createHmac('sha1', salt).update(name).digest()
    return got.length === want.length && got.equals(want)
  } catch {
    return false
  }
}

/** Whether a host-patterns field matches `name` (a negated match anywhere wins, as in OpenSSH). */
export function hostPatternsMatch(field: string, name: string): boolean {
  if (field.startsWith('|')) return hashedMatch(field, name)
  let hit = false
  for (const raw of field.split(',')) {
    if (!raw) continue
    const neg = raw.startsWith('!')
    const pat = neg ? raw.slice(1) : raw
    if (globMatch(pat, name)) {
      if (neg) return false
      hit = true
    }
  }
  return hit
}

interface Entry {
  marker?: string
  hosts: string
  keyType: string
  key: Buffer
}

export function parseKnownHosts(text: string): Entry[] {
  const out: Entry[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const f = line.split(/\s+/)
    let i = 0
    let marker: string | undefined
    if (f[0].startsWith('@')) marker = f[i++]
    const hosts = f[i++]
    const keyType = f[i++]
    const b64 = f[i++]
    if (!hosts || !keyType || !b64) continue
    let key: Buffer
    try {
      key = Buffer.from(b64, 'base64')
    } catch {
      continue
    }
    if (key.length === 0) continue
    out.push({ marker, hosts, keyType, key })
  }
  return out
}

/**
 * The key types recorded for `name` across all files, in file order, deduplicated. @revoked and
 * @cert-authority lines are not recorded keys: a revoked key says which key to refuse, and the
 * native transport does not do host certificates.
 */
export function recordedHostKeyTypes(texts: string[], name: string): string[] {
  const types: string[] = []
  for (const text of texts) {
    for (const e of parseKnownHosts(text)) {
      if (e.marker === '@cert-authority' || e.marker === '@revoked') continue
      if (!hostPatternsMatch(e.hosts, name)) continue
      if (!types.includes(e.keyType)) types.push(e.keyType)
    }
  }
  return types
}

/**
 * The verdict for `blob` presented by `name` (already in knownHostsName form), across all files.
 * Order of precedence follows OpenSSH: a matching @revoked key refuses; a matching key accepts;
 * otherwise, a host with ANY recorded key is a mismatch — the same type with different bytes (a
 * changed key) and another type alike (see the file header); only a host with no recorded key at
 * all is unknown.
 */
export function verifyHostKey(texts: string[], name: string, blob: Buffer): HostKeyVerdict {
  let recorded = false
  let matched = false
  for (const text of texts) {
    for (const e of parseKnownHosts(text)) {
      if (e.marker === '@cert-authority') continue
      if (!hostPatternsMatch(e.hosts, name)) continue
      if (e.marker === '@revoked') {
        if (e.key.equals(blob)) return 'revoked'
        continue
      }
      recorded = true
      if (e.key.equals(blob)) matched = true
    }
  }
  if (matched) return 'match'
  return recorded ? 'mismatch' : 'unknown'
}

/**
 * ssh2 1.17's own default server host key algorithms, in its order (pinned against the package by
 * known-hosts.test.ts). The list handed to ssh2 is always a reordering of exactly these: an exact
 * list naming anything ssh2 does not support makes `connect()` throw.
 */
export const SSH2_DEFAULT_SERVER_HOST_KEY = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa'
] as const

/** The known_hosts KEY type an algorithm's key is recorded under: RSA's SHA-2 signature
 *  algorithms all use an `ssh-rsa` key; every other algorithm is named after its key type. */
function keyTypeOfAlgorithm(alg: string): string {
  return alg === 'rsa-sha2-512' || alg === 'rsa-sha2-256' ? 'ssh-rsa' : alg
}

/**
 * OpenSSH's order_hostkeyalgs over ssh2's defaults: the algorithms whose key type is recorded for
 * the host first, everything else after, each half in the default order. `undefined` (= ssh2's
 * default) when nothing recorded maps to an algorithm we offer — a host recorded only under
 * `ssh-dss` or a security-key type keeps the default order, and the verifier still refuses the
 * key it then presents.
 */
export function orderHostKeyAlgorithms(recordedTypes: string[]): string[] | undefined {
  const first: string[] = []
  const last: string[] = []
  for (const alg of SSH2_DEFAULT_SERVER_HOST_KEY) {
    ;(recordedTypes.includes(keyTypeOfAlgorithm(alg)) ? first : last).push(alg)
  }
  return first.length ? [...first, ...last] : undefined
}

function readIfPresent(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** The line `accept-new` appends for a first-seen host. */
export function knownHostsLine(name: string, blob: Buffer): string | null {
  const type = keyTypeOfBlob(blob)
  if (!type) return null
  return `${name} ${type} ${blob.toString('base64')}`
}

export interface HostKeyPolicy {
  userFiles: string[]
  globalFiles: string[]
}

/** The `algorithms.serverHostKey` list for a connection to `host:port`, or undefined for ssh2's
 *  default. Read from the same files, under the same name, the verifier reads. */
export function hostKeyAlgorithmsFor(policy: HostKeyPolicy, host: string, port: number): string[] | undefined {
  const texts = [...policy.userFiles, ...policy.globalFiles].map(readIfPresent)
  return orderHostKeyAlgorithms(recordedHostKeyTypes(texts, knownHostsName(host, port)))
}

export interface HostKeyDecision {
  accept: boolean
  verdict: HostKeyVerdict
  /** The presented key's type, and the types on record for the host — so a refusal can say
   *  "recorded ssh-ed25519, presented ssh-rsa" instead of only "changed". */
  presentedType?: string
  recordedTypes?: string[]
}

/**
 * The accept-new decision, with the file side effects: an unknown key is appended to the FIRST
 * user known_hosts file (created with its directory, 0600/0700 — ssh's own modes) and accepted;
 * a match accepts; mismatch / revoked refuse. Returns the verdict that decided it so the caller
 * can name the reason in the connection error.
 */
export function acceptNewHostKey(
  policy: HostKeyPolicy,
  host: string,
  port: number,
  blob: Buffer
): HostKeyDecision {
  const name = knownHostsName(host, port)
  const texts = [...policy.userFiles, ...policy.globalFiles].map(readIfPresent)
  const verdict = verifyHostKey(texts, name, blob)
  if (verdict === 'match') return { accept: true, verdict }
  if (verdict === 'mismatch') {
    return {
      accept: false,
      verdict,
      presentedType: keyTypeOfBlob(blob) ?? 'unknown',
      recordedTypes: recordedHostKeyTypes(texts, name)
    }
  }
  if (verdict !== 'unknown') return { accept: false, verdict }
  const line = knownHostsLine(name, blob)
  const file = policy.userFiles[0]
  if (!line || !file) return { accept: false, verdict }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const existing = readIfPresent(file)
    const sep = existing && !existing.endsWith('\n') ? '\n' : ''
    // An append, not a rewrite: other ssh processes read and append to this file concurrently,
    // and replacing it would lose a line one of them wrote in between.
    fs.appendFileSync(file, `${sep}${line}\n`, { mode: 0o600 })
  } catch {
    // Could not record it. OpenSSH's accept-new warns ("Failed to add the host to the list of
    // known hosts") and connects anyway; the transport must mean the same thing, so it does too —
    // the next connection simply asks again.
  }
  return { accept: true, verdict }
}

/** The refusal sentence for a mismatch: OpenSSH's banner (callers and users match on it), plus
 *  what differed and the remedy when the TYPE changed — a rotation the user must confirm. */
export function hostKeyMismatchMessage(knownAs: string, port: number, d: HostKeyDecision): string {
  const head = `@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@ Host key verification failed for ${knownAs}.`
  const recorded = d.recordedTypes ?? []
  if (!d.presentedType || !recorded.length || recorded.includes(d.presentedType)) return head
  return (
    `${head} known_hosts records a ${recorded.join(' / ')} key for this host, and it presented a ` +
    `${d.presentedType} key instead. If the host's keys really changed, remove the old entry ` +
    `(ssh-keygen -R ${knownHostsName(knownAs, port)}) and connect again.`
  )
}
