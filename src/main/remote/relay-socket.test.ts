// Handshake state-machine safety for the relay socket (main process).
//
// The load-bearing property here is that the E2EE session's derived identity — the SAS the two
// humans compare and the peer public key the trust gate binds to — is FROZEN once the session is
// ready. A relay man-in-the-middle can put anything on the wire, including a second, plaintext
// `e2ee_hello` after the genuine handshake. Re-processing it would let the MITM re-key a LIVE
// session under its own keypair and then forge the second human's `trust:confirm` under the swapped
// key (see docs/remote-sessions.md, obligation (a)). This suite drives REAL relay sockets over an
// in-process transport that also models the relay's own injection capability.
import { describe, expect, it, vi } from 'vitest'
import { connectRelay, wrapWebSocket, type RelaySocket, type RelayTransport } from './relay-socket'
import { genKeyPair, publicKeyToB64, randomSessionNonce } from './e2ee'

// A minimal `ws`-shaped fake: a listener registry + an `emit` helper, enough for wrapWebSocket.
function fakeWs() {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {}
  return {
    binaryType: '',
    bufferedAmount: 0,
    on(event: string, cb: (...a: unknown[]) => void) {
      ;(listeners[event] ??= []).push(cb)
    },
    send() {},
    close() {},
    emit(event: string, ...args: unknown[]) {
      for (const cb of listeners[event] ?? []) cb(...args)
    }
  }
}

describe('wrapWebSocket: a ws error must not be an uncaught crash', () => {
  it('routes a ws `error` to onClose exactly once (never both, never a re-throw)', () => {
    const ws = fakeWs()
    const wrapped = wrapWebSocket(ws as unknown as import('ws').WebSocket)
    const onClose = vi.fn()
    wrapped.onClose(onClose)

    // A 504 upgrade timeout / TLS failure surfaces as a ws 'error'. Without a listener Node would
    // re-throw it as an uncaught exception and crash the app; wrapWebSocket must catch it here.
    expect(() => ws.emit('error', new Error('Unexpected server response: 504'))).not.toThrow()
    expect(onClose).toHaveBeenCalledTimes(1)

    // A 'close' that follows the error must NOT fire onClose a second time (the once-guard).
    ws.emit('close')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a plain close (no error) still fires onClose once', () => {
    const ws = fakeWs()
    const wrapped = wrapWebSocket(ws as unknown as import('ws').WebSocket)
    const onClose = vi.fn()
    wrapped.onClose(onClose)
    ws.emit('close')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// A pair of in-process transports wired host<->client, PLUS the relay's injection ports: the relay
// is untrusted and forwards opaque bytes, so it can also ORIGINATE traffic in either direction.
function makeTransportPair(): {
  host: RelayTransport
  client: RelayTransport
  injectToHost: (data: string | Uint8Array) => void
  injectToClient: (data: string | Uint8Array) => void
} {
  let hostOnMsg: ((d: unknown) => void) | null = null
  let clientOnMsg: ((d: unknown) => void) | null = null
  const host: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => clientOnMsg?.(d),
    close: () => {},
    onMessage: (cb) => (hostOnMsg = cb),
    onClose: () => {}
  }
  const client: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => hostOnMsg?.(d),
    close: () => {},
    onMessage: (cb) => (clientOnMsg = cb),
    onClose: () => {}
  }
  return {
    host,
    client,
    injectToHost: (d) => hostOnMsg?.(d),
    injectToClient: (d) => clientOnMsg?.(d)
  }
}

function readyPair(): {
  host: RelaySocket
  client: RelaySocket
  pair: ReturnType<typeof makeTransportPair>
  hostKeys: ReturnType<typeof genKeyPair>
  clientKeys: ReturnType<typeof genKeyPair>
} {
  const hostKeys = genKeyPair()
  const clientKeys = genKeyPair()
  const pair = makeTransportPair()
  let hostReady = false
  let clientReady = false
  const noop = (): void => {}
  const host = connectRelay({
    url: 'x',
    token: 't',
    role: 'host',
    ourKeys: hostKeys,
    transport: pair.host,
    onReady: () => (hostReady = true),
    onRpc: noop,
    onFrame: noop,
    onClose: noop
  })
  const client = connectRelay({
    url: 'x',
    token: 't',
    role: 'client',
    ourKeys: clientKeys,
    theirPubB64: publicKeyToB64(hostKeys.publicKey),
    transport: pair.client,
    onReady: () => (clientReady = true),
    onRpc: noop,
    onFrame: noop,
    onClose: noop
  })
  // The in-process handshake completes synchronously inside the second connectRelay.
  expect(hostReady && clientReady).toBe(true)
  return { host, client, pair, hostKeys, clientKeys }
}

describe('relay-socket: a handshake control frame after the session is READY is refused', () => {
  it('a post-ready plaintext e2ee_hello does NOT re-key the host (sas + peer key are frozen)', () => {
    const { host, pair, clientKeys } = readyPair()
    const attackerKeys = genKeyPair()

    const sasBefore = host.sas()
    const peerBefore = host.peerPublicKeyB64()
    expect(peerBefore).toBe(publicKeyToB64(clientKeys.publicKey)) // the REAL peer
    expect(sasBefore).toMatch(/^\d{3} \d{3} \d{4}$/)

    // The MITM injects a fresh, well-formed e2ee_hello carrying the ATTACKER's keypair. On the
    // vulnerable code this re-derives baseKey/sessionKey and overwrites peerPubB64.
    const attackerHello = JSON.stringify({
      type: 'e2ee_hello',
      publicKeyB64: publicKeyToB64(attackerKeys.publicKey),
      nonceB64: Buffer.from(randomSessionNonce()).toString('base64')
    })
    pair.injectToHost(attackerHello)

    // Frozen: the live session's identity is unchanged, and in particular is NOT the attacker's.
    expect(host.peerPublicKeyB64()).toBe(peerBefore)
    expect(host.sas()).toBe(sasBefore)
    expect(host.peerPublicKeyB64()).not.toBe(publicKeyToB64(attackerKeys.publicKey))
  })

  it('a post-ready plaintext e2ee_ready does NOT re-key the client', () => {
    const { client, pair, hostKeys } = readyPair()
    const sasBefore = client.sas()
    const peerBefore = client.peerPublicKeyB64()
    expect(peerBefore).toBe(publicKeyToB64(hostKeys.publicKey))

    pair.injectToClient(
      JSON.stringify({ type: 'e2ee_ready', nonceB64: Buffer.from(randomSessionNonce()).toString('base64') })
    )

    expect(client.sas()).toBe(sasBefore)
    expect(client.peerPublicKeyB64()).toBe(peerBefore)
  })

  it('the genuine single handshake is unaffected (both ends reach ready and agree on the SAS)', () => {
    const { host, client } = readyPair()
    expect(host.sas()).toMatch(/^\d{3} \d{3} \d{4}$/)
    expect(host.sas()).toBe(client.sas())
  })
})
