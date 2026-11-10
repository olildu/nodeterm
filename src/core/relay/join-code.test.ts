// src/core/relay/join-code.test.ts
import { describe, it, expect } from 'vitest'
import { encodeJoinCode, decodeJoinCode, isJoinCode, allowedEndpoint } from './join-code'
import { genKeyPair, publicKeyToB64 } from './e2ee'
import { hostIdFromPublicKeyB64 } from './relay-id'
import { lowOrderKeysB64 } from './low-order-keys.test-support'

const pub = publicKeyToB64(genKeyPair().publicKey)
const good = { v: 1 as const, relayEndpoint: 'wss://relay.nodeterm.dev', hostId: hostIdFromPublicKeyB64(pub), hostPublicKeyB64: pub, hostDeviceId: 'd', label: 'box' }

describe('join code', () => {
  it('round-trips and is recognized', () => {
    const s = encodeJoinCode(good)
    expect(s.startsWith('nodeterm://join?code=')).toBe(true)
    expect(isJoinCode(s)).toBe(true)
    expect(isJoinCode('nodeterm://pair?code=abc')).toBe(false)
    expect(decodeJoinCode(s)).toEqual(good)
  })
  it('refuses a hostId that does not match the key (a tampered code)', () => {
    expect(decodeJoinCode(encodeJoinCode({ ...good, hostId: 'x'.repeat(22) }))).toBeNull()
  })
  it('refuses plaintext relays except loopback', () => {
    expect(decodeJoinCode(encodeJoinCode({ ...good, relayEndpoint: 'ws://evil.example' }))).toBeNull()
    expect(decodeJoinCode(encodeJoinCode({ ...good, relayEndpoint: 'ws://127.0.0.1:8080' }))).not.toBeNull()
  })
  it('never throws on junk', () => {
    expect(decodeJoinCode('nodeterm://join?code=%%%')).toBeNull()
    expect(decodeJoinCode('')).toBeNull()
  })
  it('allowedEndpoint: wss anywhere, plaintext ws only to loopback', () => {
    for (const ok of ['wss://relay.nodeterm.dev', 'wss://1.2.3.4:443/x', 'ws://127.0.0.1:8080', 'ws://localhost', 'ws://[::1]:9']) expect(allowedEndpoint(ok), ok).toBe(true)
    for (const bad of ['ws://evil.example', 'ws://10.0.0.5', 'http://relay.nodeterm.dev', 'https://relay.nodeterm.dev', 'junk', '']) expect(allowedEndpoint(bad), bad).toBe(false)
  })
  it('refuses a low-order host key even when the hostId matches it (a key with a public-constant secret)', () => {
    for (const weak of lowOrderKeysB64()) {
      const code = encodeJoinCode({ ...good, hostPublicKeyB64: weak, hostId: hostIdFromPublicKeyB64(weak) })
      expect(decodeJoinCode(code), weak).toBeNull()
    }
  })
  it('refuses a host key that only decodes to the real one (non-canonical base64)', () => {
    for (const twin of ['!!!@@@' + pub, pub + '====junk', pub.replace(/=$/, '')]) {
      // Node decodes every one of these to the same 32 bytes, so the hostId still matches.
      expect(hostIdFromPublicKeyB64(twin)).toBe(good.hostId)
      expect(decodeJoinCode(encodeJoinCode({ ...good, hostPublicKeyB64: twin })), twin).toBeNull()
    }
  })
  it('refuses junk mixed into the code itself, but tolerates a code wrapped across lines', () => {
    const s = encodeJoinCode(good)
    const body = s.slice('nodeterm://join?code='.length)
    expect(decodeJoinCode('nodeterm://join?code=' + body.slice(0, 20) + '!!' + body.slice(20))).toBeNull()
    expect(decodeJoinCode('nodeterm://join?code=' + body + '==')).toBeNull()
    expect(decodeJoinCode('nodeterm://join?code=' + body.slice(0, 40) + '\n' + body.slice(40, 90) + ' \r\n' + body.slice(90))).toEqual(good)
  })
})
