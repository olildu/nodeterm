// The relay's key-intake and SAS rules (src/core/relay/e2ee.ts). Three properties, each a security
// finding fixed in one place:
//   - a LOW-ORDER X25519 peer key is refused: with one the shared secret is a public constant, so
//     both humans would read the same fixed SAS and anyone on the wire derives the session key;
//   - a key or nonce is accepted only in CANONICAL base64: Node's decoder skips junk characters, so
//     a visibly different string would otherwise decode to the same key;
//   - the SAS is v2 (6 + 4 digits), whose first seven characters are the v1 code, so an older peer
//     showing six digits can still be compared.
import { describe, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import {
  WeakPeerKeyError,
  deriveSharedKey,
  genKeyPair,
  isLowOrderPublicKey,
  peerPublicKeyFromB64,
  publicKeyFromB64,
  publicKeyToB64,
  sasFromSharedKey
} from './e2ee'
import { lowOrderKeys } from './low-order-keys.test-support'

const b64 = (k: Uint8Array): string => Buffer.from(k).toString('base64')

/** The v1 SAS formula, kept here only to prove v2 extends it. */
function sasV1(shared: Uint8Array): string {
  const h = nacl.hash(shared)
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0
  const code = (n % 1_000_000).toString().padStart(6, '0')
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

describe('low-order peer keys', () => {
  it('deriveSharedKey refuses every low-order encoding, for any of our secrets', () => {
    const ours = genKeyPair()
    for (const k of lowOrderKeys()) {
      expect(() => deriveSharedKey(b64(k), ours.secretKey), Buffer.from(k).toString('hex')).toThrow(WeakPeerKeyError)
    }
  })

  it('isLowOrderPublicKey names exactly the low-order points, needing no secret', () => {
    for (const k of lowOrderKeys()) expect(isLowOrderPublicKey(k)).toBe(true)
    for (let i = 0; i < 64; i++) expect(isLowOrderPublicKey(genKeyPair().publicKey)).toBe(false)
  })

  it('peerPublicKeyFromB64 refuses a low-order key and accepts a real one', () => {
    for (const k of lowOrderKeys()) expect(() => peerPublicKeyFromB64(b64(k))).toThrow(WeakPeerKeyError)
    const real = genKeyPair().publicKey
    expect(peerPublicKeyFromB64(b64(real))).toEqual(real)
  })

  it('the refusal carries a stable code and says why', () => {
    try {
      deriveSharedKey(b64(new Uint8Array(32)), genKeyPair().secretKey)
      throw new Error('not refused')
    } catch (e) {
      expect(e).toBeInstanceOf(WeakPeerKeyError)
      expect((e as WeakPeerKeyError).code).toBe('E_WEAK_PEER_KEY')
      expect((e as Error).message).toMatch(/low-order/)
    }
  })

  it('two real keys still agree on the shared key, and it is exactly nacl.box.before', () => {
    for (let i = 0; i < 20; i++) {
      const a = genKeyPair()
      const b = genKeyPair()
      const ab = deriveSharedKey(b64(b.publicKey), a.secretKey)
      expect(ab).toEqual(deriveSharedKey(b64(a.publicKey), b.secretKey))
      expect(ab).toEqual(nacl.box.before(b.publicKey, a.secretKey))
    }
  })
})

describe('canonical base64', () => {
  const key = genKeyPair().publicKey
  const canonical = b64(key)

  it('accepts the canonical, padded form', () => {
    expect(publicKeyFromB64(canonical)).toEqual(key)
  })

  it('refuses a string that only decodes to the key (junk, whitespace, wrong alphabet, no padding)', () => {
    const variants = [
      '!!!@@@' + canonical,
      canonical + '====junk',
      'а' + canonical, // a Cyrillic letter
      ' ' + canonical,
      canonical + '\n',
      canonical.slice(0, 22) + ' ' + canonical.slice(22),
      canonical.replace(/=$/, ''), // missing padding
      canonical.replace(/\+/g, '-').replace(/\//g, '_'), // base64url alphabet
      'A'.repeat(1_000_000) + canonical
    ].filter((v) => v !== canonical)
    for (const v of variants) {
      // Node's own decoder hands back the real key for most of these: that is the finding.
      expect(() => publicKeyFromB64(v), JSON.stringify(v.slice(0, 60))).toThrow()
    }
  })

  it('refuses non-zero padding bits (a second spelling of the same 32 bytes)', () => {
    // 32 bytes = 256 bits = 42 full sextets + 4 bits; the 43rd character carries 2 padding bits.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const last = alphabet.indexOf(canonical[42])
    const twin = canonical.slice(0, 42) + alphabet[last | 1] + '='
    expect(Buffer.from(twin, 'base64')).toEqual(Buffer.from(key))
    expect(twin).not.toBe(canonical)
    expect(() => publicKeyFromB64(twin)).toThrow()
  })

  it('refuses a non-string', () => {
    expect(() => publicKeyFromB64(undefined as unknown as string)).toThrow()
    expect(() => publicKeyFromB64(42 as unknown as string)).toThrow()
  })
})

describe('SAS v2', () => {
  // The vectors the iOS and Android apps must reproduce byte for byte (docs/ios-protocol-migration.md
  // §3.1). Computed independently (Python hashlib.sha512) from the contract:
  //   h = SHA-512(shared); a = BE_u32(h[0..4]) mod 1e6; b = BE_u32(h[4..8]) mod 1e4;
  //   SAS = pad6(a)[0..3] + " " + pad6(a)[3..6] + " " + pad4(b)
  const vectors: Array<[string, Uint8Array, string]> = [
    ['32 x 0x00', new Uint8Array(32), '809 281 4822'],
    // The vector the iOS app pins too (eneskirca/nodeterm-ios#75): SHA-512 begins 5ce86efb 75fa4e2c.
    ['32 x 0x01', new Uint8Array(32).fill(0x01), '736 635 8284'],
    ['0x00..0x1f', Uint8Array.from({ length: 32 }, (_, i) => i), '170 596 5663'],
    ['32 x 0xff', new Uint8Array(32).fill(0xff), '773 237 5799'],
    ['00 17 then 30 x 00 (six-digit half needs its leading zero)', Uint8Array.from([0x00, 0x17, ...new Array(30).fill(0)]), '071 120 4361'],
    ['00 0b then 30 x 00 (four-digit half needs its leading zero)', Uint8Array.from([0x00, 0x0b, ...new Array(30).fill(0)]), '243 975 0790']
  ]
  for (const [name, shared, want] of vectors) {
    it(`vector: ${name}`, () => {
      expect(sasFromSharedKey(shared)).toBe(want)
    })
  }

  it('end-to-end vector: fixed secret keys → box.before → SAS (both sides)', () => {
    const a = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(0x01))
    const b = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(0x02))
    const ab = deriveSharedKey(b64(b.publicKey), a.secretKey)
    const ba = deriveSharedKey(b64(a.publicKey), b.secretKey)
    expect(b64(a.publicKey)).toBe(E2E_VECTOR.pubA)
    expect(b64(b.publicKey)).toBe(E2E_VECTOR.pubB)
    expect(Buffer.from(nacl.scalarMult(a.secretKey, b.publicKey)).toString('hex')).toBe(E2E_VECTOR.rawX25519Hex)
    expect(Buffer.from(ab).toString('hex')).toBe(E2E_VECTOR.sharedHex)
    expect(sasFromSharedKey(ab)).toBe(E2E_VECTOR.sas)
    expect(sasFromSharedKey(ba)).toBe(E2E_VECTOR.sas)
  })

  it('the first seven characters are the v1 code, for any key', () => {
    for (let i = 0; i < 200; i++) {
      const shared = nacl.randomBytes(32)
      const v2 = sasFromSharedKey(shared)
      expect(v2).toMatch(/^\d{3} \d{3} \d{4}$/)
      expect(v2.slice(0, 7)).toBe(sasV1(shared))
    }
  })
})

/** Fixed-key end-to-end vector: secret A = 32 x 0x01, secret B = 32 x 0x02. */
const E2E_VECTOR = {
  pubA: 'pOCSkrZRwni5dyxWn1+puxPZBrRqtoyd+dwrRAn4ogk=',
  pubB: 'zo060cy2M+x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk=',
  /** Raw X25519(secretA, pubB), before NaCl's HSalsa20 (checked against pyca/cryptography). */
  rawX25519Hex: '2ed76ab549b1e73c031eb49c9448f0798aea81b698279a0c3dc3e49fbfc4b953',
  /** nacl.box.before = HSalsa20(raw): the "shared key" the SAS is computed from. */
  sharedHex: '18a99320f3488fa18a04239715d8ee738065e65c3d4b2898522d6c3d4ead588c',
  sas: '561 048 8895'
}
