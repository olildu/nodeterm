// A Control link's password, sealed to ONE connection (`WATCH_UNLOCK_CAST`'s sealed form).
//
// Why: the tunnel's keys are not secret from a link holder. Both the host's and the viewer's key pairs
// are derived from the link's secret (./keys.ts), and the session key from those plus two nonces sent
// in the clear, so anyone who holds the link AND a recording of the relay traffic can read every
// connection of it — a password a controller typed included. Sealing the unlock to a key pair that is
// derived from nothing closes that for the password: the host makes a fresh X25519 key pair for each
// viewer connection and offers its public key in that connection's meta (`WatchMeta.unlockKey`), the
// page seals `{ name, password }` with `nacl.box` from a fresh key pair of its own and sends that
// pair's public key beside the box. Neither secret key ever leaves its end, so a recording opens
// nothing.
//
// What it does not do: an ACTIVE attacker holding the link who sits on the relay can still answer the
// page as the host (the host's key pair is derived from the link too) and offer its own key. And what a
// controller TYPES after unlocking rides the tunnel as before: readable to a link holder with a
// recording. docs/live-links.md, "Threat notes".
//
// ISOMORPHIC like the rest of this directory (vendored byte for byte into nodeterm-web).
import nacl from 'tweetnacl'
import { b64ToBytes, bytesToB64, utf8 } from './bytes'

/** An X25519 public key, and the box's nonce (`nacl.box`). */
export const UNLOCK_KEY_BYTES = 32
export const UNLOCK_NONCE_BYTES = 24
/** The longest box the host opens, in base64 characters: a name (32 units) and a password (128 code
 *  points) as JSON, with every character escaped, fit in well under half of it. */
export const SEALED_BOX_B64_MAX = 4096

export interface SealedUnlock {
  /** The page's own one-time public key (base64). */
  key: string
  nonce: string
  /** `nacl.box(JSON { name, password }, nonce, hostKey, pageSecret)`, base64. */
  box: string
}

const exactly = (x: unknown, n: number): Uint8Array | null => {
  if (typeof x !== 'string' || x.length > 64) return null
  const b = b64ToBytes(x)
  return b && b.length === n ? b : null
}

/** A meta's `unlockKey`: 32 bytes of strict base64, or null. */
export function readUnlockKey(x: unknown): Uint8Array | null {
  return exactly(x, UNLOCK_KEY_BYTES)
}

/** The sealed cast argument for `name` and `password`, to `hostKey`. A fresh key pair and nonce each
 *  time: the caller cannot supply either. */
export function sealUnlock(name: string, password: string, hostKey: Uint8Array): { sealed: SealedUnlock } {
  if (!(hostKey instanceof Uint8Array) || hostKey.length !== UNLOCK_KEY_BYTES) throw new Error('An unlock key is 32 bytes.')
  const page = nacl.box.keyPair()
  const nonce = nacl.randomBytes(UNLOCK_NONCE_BYTES)
  const box = nacl.box(utf8(JSON.stringify({ name, password })), nonce, hostKey, page.secretKey)
  page.secretKey.fill(0)
  return { sealed: { key: bytesToB64(page.publicKey), nonce: bytesToB64(nonce), box: bytesToB64(box) } }
}

/**
 * The host's side: `{ name, password }` as the page sent them (not yet sanitized or bounded — the
 * caller's unlock reader does that), or null for anything that is not a sealed unlock this connection's
 * key opens: a missing or malformed field, a box over `SEALED_BOX_B64_MAX`, one that fails to open,
 * JSON that is not an object.
 */
export function openUnlock(arg: unknown, hostSecret: Uint8Array): { name: unknown; password: unknown } | null {
  if (!arg || typeof arg !== 'object') return null
  const sealed = (arg as { sealed?: unknown }).sealed
  if (!sealed || typeof sealed !== 'object') return null
  const s = sealed as Record<string, unknown>
  const key = exactly(s.key, UNLOCK_KEY_BYTES)
  const nonce = exactly(s.nonce, UNLOCK_NONCE_BYTES)
  if (!key || !nonce || typeof s.box !== 'string' || s.box.length > SEALED_BOX_B64_MAX) return null
  const box = b64ToBytes(s.box)
  if (!box) return null
  const plain = nacl.box.open(box, nonce, key, hostSecret)
  if (!plain) return null
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain))
  } catch {
    return null
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const { name, password } = body as Record<string, unknown>
  return { name, password }
}

/** Whether a cast argument is the sealed form (whether or not it opens). */
export function isSealedUnlock(arg: unknown): boolean {
  return !!arg && typeof arg === 'object' && 'sealed' in arg
}
