// The `nodeterm://pair` offer is what a Team Access client PINS as the host's key: decodeOffer is an
// intake for that key, so it must refuse what the handshake would refuse — a low-order point (a
// public-constant shared secret) and a string that only decodes to a key (non-canonical base64).
import { describe, expect, it } from 'vitest'
import { decodeOffer, encodeOffer } from './pairing'
import { genKeyPair, publicKeyToB64 } from './e2ee'
import { lowOrderKeysB64 } from '../../core/relay/low-order-keys.test-support'

const hostKey = publicKeyToB64(genKeyPair().publicKey)
const good = { relayEndpoint: 'wss://relay.nodeterm.dev', pairingToken: 'tok', hostPublicKeyB64: hostKey }

describe('decodeOffer', () => {
  it('round-trips a real offer', () => {
    expect(decodeOffer(encodeOffer(good))).toEqual(good)
  })

  it('refuses a low-order host key', () => {
    for (const weak of lowOrderKeysB64()) {
      expect(decodeOffer(encodeOffer({ ...good, hostPublicKeyB64: weak })), weak).toBeNull()
    }
  })

  it('refuses a host key in non-canonical base64', () => {
    for (const twin of ['!!!@@@' + hostKey, hostKey + '====junk', hostKey.replace(/=$/, ''), ' ' + hostKey]) {
      expect(decodeOffer(encodeOffer({ ...good, hostPublicKeyB64: twin })), twin).toBeNull()
    }
  })

  it('still refuses a plaintext relay to another machine', () => {
    expect(decodeOffer(encodeOffer({ ...good, relayEndpoint: 'ws://evil.example' }))).toBeNull()
  })
})
