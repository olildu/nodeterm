import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveWatchLinkKeys, sha256Hex } from './keys'
import { bytesToHex, concatBytes, utf8 } from './bytes'
import { hkdfSha256 } from './hkdf'
import { formatWatchLink } from './link'
import { encodePtyFrame, RELAY_SESSION_INFO } from './wire'
import { openUnlock } from './unlock-seal'

// vectors.json is what nodeterm-web's copy is tested against. It is the fixture; this test proves
// the code still produces it. Regenerate ONLY for a deliberate protocol change (bump the version).
const vectors = JSON.parse(readFileSync(join(__dirname, 'vectors.json'), 'utf8').replace(/\r\n/g, '\n'))
const hex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'))

describe('watch-link vectors', () => {
  it('the code reproduces every vector', async () => {
    for (const v of vectors.keys) {
      const secret = hex(v.secretHex)
      const k = deriveWatchLinkKeys(secret)
      expect(bytesToHex(k.host.publicKey)).toBe(v.hostPublicHex)
      expect(bytesToHex(k.viewer.publicKey)).toBe(v.viewerPublicHex)
      expect(bytesToHex(k.joinKey)).toBe(v.joinKeyHex)
      expect(await sha256Hex(k.joinKey)).toBe(v.joinKeyHashHex)
      expect(formatWatchLink(v.linkId, secret)).toBe(v.url)
    }
    for (const f of vectors.ptyFrames) expect(bytesToHex(encodePtyFrame(f.sessionId, f.data))).toBe(f.hex)
    // A Control link's sealed unlock: what a page sealed (nodeterm-web opens the same vector).
    expect(vectors.unlockSeals.length).toBeGreaterThan(0)
    for (const v of vectors.unlockSeals) {
      expect(openUnlock({ sealed: v.sealed }, hex(v.hostSecretHex))).toEqual({ name: v.name, password: v.password })
    }
  })

  it('derives every session key: HKDF-SHA256(base, hostNonce ‖ clientNonce, info)', async () => {
    // The web copy cannot run against the real relay, so this is how it checks its WebCrypto HKDF
    // path. src/core/watch-link/wire.test.ts pins the same vectors to the relay's deriveSessionKey.
    expect(vectors.sessionKeys.length).toBeGreaterThan(0)
    for (const v of vectors.sessionKeys) {
      expect(v.info).toBe(RELAY_SESSION_INFO)
      const key = await hkdfSha256(hex(v.baseKeyHex), concatBytes(hex(v.hostNonceHex), hex(v.clientNonceHex)), utf8(v.info), 32)
      expect(bytesToHex(key)).toBe(v.sessionKeyHex)
    }
  })
})
