// The host's SAS approval dialog has ONE slot (Canvas `pendingPeer`), fed by two sources: the relay
// tunnel (Team Access seats) and the legacy phone host (standing + interactive). A second device
// that finished its handshake while the human was comparing the first device's code used to
// REPLACE the dialog's content — the digits could change under the human between reading them and
// pressing Allow, so a click meant for device A approved device B.
//
// The rule (pure, so it is tested without a Canvas harness):
//   - nothing open                     → 'show';
//   - the SAME device re-raised        → 'replace' in place. The phone's retry churn re-raises with a
//                                        fresh id but the same key (issue #372), and the dialog must
//                                        follow it or Allow lands on a dead id;
//   - a DIFFERENT device               → 'refuse'. Fail closed: the open dialog stays exactly as the
//                                        human is reading it. The caller rejects a phone explicitly
//                                        (it retries and is asked once this dialog is answered); a
//                                        relay peer has no reject — it is simply never confirmed.
// "Same device" = same source and same stable key (phone: `pub`; relay: `peerKeyB64`). When either
// side has no key, only the exact pending id counts as the same device.

export interface PendingPeerIdentity {
  source: 'relay' | 'phone'
  id: string
  pub?: string | null
  peerKeyB64?: string | null
}

export type PendingPeerAdmission = 'show' | 'replace' | 'refuse'

function keyOf(p: PendingPeerIdentity): string | null {
  const k = p.source === 'phone' ? p.pub : p.peerKeyB64
  return typeof k === 'string' && k.length > 0 ? k : null
}

export function admitPendingPeer(
  current: PendingPeerIdentity | null,
  incoming: PendingPeerIdentity
): PendingPeerAdmission {
  if (!current) return 'show'
  if (current.source !== incoming.source) return 'refuse'
  const a = keyOf(current)
  const b = keyOf(incoming)
  if (a !== null && b !== null) return a === b ? 'replace' : 'refuse'
  return current.id === incoming.id ? 'replace' : 'refuse'
}
