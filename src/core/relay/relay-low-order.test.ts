// Regression: a LOW-ORDER X25519 key (here 0^32 and every other small-order encoding) used to be
// accepted by the relay handshake. `nacl.box.before(lowOrder, anySecret)` = HSalsa20(0), a constant
// with no secret in it, so:
//   - a secret-less client completed the handshake with a real host and was shown a CONSTANT SAS;
//   - an attacker who substituted the host key in an offer / join code / QR with 0^32 and rewrote the
//     victim's hello key to 0^32 sat transparently in the middle: both humans saw the SAME digits,
//     both confirmed, the host PINNED 0^32, and the attacker read and injected every byte;
//   - once 0^32 was a pinned member (hosted autoApprove), ANYONE opened a session with no secret.
// Each `it` below is one of those attacks run against the REAL relay host and client (ported from the
// security audit's working repro); every one must now fail closed.
import { describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { connectRelayHost } from './relay-host'
import { connectRelayClient } from './relay-client'
import type { RelayTransport } from './relay-socket'
import type { PeerAttach } from './relay-host'
import type { RpcRequest } from '../../shared/rpc'
import {
  WeakPeerKeyError,
  deriveSessionKey,
  encrypt,
  genKeyPair,
  publicKeyToB64,
  randomSessionNonce
} from './e2ee'
import { lowOrderKeysB64 } from './low-order-keys.test-support'

const TAG_RPC = 0x01
const TAG_TUNNEL_TEXT = 0x03
const ZERO_KEY_B64 = Buffer.from(new Uint8Array(32)).toString('base64')
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/** A transport pair with a man in the middle: each frame passes through `c2h` / `h2c`, which may
 *  rewrite it (return the new value), pass it, or drop it (return null). */
function mitmPipe(hooks: { c2h?: (d: unknown) => unknown; h2c?: (d: unknown) => unknown } = {}) {
  let hostOnMsg: ((d: unknown) => void) | null = null
  let clientOnMsg: ((d: unknown) => void) | null = null
  let hostOnClose: (() => void) | null = null
  let clientOnClose: (() => void) | null = null
  let closed = 0
  const hostT: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => {
      const x = hooks.h2c ? hooks.h2c(d) : d
      if (x !== null) clientOnMsg?.(x)
    },
    close: () => {
      closed++
      clientOnClose?.()
      hostOnClose?.()
    },
    onMessage: (cb) => {
      hostOnMsg = cb
    },
    onClose: (cb) => {
      hostOnClose = cb
    }
  }
  const clientT: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => {
      const x = hooks.c2h ? hooks.c2h(d) : d
      if (x !== null) hostOnMsg?.(x)
    },
    close: () => {
      closed++
      hostOnClose?.()
      clientOnClose?.()
    },
    onMessage: (cb) => {
      clientOnMsg = cb
    },
    onClose: (cb) => {
      clientOnClose = cb
    }
  }
  return { hostT, clientT, closes: () => closed }
}

/** Seal [role][seq:8][tag][body] exactly as relay-socket.ts does. */
function seal(sessionKey: Uint8Array, role: number, seq: number, tag: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + 8 + 1 + body.length)
  out[0] = role
  const v = new DataView(out.buffer)
  v.setUint32(1, Math.floor(seq / 0x100000000), true)
  v.setUint32(5, seq >>> 0, true)
  out[9] = tag
  out.set(body, 10)
  return encrypt(out, sessionKey)
}

function fakeAttach() {
  const dispatched: RpcRequest[] = []
  const casts: Array<{ method: string; args: unknown[] }> = []
  let next = 1
  const attach: PeerAttach = {
    attach: () => next++,
    detach: () => {},
    dispatch: async (_id, req) => {
      dispatched.push(req)
      return { t: 'res', id: req.id, ok: true, result: null }
    },
    cast: (_id, method, args) => {
      casts.push({ method, args })
    }
  }
  return { attach, dispatched, casts }
}

const silence = (): void => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
}

describe('relay handshake refuses low-order keys', () => {
  it('a secret-less client presenting a low-order key gets no e2ee_ready, no SAS and a closed socket', async () => {
    silence()
    for (const weak of lowOrderKeysB64()) {
      const hostKeys = genKeyPair()
      const fa = fakeAttach()
      const pipe = mitmPipe()
      const pending = vi.fn()
      const closed = vi.fn()
      connectRelayHost({
        url: 'ws://127.0.0.1/x',
        token: 't',
        ourKeys: hostKeys,
        attach: fa.attach,
        transport: pipe.hostT,
        onPeerPending: pending,
        onOpen: () => {},
        onClose: closed
      })
      const fromHost: unknown[] = []
      pipe.clientT.onMessage((d) => fromHost.push(d))
      const nonceB64 = Buffer.from(randomSessionNonce()).toString('base64')
      pipe.clientT.send(JSON.stringify({ type: 'e2ee_hello', publicKeyB64: weak, nonceB64 }))
      // The host never answered: no e2ee_ready, so there is no session key to derive.
      expect(fromHost, weak).toEqual([])
      expect(pipe.closes(), weak).toBeGreaterThan(0)
      expect(closed, weak).toHaveBeenCalled()
      // The attacker's next step (the encrypted auth marker under the constant key) reaches nothing.
      const base = nacl.box.before(new Uint8Array(32), nacl.randomBytes(32))
      const sk = deriveSessionKey(base, nacl.randomBytes(16), Buffer.from(nonceB64, 'base64'))
      pipe.clientT.send(seal(sk, 2, 0, TAG_RPC, enc(JSON.stringify({ type: 'e2ee_auth' }))))
      await Promise.resolve()
      expect(pending, weak).not.toHaveBeenCalled()
      expect(fa.dispatched).toEqual([])
    }
  })

  it('a non-canonical spelling of a real key is refused too (Node would decode it to the same key)', () => {
    silence()
    const hostKeys = genKeyPair()
    const client = genKeyPair()
    const pipe = mitmPipe()
    const pending = vi.fn()
    connectRelayHost({
      url: 'ws://127.0.0.1/x',
      token: 't',
      ourKeys: hostKeys,
      attach: fakeAttach().attach,
      transport: pipe.hostT,
      onPeerPending: pending,
      onOpen: () => {},
      onClose: () => {}
    })
    const fromHost: unknown[] = []
    pipe.clientT.onMessage((d) => fromHost.push(d))
    const nonceB64 = Buffer.from(randomSessionNonce()).toString('base64')
    const junk = '!!!@@@' + publicKeyToB64(client.publicKey)
    expect(Buffer.from(junk, 'base64')).toEqual(Buffer.from(client.publicKey)) // the finding
    pipe.clientT.send(JSON.stringify({ type: 'e2ee_hello', publicKeyB64: junk, nonceB64 }))
    expect(fromHost).toEqual([])
    expect(pipe.closes()).toBeGreaterThan(0)
  })

  it('a client handed a low-order host key (substituted offer / join code / QR) refuses before dialing', () => {
    for (const weak of lowOrderKeysB64()) {
      const pipe = mitmPipe()
      const sent: unknown[] = []
      pipe.hostT.onMessage((d) => sent.push(d))
      expect(() =>
        connectRelayClient({
          url: 'ws://127.0.0.1/x',
          token: 't',
          hostKeyB64: weak,
          ourKeys: genKeyPair(),
          transport: pipe.clientT,
          onSas: () => {},
          onApproved: () => {},
          onFrame: () => {},
          onPtyData: () => {},
          onClose: () => {}
        })
      ).toThrow(WeakPeerKeyError)
      // Not even a hello went out.
      expect(sent, weak).toEqual([])
    }
  })

  it('the transparent MITM (victim pins 0^32, its hello is rewritten to 0^32) dies at the host: no SAS, no pin, nothing read', async () => {
    silence()
    const hostKeys = genKeyPair()
    const victim = genKeyPair()
    const fa = fakeAttach()
    const pinned: string[] = []
    let hostSas: string | null = null
    const opened: string[] = []
    // The attacker relays every byte; its only edit is the victim's hello key → 0^32.
    const fromHostPlain: string[] = []
    const pipe = mitmPipe({
      c2h: (d) => {
        if (typeof d === 'string') {
          const m = JSON.parse(d) as { type?: string }
          if (m.type === 'e2ee_hello') return JSON.stringify({ ...m, publicKeyB64: ZERO_KEY_B64 })
        }
        return d
      },
      h2c: (d) => {
        if (typeof d === 'string') fromHostPlain.push(d)
        return d
      }
    })
    connectRelayHost({
      url: 'ws://127.0.0.1/x',
      token: 't',
      ourKeys: hostKeys,
      attach: fa.attach,
      transport: pipe.hostT,
      pins: {
        record: async (s) => {
          pinned.push(s.peerKeyB64)
        }
      },
      onPeerPending: (s) => {
        hostSas = s.sas()
      },
      onOpen: () => opened.push('host'),
      onClose: () => {}
    })
    // The victim's offer pins the REAL host key here (the 0^32 offer half is refused before dialing,
    // above); the host still has to refuse the rewritten hello on its own.
    connectRelayClient({
      url: 'ws://127.0.0.1/x',
      token: 't',
      hostKeyB64: publicKeyToB64(hostKeys.publicKey),
      ourKeys: victim,
      transport: pipe.clientT,
      onSas: () => {},
      onApproved: () => opened.push('client'),
      onFrame: () => {},
      onPtyData: () => {},
      onClose: () => {}
    })
    await Promise.resolve()
    await Promise.resolve()
    // The host never answered the rewritten hello, so the attacker has no host nonce to key with.
    expect(fromHostPlain).toEqual([])
    expect(pipe.closes()).toBeGreaterThan(0)
    expect(hostSas).toBeNull()
    expect(pinned).toEqual([])
    expect(opened).toEqual([])
    expect(fa.dispatched).toEqual([])
  })

  it('a host that pins a low-order key (hosted autoApprove) is never asked: the handshake stops first', async () => {
    silence()
    const hostKeys = genKeyPair()
    const fa = fakeAttach()
    const pipe = mitmPipe()
    const asked = vi.fn((k: string) => k === ZERO_KEY_B64)
    let opened = false
    connectRelayHost({
      url: 'ws://127.0.0.1/x',
      token: 't',
      ourKeys: hostKeys,
      attach: fa.attach,
      transport: pipe.hostT,
      autoApprove: asked,
      onPeerPending: () => {},
      onOpen: () => {
        opened = true
      },
      onClose: () => {}
    })
    const fromHost: unknown[] = []
    pipe.clientT.onMessage((d) => fromHost.push(d))
    const nonceB64 = Buffer.from(randomSessionNonce()).toString('base64')
    pipe.clientT.send(JSON.stringify({ type: 'e2ee_hello', publicKeyB64: ZERO_KEY_B64, nonceB64 }))
    // Even had the attacker the session key, every tunnel frame below would land on a closed socket.
    const base = nacl.box.before(new Uint8Array(32), nacl.randomBytes(32))
    const sk = deriveSessionKey(base, nacl.randomBytes(16), Buffer.from(nonceB64, 'base64'))
    pipe.clientT.send(seal(sk, 2, 0, TAG_RPC, enc(JSON.stringify({ type: 'e2ee_auth' }))))
    pipe.clientT.send(seal(sk, 2, 1, TAG_TUNNEL_TEXT, enc(JSON.stringify({ t: 'cast', method: 'trust:confirm', args: [] }))))
    pipe.clientT.send(seal(sk, 2, 2, TAG_TUNNEL_TEXT, enc(JSON.stringify({ t: 'req', id: 9, method: 'fs:read', args: ['/etc/passwd'] }))))
    await new Promise((r) => setTimeout(r, 10))
    expect(fromHost).toEqual([])
    expect(asked).not.toHaveBeenCalled()
    expect(opened).toBe(false)
    expect(fa.dispatched).toEqual([])
  })

  it('a real client still connects and both ends show the same 10-digit SAS', async () => {
    const hostKeys = genKeyPair()
    const pipe = mitmPipe()
    let hostSas: string | null = null
    connectRelayHost({
      url: 'ws://127.0.0.1/x',
      token: 't',
      ourKeys: hostKeys,
      attach: fakeAttach().attach,
      transport: pipe.hostT,
      onPeerPending: (s) => {
        hostSas = s.sas()
      },
      onOpen: () => {},
      onClose: () => {}
    })
    const client = connectRelayClient({
      url: 'ws://127.0.0.1/x',
      token: 't',
      hostKeyB64: publicKeyToB64(hostKeys.publicKey),
      ourKeys: genKeyPair(),
      transport: pipe.clientT,
      onSas: () => {},
      onApproved: () => {},
      onFrame: () => {},
      onPtyData: () => {},
      onClose: () => {}
    })
    await vi.waitFor(() => expect(hostSas).not.toBeNull())
    expect(hostSas).toMatch(/^\d{3} \d{3} \d{4}$/)
    expect(client.sas()).toBe(hostSas)
  })
})
