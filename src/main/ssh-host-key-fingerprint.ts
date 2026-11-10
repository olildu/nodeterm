// SSH host-key fingerprints for the phone-pairing QR (`sshHostKeys`, pairing-core.ts).
//
// Why: the phone pins this host's SSH key trust-on-first-use, and pairing used to DROP any existing
// pin, so the phone's first SSH connect after pairing trusted whatever answered on port 22. An
// attacker on the LAN at that moment could then serve a forged ~/.nodeterm/agent.json (the phone
// would E2EE its agent traffic to the attacker's key) or a forged ~/.nodeterm/relay.json (adopted
// as the relay identity). The QR is on this host's own screen — the same trust basis as its
// `hostKey` — so carrying the fingerprints there lets the phone refuse a first connect whose key is
// not one of them.
//
// Format: OpenSSH's own `ssh-keygen -lf` spelling, `SHA256:<standard base64 of sha256(keyBlob),
// trailing '=' removed>`, which the phones compare byte for byte. keyBlob is the base64-decoded
// second field of the .pub line. A line whose blob names a different algorithm than its first field
// is refused (a mislabelled or tampered file), and so is non-canonical base64.
//
// COMPLETE OR ABSENT — never a partial list. The phones REFUSE an SSH connect whose host key is not
// in the QR set, and sshd presents whichever of its keys the client's algorithm preference picks,
// so a list missing one key sshd serves locks the phone out of this host until a corrected QR is
// scanned. Every doubt therefore drops the field, and the phone falls back to today's TOFU:
//   - sshd's own configuration decides the set: the `HostKey` paths in /etc/ssh/sshd_config and the
//     files it `Include`s (globs in the file name only, relative paths under /etc/ssh, at most 16
//     levels, like sshd). No `HostKey` anywhere = sshd's defaults (rsa, ecdsa, ed25519).
//   - a key sshd would serve is one whose PRIVATE file exists (stat only — it is never read; sshd
//     skips a HostKey it cannot find). Its `.pub` must then read and parse, or the field is dropped.
//   - when the configuration (or a file it includes) cannot be read, the defaults are used only if
//     all three are present (private and `.pub`) and consistent (each `.pub` holds its file's
//     algorithm); otherwise the field is dropped. A HostKey hidden in an unreadable configuration is
//     the residual risk of that fallback.
//   - `HostKeyAgent`, a non-absolute or tokenized (`%`, `~`) HostKey path, a glob form we do not
//     implement, or more than SSH_HOST_KEYS_MAX keys: dropped.
// A superset is harmless (a fingerprint the server never presents just goes unused).
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** sshd's default host keys (used when the configuration names none), in QR order. */
export const SSHD_DEFAULT_HOST_KEYS = [
  '/etc/ssh/ssh_host_ed25519_key',
  '/etc/ssh/ssh_host_ecdsa_key',
  '/etc/ssh/ssh_host_rsa_key'
] as const

/** The public halves of the defaults: ed25519, ecdsa, rsa. */
export const SSH_HOST_KEY_FILES: readonly string[] = SSHD_DEFAULT_HOST_KEYS.map((k) => `${k}.pub`)

export const SSHD_CONFIG = '/etc/ssh/sshd_config'

/** The QR carries at most this many fingerprints. A host serving more gets none (never a subset). */
export const SSH_HOST_KEYS_MAX = 4

/** The one shape a fingerprint has on the wire: sha256 = 32 bytes = 43 base64 chars unpadded. */
export const SSH_HOST_KEY_FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/

/** sshd's own include depth limit (SERVCONF_MAX_DEPTH). */
const MAX_INCLUDE_DEPTH = 16

interface ParsedKey {
  algo: string
  fingerprint: string
}

function parseKeyLine(text: string): ParsedKey | null {
  if (typeof text !== 'string') return null
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'))
  if (!line) return null
  const [algo, b64] = line.split(/\s+/)
  if (!algo || !b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null
  const blob = Buffer.from(b64, 'base64')
  // One spelling per key: Node's decoder ignores what it cannot read, so re-encode and compare.
  if (blob.toString('base64') !== b64) return null
  // OpenSSH wire format: a uint32 length-prefixed algorithm name comes first.
  if (blob.length < 4) return null
  const nameLen = blob.readUInt32BE(0)
  if (nameLen === 0 || 4 + nameLen >= blob.length) return null
  if (blob.subarray(4, 4 + nameLen).toString('latin1') !== algo) return null
  return { algo, fingerprint: 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '') }
}

/** A public key line's fingerprint, or null when it is not a well-formed OpenSSH public key. */
export function sshHostKeyFingerprint(text: string): string | null {
  return parseKeyLine(text)?.fingerprint ?? null
}

type Family = 'ed25519' | 'ecdsa' | 'rsa' | 'other'
function familyOf(algo: string): Family {
  if (algo === 'ssh-ed25519') return 'ed25519'
  if (algo.startsWith('ecdsa-sha2-')) return 'ecdsa'
  if (algo === 'ssh-rsa') return 'rsa'
  return 'other'
}
const FAMILY_RANK: Record<Family, number> = { ed25519: 0, ecdsa: 1, rsa: 2, other: 3 }
/** The family a DEFAULT key file must hold (the defaults' consistency check), or null. */
function defaultFamily(privatePath: string): Family | null {
  const m = /\/ssh_host_(ed25519|ecdsa|rsa)_key$/.exec(privatePath)
  return m ? (m[1] as Family) : null
}

/** The filesystem the reader needs (injected in tests). `stat` THROWS for a missing path (ENOENT)
 *  and for any other failure, exactly like fs.promises.stat. */
export interface HostKeyFs {
  readFile(file: string): Promise<string>
  stat(file: string): Promise<{ isFile(): boolean }>
  readdir(dir: string): Promise<string[]>
}

const nodeFs: HostKeyFs = {
  readFile: (file) => fs.readFile(file, 'utf8'),
  stat: (file) => fs.stat(file),
  readdir: (dir) => fs.readdir(dir)
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code

/** What sshd's configuration says about host keys. */
type ConfigVerdict =
  | { kind: 'keys'; paths: string[] } // HostKey paths, possibly none (= sshd's defaults)
  | { kind: 'unreadable' } // the config or an Include could not be read: strict defaults
  | { kind: 'unsupported' } // something we cannot model: no list

class Unreadable extends Error {}
class Unsupported extends Error {}

/** One sshd_config line as tokens: whitespace or one `=` after the keyword separates, double quotes
 *  group, and a token that starts with `#` ends the line (sshd's argv_split). */
function tokens(line: string): string[] {
  const out: string[] = []
  const s = line.replace(/\f/g, ' ')
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break
    if (out.length === 1 && s[i] === '=') {
      i++
      continue
    }
    if (s[i] === '#') break
    let tok = ''
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1)
      if (end < 0) throw new Unsupported('unbalanced quote')
      tok = s.slice(i + 1, end)
      i = end + 1
    } else {
      while (i < s.length && !/\s/.test(s[i]) && !(out.length === 0 && s[i] === '=')) tok += s[i++]
    }
    out.push(tok)
  }
  return out
}

function globToRegExp(pattern: string): RegExp {
  let re = '^'
  for (const c of pattern) {
    if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(re + '$')
}

/** The files one `Include` argument names, as sshd's glob(3) would (sorted, no dotfiles for `*`). */
async function includeTargets(io: HostKeyFs, arg: string, baseDir: string): Promise<string[]> {
  const abs = path.isAbsolute(arg) ? arg : path.join(baseDir, arg)
  const dir = path.dirname(abs)
  const name = path.basename(abs)
  if (/[*?[\]{}]/.test(dir) || /[[\]{}]/.test(name)) throw new Unsupported('glob form')
  if (!/[*?]/.test(name)) {
    // A literal path that does not exist is glob's "no match": sshd skips it.
    try {
      await io.stat(abs)
    } catch (e) {
      if (errCode(e) === 'ENOENT') return []
      throw new Unreadable(abs)
    }
    return [abs]
  }
  let names: string[]
  try {
    names = await io.readdir(dir)
  } catch (e) {
    if (errCode(e) === 'ENOENT') return []
    throw new Unreadable(dir)
  }
  const re = globToRegExp(name)
  return names
    .filter((n) => re.test(n) && (!n.startsWith('.') || name.startsWith('.')))
    .sort()
    .map((n) => path.join(dir, n))
}

async function collectHostKeys(io: HostKeyFs, file: string, baseDir: string, depth: number, acc: string[]): Promise<void> {
  if (depth > MAX_INCLUDE_DEPTH) throw new Unreadable('include depth')
  let text: string
  try {
    text = await io.readFile(file)
  } catch {
    throw new Unreadable(file)
  }
  for (const raw of text.split(/\r?\n/)) {
    const t = tokens(raw)
    if (t.length === 0) continue
    const key = t[0].toLowerCase()
    if (key === 'include') {
      for (const arg of t.slice(1)) {
        for (const target of await includeTargets(io, arg, baseDir)) {
          await collectHostKeys(io, target, baseDir, depth + 1, acc)
        }
      }
    } else if (key === 'hostkeyagent') {
      // Keys served from an agent are not files we can read: no complete list.
      if ((t[1] ?? '').toLowerCase() !== 'none') throw new Unsupported('HostKeyAgent')
    } else if (key === 'hostkey') {
      const p = t[1]
      if (!p || !path.isAbsolute(p) || /[%~]/.test(p)) throw new Unsupported('HostKey path')
      if (!acc.includes(p)) acc.push(p)
    }
  }
}

async function readConfig(io: HostKeyFs, configPath: string): Promise<ConfigVerdict> {
  const acc: string[] = []
  try {
    await collectHostKeys(io, configPath, path.dirname(configPath), 0, acc)
    return { kind: 'keys', paths: acc }
  } catch (e) {
    return e instanceof Unreadable ? { kind: 'unreadable' } : { kind: 'unsupported' }
  }
}

/** One key's public half, or 'skip' (sshd does not serve it: no private file), or 'fail'. */
async function servedKey(io: HostKeyFs, privatePath: string): Promise<ParsedKey | 'skip' | 'fail'> {
  try {
    if (!(await io.stat(privatePath)).isFile()) return 'fail'
  } catch (e) {
    return errCode(e) === 'ENOENT' ? 'skip' : 'fail'
  }
  let text: string
  try {
    text = await io.readFile(`${privatePath}.pub`)
  } catch {
    return 'fail'
  }
  const parsed = parseKeyLine(text)
  if (!parsed) return 'fail'
  const want = defaultFamily(privatePath)
  if (want && familyOf(parsed.algo) !== want) return 'fail'
  return parsed
}

/**
 * This host's SSH host-key fingerprints — COMPLETE (every key sshd would serve) or [] (see the
 * header). Ordered ed25519, ecdsa, rsa, others; distinct; at most SSH_HOST_KEYS_MAX. Never throws.
 */
export async function readSshHostKeyFingerprints(io: HostKeyFs = nodeFs, configPath: string = SSHD_CONFIG): Promise<string[]> {
  try {
    const config = await readConfig(io, configPath)
    if (config.kind === 'unsupported') return []
    const strict = config.kind === 'unreadable'
    const paths = config.kind === 'keys' && config.paths.length > 0 ? config.paths : [...SSHD_DEFAULT_HOST_KEYS]
    const keys: ParsedKey[] = []
    for (const p of paths) {
      const k = await servedKey(io, p)
      if (k === 'fail') return []
      if (k === 'skip') {
        // With the configuration unreadable, a missing default could mean sshd is configured with
        // a key elsewhere: the defaults must ALL be there.
        if (strict) return []
        continue
      }
      keys.push(k)
    }
    const out: string[] = []
    for (const k of [...keys].sort((a, b) => FAMILY_RANK[familyOf(a.algo)] - FAMILY_RANK[familyOf(b.algo)])) {
      if (!out.includes(k.fingerprint)) out.push(k.fingerprint)
    }
    return out.length > SSH_HOST_KEYS_MAX ? [] : out
  } catch {
    return []
  }
}
