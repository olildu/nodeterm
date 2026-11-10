// End-to-end encryption primitives for the relay transport.
//
// Pure functions over NaCl box (Curve25519 + XSalsa20-Poly1305): no sockets, no
// Electron. The box format is `nonce ‖ ciphertext ‖ mac` so an interoperable peer
// can be implemented against the same wire format.
import { hkdfSync } from 'node:crypto'
import nacl from 'tweetnacl'

export type KeyPair = {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export function genKeyPair(): KeyPair {
  return nacl.box.keyPair()
}

export function publicKeyToB64(key: Uint8Array): string {
  return Buffer.from(key).toString('base64')
}

/**
 * Decode base64 that must be in CANONICAL form: standard alphabet, padded, nothing else. Node's
 * `Buffer.from(x, 'base64')` skips every character outside the alphabet and ignores trailing junk,
 * so `"!!!" + key`, `key + "====junk"` or a key with a Cyrillic letter in front all decode to the
 * real key — a visibly different string standing for the same identity. And the relay compares keys
 * as STRINGS (pin stores, team.json, autoApprove), so a second spelling of one key is also a key
 * that matches none of its own pins. One key, one spelling: the decoded bytes must re-encode to the
 * exact input.
 *
 * Padding is REQUIRED (an unpadded key is refused): every producer pads — the desktop and server
 * (`Buffer#toString('base64')`), iOS (`base64EncodedString()`), Android (`java.util.Base64`) and
 * the web viewer (`bytesToB64`) — so accepting the unpadded form would only add a second spelling.
 * The length is checked before decoding, so a megabyte of junk is refused without being decoded.
 */
export function canonicalB64ToBytes(b64: unknown, bytes: number, what: string): Uint8Array {
  if (typeof b64 !== 'string') throw new Error(`Invalid ${what}: not a string`)
  if (b64.length !== 4 * Math.ceil(bytes / 3)) {
    throw new Error(`Invalid ${what}: expected ${bytes} bytes of canonical base64`)
  }
  const out = Buffer.from(b64, 'base64')
  if (out.length !== bytes) {
    throw new Error(`Invalid ${what}: expected ${bytes} bytes, got ${out.length}`)
  }
  if (out.toString('base64') !== b64) throw new Error(`Invalid ${what}: not canonical base64`)
  return Uint8Array.from(out)
}

export function publicKeyFromB64(b64: string): Uint8Array {
  return canonicalB64ToBytes(b64, nacl.box.publicKeyLength, 'public key')
}

/**
 * A PEER's public key is refused when it is a low-order X25519 point. With one, the X25519 output
 * is all zero whatever our secret is, so `box.before` = HSalsa20(0) is a PUBLIC CONSTANT: both
 * humans then read the same fixed SAS ("357 836" under v1), a secret-less peer completes the
 * handshake, and anyone on the wire derives the session key from the two plaintext nonces. RFC 7748
 * §6.1; relay-pop.ts refuses the same degenerate secret for the PoP. Thrown with a stable `code`.
 */
export class WeakPeerKeyError extends Error {
  readonly code = 'E_WEAK_PEER_KEY'
  constructor() {
    super(
      'Refused a low-order X25519 public key: with it the shared secret would be a public constant, ' +
        'so the connection could be read by anyone. The code or key is corrupt or was tampered with.'
    )
    this.name = 'WeakPeerKeyError'
  }
}

/** True when every byte is zero. Reads every byte (no early exit). */
function allZero(b: Uint8Array): boolean {
  let acc = 0
  for (let i = 0; i < b.length; i++) acc |= b[i]
  return acc === 0
}

// X25519 clamps every scalar to a multiple of 8 below the prime-order subgroup's order, so ANY
// scalar sends a point of order dividing 8 (and only such a point) to zero. A fixed probe therefore
// answers "is this key low-order?" with no secret — for the intakes that have none at hand (a join
// code, a pairing offer, a pin store).
const LOW_ORDER_PROBE = new Uint8Array(32).fill(0x5a)

/** Is this 32-byte X25519 public key a low-order point (any of its encodings)? */
export function isLowOrderPublicKey(pub: Uint8Array): boolean {
  if (pub.length !== nacl.box.publicKeyLength) return false
  return allZero(nacl.scalarMult(LOW_ORDER_PROBE, pub))
}

/** A peer's public key from canonical base64, refusing a low-order point (`WeakPeerKeyError`). */
export function peerPublicKeyFromB64(b64: string): Uint8Array {
  const key = publicKeyFromB64(b64)
  if (isLowOrderPublicKey(key)) throw new WeakPeerKeyError()
  return key
}

/** True for a string that is a usable PEER key: canonical base64 of 32 bytes, not low-order. */
export function isUsablePeerKeyB64(b64: unknown): boolean {
  try {
    peerPublicKeyFromB64(b64 as string)
    return true
  } catch {
    return false
  }
}

// Same strictness for a secret key: `Buffer.from(x, 'base64')` silently drops non-alphabet
// characters and truncates, so a corrupt/short blob would otherwise decode to a short-but-accepted
// key that only blows up ("bad secret key size") deep inside a later nacl.box call.
export function secretKeyFromB64(b64: string): Uint8Array {
  const key = Uint8Array.from(Buffer.from(b64, 'base64'))
  if (key.length !== nacl.box.secretKeyLength) {
    throw new Error(`Invalid secret key: expected ${nacl.box.secretKeyLength} bytes, got ${key.length}`)
  }
  return key
}

// Derive the shared secret (ECDH precompute) from the peer's base64 public key
// and our secret key. Both sides arrive at the same value. This is the STABLE
// per-device-pair key (both endpoints use static keys for pin-once), so it must
// NOT be used directly to encrypt traffic — see deriveSessionKey.
//
// REFUSES a low-order peer key (`WeakPeerKeyError`), checked on the RAW X25519 output — the input
// to HSalsa20, which is where a low-order key shows up as all zero; `box.before`'s own output never
// is. Every relay handshake (both roles) and the /pair envelope derive through here, so this is the
// one choke point the intakes upstream (join code, pairing offer, pins) are belts to.
export function deriveSharedKey(theirPubB64: string, ourSecret: Uint8Array): Uint8Array {
  const theirPub = publicKeyFromB64(theirPubB64)
  const raw = nacl.scalarMult(ourSecret, theirPub)
  if (allZero(raw)) throw new WeakPeerKeyError()
  // `box.before` is exactly scalarMult then HSalsa20(key = raw, input = 16 zero bytes, sigma); doing
  // the second half here spares a second X25519 (~ms in tweetnacl's pure JS). e2ee.test.ts pins the
  // output against `nacl.box.before` and a fixed end-to-end vector.
  const out = new Uint8Array(32)
  lowlevel.crypto_core_hsalsa20(out, HSALSA_ZERO, raw, SIGMA)
  return out
}

// tweetnacl's d.ts does not declare `lowlevel`; it is the library's documented low-level export.
const lowlevel = (nacl as unknown as {
  lowlevel: { crypto_core_hsalsa20(out: Uint8Array, inp: Uint8Array, k: Uint8Array, c: Uint8Array): number }
}).lowlevel
const HSALSA_ZERO = new Uint8Array(16)
const SIGMA = new TextEncoder().encode('expand 32-byte k')

// A fresh 16-byte session nonce, exchanged in the handshake.
export function randomSessionNonce(): Uint8Array {
  return nacl.randomBytes(16)
}

// Per-SESSION traffic key = HKDF-SHA256(baseShared, salt = hostNonce ‖ clientNonce).
// Because both endpoints hold STATIC keys (stable pin-once identity), the raw ECDH
// `baseShared` is identical on every reconnect — encrypting with it lets a malicious
// relay replay a whole recorded session's boxes against a fresh connection (the seq
// counter resets per connection, so it can't stop this). Mixing in fresh per-session
// nonces makes the traffic key unique to each session, so recorded boxes never decrypt
// under a later session's key. RFC 5869 HKDF; matches iOS CryptoKit HKDF<SHA256>.
export function deriveSessionKey(
  baseShared: Uint8Array,
  hostNonce: Uint8Array,
  clientNonce: Uint8Array
): Uint8Array {
  const salt = new Uint8Array(hostNonce.length + clientNonce.length)
  salt.set(hostNonce)
  salt.set(clientNonce, hostNonce.length)
  const info = new TextEncoder().encode('nodeterm-relay-session-v2')
  const out = hkdfSync('sha256', baseShared, salt, info, 32)
  return new Uint8Array(out)
}

// Encrypt with the precomputed shared key. Returns `nonce ‖ ciphertext ‖ mac`.
export function encrypt(plain: Uint8Array, shared: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const ciphertext = nacl.box.after(plain, nonce, shared)

  const box = new Uint8Array(nonce.length + ciphertext.length)
  box.set(nonce)
  box.set(ciphertext, nonce.length)
  return box
}

// Short Authentication String (v2): a 10-digit code derived from the ECDH shared key. Both peers
// compute the SAME value (same shared key), so the two humans can compare it out of band to confirm
// they are on the same channel before anything opens. Formatted "NNN NNN NNNN":
//
//   h = SHA-512(shared)
//   a = BE_u32(h[0..4]) mod 1_000_000      // the v1 code
//   b = BE_u32(h[4..8]) mod 10_000         // four more digits
//   SAS = pad6(a)[0..3] + " " + pad6(a)[3..6] + " " + pad4(b)
//
// v1 was the first six digits alone: ~20 bits, which an attacker who substitutes a pinned key (a
// tampered offer, join code or QR) can grind to a match on both legs in seconds. v2 is ~33 bits.
// The first seven characters ARE the v1 code, so a peer still on v1 (six digits) is compared on the
// first six — the copy under every SAS says so (SAS_COMPARE_HINT). The iOS and Android apps compute
// the same bytes; the vectors are in e2ee.test.ts and docs/ios-protocol-migration.md §3.1.
export function sasFromSharedKey(shared: Uint8Array): string {
  const h = nacl.hash(shared) // SHA-512
  const a = (((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0) % 1_000_000
  const b = (((h[4] << 24) | (h[5] << 16) | (h[6] << 8) | h[7]) >>> 0) % 10_000
  const six = a.toString().padStart(6, '0')
  const four = b.toString().padStart(4, '0')
  return `${six.slice(0, 3)} ${six.slice(3)} ${four}`
}

// Decrypt a `nonce ‖ ciphertext ‖ mac` box. Returns null on malformed input or
// a failed MAC check — never throws.
export function decrypt(box: Uint8Array, shared: Uint8Array): Uint8Array | null {
  if (box.length < nacl.box.nonceLength + nacl.box.overheadLength) {
    return null
  }
  const nonce = box.slice(0, nacl.box.nonceLength)
  const ciphertext = box.slice(nacl.box.nonceLength)
  const plain = nacl.box.open.after(ciphertext, nonce, shared)
  return plain ?? null
}
