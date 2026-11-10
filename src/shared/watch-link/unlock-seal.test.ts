import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { b64ToBytes, bytesToB64 } from './bytes'
import { isSealedUnlock, openUnlock, readUnlockKey, sealUnlock, SEALED_BOX_B64_MAX } from './unlock-seal'

const vectors = JSON.parse(readFileSync(join(__dirname, 'vectors.json'), 'utf8').replace(/\r\n/g, '\n'))
const hex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'))

describe('the sealed unlock', () => {
  it('opens with the connection key it was sealed to, and with no other', () => {
    const host = nacl.box.keyPair()
    const arg = sealUnlock('Ada', 'hunter2hunter2', host.publicKey)
    expect(isSealedUnlock(arg)).toBe(true)
    expect(openUnlock(arg, host.secretKey)).toEqual({ name: 'Ada', password: 'hunter2hunter2' })
    // Another connection's key (a link holder replaying a recording knows neither secret).
    expect(openUnlock(arg, nacl.box.keyPair().secretKey)).toBeNull()
    // Nothing of the password is in what crosses the wire.
    expect(JSON.stringify(arg)).not.toContain('hunter2')
  })

  it('draws a fresh key pair and nonce every time: the same password never seals to the same bytes', () => {
    const host = nacl.box.keyPair()
    const a = sealUnlock('Ada', 'pw-pw-pw-pw', host.publicKey).sealed
    const b = sealUnlock('Ada', 'pw-pw-pw-pw', host.publicKey).sealed
    expect(a.key).not.toBe(b.key)
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.box).not.toBe(b.box)
  })

  it('opens the vector nodeterm-web is tested against', () => {
    expect(vectors.unlockSeals.length).toBeGreaterThan(0)
    for (const v of vectors.unlockSeals) {
      const secret = hex(v.hostSecretHex)
      expect(bytesToB64(nacl.box.keyPair.fromSecretKey(secret).publicKey)).toBe(v.hostPublicB64)
      expect(openUnlock({ sealed: v.sealed }, secret)).toEqual({ name: v.name, password: v.password })
    }
  })

  it('refuses anything that is not a sealed unlock this key opens', () => {
    const host = nacl.box.keyPair()
    const { sealed } = sealUnlock('Ada', 'pw-pw-pw-pw', host.publicKey)
    const bad: unknown[] = [
      undefined, null, 'x', { name: 'Ada', password: 'pw' }, { sealed: null }, { sealed: 'x' },
      { sealed: { ...sealed, key: 'AAAA' } },
      { sealed: { ...sealed, nonce: bytesToB64(new Uint8Array(23)) } },
      { sealed: { ...sealed, box: 'not base64!' } },
      { sealed: { ...sealed, box: 7 } },
      // One flipped bit of the box: the MAC fails.
      { sealed: { ...sealed, box: bytesToB64(b64ToBytes(sealed.box)!.map((x, i) => (i === 0 ? x ^ 1 : x))) } },
      { sealed: { ...sealed, box: 'A'.repeat(SEALED_BOX_B64_MAX + 4) } }
    ]
    for (const arg of bad) expect(openUnlock(arg, host.secretKey)).toBeNull()
  })

  it('refuses a box whose content is not a JSON object', () => {
    const host = nacl.box.keyPair()
    const page = nacl.box.keyPair()
    const nonce = nacl.randomBytes(24)
    for (const body of ['[1,2]', '"x"', 'not json', 'ÿþ']) {
      const bytes = body === 'ÿþ' ? Uint8Array.of(0xff, 0xfe) : new TextEncoder().encode(body)
      const box = nacl.box(bytes, nonce, host.publicKey, page.secretKey)
      const arg = { sealed: { key: bytesToB64(page.publicKey), nonce: bytesToB64(nonce), box: bytesToB64(box) } }
      expect(openUnlock(arg, host.secretKey)).toBeNull()
    }
  })

  it('reads an offered key only as 32 bytes of strict base64', () => {
    const k = nacl.box.keyPair().publicKey
    expect(readUnlockKey(bytesToB64(k))).toEqual(k)
    for (const x of [undefined, 7, '', bytesToB64(new Uint8Array(31)), bytesToB64(new Uint8Array(33)), `${bytesToB64(k)} `, 'A'.repeat(200)]) {
      expect(readUnlockKey(x)).toBeNull()
    }
  })

  it('throws (sends nothing) for a key that is not one', () => {
    expect(() => sealUnlock('Ada', 'pw', new Uint8Array(31))).toThrow()
  })
})
