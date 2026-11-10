import { describe, it, expect } from 'vitest'
import { encodeOffer, decodeOffer, type PairingOffer } from '../../src/main/remote/pairing'
import { genKeyPair, publicKeyToB64 } from '../../src/main/remote/e2ee'
import { lowOrderKeysB64 } from '../../src/core/relay/low-order-keys.test-support'

// A REAL X25519 public key: the offer is what the client pins, so decodeOffer refuses anything that
// is not one (wrong length, non-canonical base64, a low-order point).
const sample: PairingOffer = {
  relayEndpoint: 'wss://relay.nodeterm.dev/socket',
  pairingToken: 'tok_abc123',
  hostPublicKeyB64: publicKeyToB64(genKeyPair().publicKey)
}

describe('pairing', () => {
  it('round-trips decodeOffer(encodeOffer(o))', () => {
    const url = encodeOffer(sample)
    expect(url.startsWith('nodeterm://pair?code=')).toBe(true)
    const out = decodeOffer(url)
    expect(out).toEqual(sample)
  })

  it('decodeOffer accepts the bare base64url code too', () => {
    const url = encodeOffer(sample)
    const code = url.slice('nodeterm://pair?code='.length)
    expect(decodeOffer(code)).toEqual(sample)
  })

  it('decodeOffer("garbage") === null', () => {
    expect(decodeOffer('garbage')).toBeNull()
  })

  it('decodeOffer of a wrong-scheme URL === null', () => {
    expect(decodeOffer('https://example.com/pair?code=abc')).toBeNull()
  })

  it('decodeOffer of an incomplete offer === null', () => {
    const json = JSON.stringify({ relayEndpoint: 'wss://x' })
    const code = Buffer.from(json, 'utf-8').toString('base64url')
    expect(decodeOffer(`nodeterm://pair?code=${code}`)).toBeNull()
  })

  // R5: the client connects to relayEndpoint verbatim — a crafted offer must not be able to
  // point it at a plaintext or non-WebSocket endpoint. ws:// is allowed only to loopback.
  it('R5: rejects non-wss relay endpoints (plaintext ws to a real host, http, garbage)', () => {
    const withEndpoint = (relayEndpoint: string) =>
      encodeOffer({ ...sample, relayEndpoint })
    expect(decodeOffer(withEndpoint('ws://attacker.example'))).toBeNull()
    expect(decodeOffer(withEndpoint('ws://192.168.1.10:8080'))).toBeNull()
    expect(decodeOffer(withEndpoint('http://relay.nodeterm.dev'))).toBeNull()
    expect(decodeOffer(withEndpoint('https://relay.nodeterm.dev'))).toBeNull()
    expect(decodeOffer(withEndpoint('not a url'))).toBeNull()
  })

  it('R5: accepts wss:// anywhere and plain ws:// on loopback only (dev/tests)', () => {
    const withEndpoint = (relayEndpoint: string) =>
      decodeOffer(encodeOffer({ ...sample, relayEndpoint }))
    expect(withEndpoint('wss://relay.nodeterm.dev')).not.toBeNull()
    expect(withEndpoint('ws://127.0.0.1:8137')).not.toBeNull()
    expect(withEndpoint('ws://localhost:8137')).not.toBeNull()
  })

  it('refuses a host key that is not a usable X25519 key: wrong length, non-canonical, low-order', () => {
    const withKey = (hostPublicKeyB64: string) => decodeOffer(encodeOffer({ ...sample, hostPublicKeyB64 }))
    expect(withKey('aGVsbG8td29ybGQtcHVibGljLWtleQ==')).toBeNull() // 22 bytes
    expect(withKey('!!!' + sample.hostPublicKeyB64)).toBeNull() // Node would decode it to the key
    for (const weak of lowOrderKeysB64()) expect(withKey(weak), weak).toBeNull()
  })
})
