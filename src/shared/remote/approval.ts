// View-model for the HOST approval dialog (Stage 4 relay tunnel). Maps a `RelayPeerPending` payload
// (id + SAS, no label yet) to the three things the dialog needs: the peer label that feeds the
// ConsentNotice's describeGrant sentence, the SAS-comparison body text, and the confirm target id
// (`relayHost.confirm(id)`). Pure + shared so it is unit-testable without a jsdom harness — Canvas
// has none — and so the SAS copy lives in one place.

import { SAS_COMPARE_HINT } from './sas'

/** The pending-peer fields this view needs (a superset-friendly shape of `RelayPeerPending`). */
export interface PeerApprovalInput {
  id: string
  sas: string | null
  /** Human-facing name of the peer, if the tunnel carries one; else the generic fallback is used. */
  label?: string
}

export interface PeerApprovalView {
  /** Fed to `<ConsentNotice peerLabel>` → describeGrant("<peer> will be able to run commands…"). */
  peerLabel: string
  /** The SAS-comparison body shown in the ConfirmDialog. */
  message: string
  /** The pending peer id to pass to `relayHost.confirm(id)` on approval. */
  confirmId: string
}

export function peerApprovalView(peer: PeerApprovalInput): PeerApprovalView {
  return {
    peerLabel: peer.label?.trim() || 'This device',
    confirmId: peer.id,
    message:
      `A device wants to access this machine.\n\n` +
      `Approve ONLY if you started this connection. The other device shows the same code:\n\n` +
      `        ${peer.sas ?? '— — —'}\n\n` +
      `${SAS_COMPARE_HINT}\n\n` +
      `If the codes don't match, deny it.`
  }
}
