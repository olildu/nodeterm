import { describe, expect, it } from 'vitest'
import { admitPendingPeer } from './pendingPeerAdmission'

describe('admitPendingPeer — one SAS dialog, never swapped under the human', () => {
  it('shows a request when no dialog is open', () => {
    expect(admitPendingPeer(null, { source: 'phone', id: 'a', pub: 'K1' })).toBe('show')
    expect(admitPendingPeer(null, { source: 'relay', id: 'seat-1', peerKeyB64: 'K1' })).toBe('show')
  })

  it("replaces in place when the SAME phone re-raises with a fresh id (issue #372's retry churn)", () => {
    expect(admitPendingPeer({ source: 'phone', id: 'a', pub: 'K1' }, { source: 'phone', id: 'b', pub: 'K1' })).toBe('replace')
  })

  it('refuses a DIFFERENT phone while one is being compared', () => {
    expect(admitPendingPeer({ source: 'phone', id: 'a', pub: 'K1' }, { source: 'phone', id: 'b', pub: 'K2' })).toBe('refuse')
  })

  it('refuses a relay peer while a phone is being compared, and the other way round', () => {
    expect(admitPendingPeer({ source: 'phone', id: 'a', pub: 'K1' }, { source: 'relay', id: 'a', peerKeyB64: 'K1' })).toBe('refuse')
    expect(admitPendingPeer({ source: 'relay', id: 's', peerKeyB64: 'K1' }, { source: 'phone', id: 's', pub: 'K1' })).toBe('refuse')
  })

  it('keys a relay peer by its peerKeyB64 (a seat re-raise keeps the dialog; another seat is refused)', () => {
    expect(admitPendingPeer({ source: 'relay', id: 's1', peerKeyB64: 'K1' }, { source: 'relay', id: 's1', peerKeyB64: 'K1' })).toBe('replace')
    expect(admitPendingPeer({ source: 'relay', id: 's1', peerKeyB64: 'K1' }, { source: 'relay', id: 's2', peerKeyB64: 'K2' })).toBe('refuse')
  })

  it('without a key on either side, only the exact pending id is the same device', () => {
    expect(admitPendingPeer({ source: 'phone', id: 'a', pub: null }, { source: 'phone', id: 'a', pub: 'K1' })).toBe('replace')
    expect(admitPendingPeer({ source: 'phone', id: 'a', pub: null }, { source: 'phone', id: 'b', pub: null })).toBe('refuse')
    expect(admitPendingPeer({ source: 'relay', id: 's1', peerKeyB64: '' }, { source: 'relay', id: 's2', peerKeyB64: '' })).toBe('refuse')
  })
})
