import { describe, it, expect } from 'vitest'
import {
  emptyMutualApproval,
  confirmLocal,
  confirmRemote,
  isMutuallyApproved,
  mutualSas,
  recordApproval
} from './mutual-approval-core'
import { genKeyPair, deriveSharedKey, publicKeyToB64 } from './e2ee'
import { isPinned } from './approved-devices-core'

describe('mutual SAS agreement', () => {
  it('both ends derive the SAME 10-digit code from their shared key', () => {
    const host = genKeyPair()
    const client = genKeyPair()
    const hostShared = deriveSharedKey(publicKeyToB64(client.publicKey), host.secretKey)
    const clientShared = deriveSharedKey(publicKeyToB64(host.publicKey), client.secretKey)
    const a = mutualSas(hostShared)
    const b = mutualSas(clientShared)
    expect(a).toBe(b)
    expect(a).toMatch(/^\d{3} \d{3} \d{4}$/)
  })

  it('a man-in-the-middle (different shared key) shows a DIFFERENT code', () => {
    const host = genKeyPair()
    const client = genKeyPair()
    const mitm = genKeyPair()
    // Host actually talks to the MITM; the client actually talks to the MITM too.
    const hostShared = deriveSharedKey(publicKeyToB64(mitm.publicKey), host.secretKey)
    const clientShared = deriveSharedKey(publicKeyToB64(mitm.publicKey), client.secretKey)
    // The two humans read out different digits -> they refuse to confirm.
    expect(mutualSas(hostShared)).not.toBe(mutualSas(clientShared))
  })
})

describe('both ends must confirm', () => {
  it('is not approved until BOTH local and remote confirm', () => {
    let s = emptyMutualApproval('peerKey', 'session-1')
    expect(isMutuallyApproved(s)).toBe(false)
    s = confirmLocal(s)
    expect(isMutuallyApproved(s)).toBe(false) // only I confirmed
    s = confirmRemote(s)
    expect(isMutuallyApproved(s)).toBe(true) // now both
  })

  it('order does not matter (remote-first)', () => {
    let s = confirmRemote(emptyMutualApproval('peerKey', 'session-1'))
    expect(isMutuallyApproved(s)).toBe(false)
    s = confirmLocal(s)
    expect(isMutuallyApproved(s)).toBe(true)
  })

  it('confirming the SAME side twice never approves (no self-satisfying handshake)', () => {
    const empty = emptyMutualApproval('peerKey', 'session-1')
    const localTwice = confirmLocal(confirmLocal(empty))
    expect(isMutuallyApproved(localTwice)).toBe(false)
    const remoteTwice = confirmRemote(confirmRemote(empty))
    expect(isMutuallyApproved(remoteTwice)).toBe(false)
  })
})

describe('pin-both-ends', () => {
  it('recordApproval pins the peer key only once mutually approved', () => {
    const half = confirmLocal(emptyMutualApproval('peerKey', 'session-1'))
    const notYet = recordApproval({ pubkeys: [] }, half)
    expect(isPinned(notYet, 'peerKey')).toBe(false) // half-confirmed → no pin

    const full = confirmRemote(half)
    const pinned = recordApproval({ pubkeys: [] }, full)
    expect(isPinned(pinned, 'peerKey')).toBe(true)
  })

  it('both ends end up pinning the OTHER (symmetric)', () => {
    const hostPub = 'HOST_PUB'
    const clientPub = 'CLIENT_PUB'
    // Host's state is bound to the CLIENT's key; the client's state is bound to the HOST's key.
    const hostSide = confirmRemote(confirmLocal(emptyMutualApproval(clientPub, 'session-1')))
    const clientSide = confirmRemote(confirmLocal(emptyMutualApproval(hostPub, 'session-1')))
    // Each pins the key carried by its own state, against its own store.
    const hostStore = recordApproval({ pubkeys: [] }, hostSide)
    const clientStore = recordApproval({ pubkeys: [] }, clientSide)
    expect(isPinned(hostStore, clientPub)).toBe(true)
    expect(isPinned(clientStore, hostPub)).toBe(true)
  })

  // Misuse vector #2 (pin-the-wrong-key): the key pinned is the one BOUND INTO the state at
  // construction, and there is no other key argument, so a state bound to key A can never pin key B —
  // no matter what other keys are in play.
  it('recordApproval pins the key CARRIED BY the state, never any other key', () => {
    const keyA = 'KEY_A'
    const keyB = 'KEY_B'
    const approved = confirmRemote(confirmLocal(emptyMutualApproval(keyA, 'session-1')))
    const store = recordApproval({ pubkeys: [] }, approved)
    expect(isPinned(store, keyA)).toBe(true) // the bound key is pinned
    expect(isPinned(store, keyB)).toBe(false) // a different key can never be pinned
    expect(store.pubkeys).toEqual([keyA]) // and NOTHING else
  })

  // Branded-type tripwire: a hand-forged approval struct must NOT typecheck. Without the `__brand`
  // on MutualApproval this line would compile cleanly and the @ts-expect-error would itself become an
  // error ("unused '@ts-expect-error'"), failing `npm run typecheck` — which is exactly how this
  // proves the brand is load-bearing. Guarded by a false condition so it never runs.
  it('a hand-forged approval struct is rejected by the compiler', () => {
    if (false as boolean) {
      const forged = { localConfirmed: true, remoteConfirmed: true, peerKeyB64: 'evil', sessionId: 'x' }
      // @ts-expect-error — a plain object is not a MutualApproval; only emptyMutualApproval() can mint one.
      recordApproval({ pubkeys: [] }, forged)
    }
    expect(true).toBe(true)
  })
})
