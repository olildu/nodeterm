// Pure pin/lookup logic for the standing (phone) host's "pin once" device approval.
//
// The FIRST time a phone (identified by its NaCl box public key, base64) connects over the relay
// the host human approves it via the SAS dialog; on approval its pubkey is pinned here so future
// connects auto-approve with no prompt. These are PUBLIC keys, not credentials — safe to persist.
//
// Kept pure (no I/O) so it can be unit-tested; the disk read/write wrapper lives in
// `approved-devices.ts`.
import { isLowOrderPublicKey } from './e2ee'

/** The persisted shape of every relay pin store (<userData>/remote-approved-{phones,guests,hosts}.json). */
export interface ApprovedDevices {
  /** Base64 NaCl box public keys of phones the host has approved at least once. */
  pubkeys: string[]
}

export function emptyApprovedDevices(): ApprovedDevices {
  return { pubkeys: [] }
}

/** Coerce arbitrary parsed JSON into a well-formed ApprovedDevices (drops non-string / empty entries). */
export function parseApprovedDevices(raw: unknown): ApprovedDevices {
  if (!raw || typeof raw !== 'object') return emptyApprovedDevices()
  const pubkeys = (raw as { pubkeys?: unknown }).pubkeys
  if (!Array.isArray(pubkeys)) return emptyApprovedDevices()
  // De-dupe while preserving order; keep only non-empty strings.
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of pubkeys) {
    if (typeof k === 'string' && k.length > 0 && !seen.has(k)) {
      seen.add(k)
      out.push(k)
    }
  }
  return { pubkeys: out }
}

/**
 * A low-order X25519 key in ANY base64 spelling Node would decode (deliberately lenient here: the
 * question is "could this string name such a key", not "is it well formed"). No device holds a
 * secret for one — its shared secret is a public constant — so it is never pinned and never counts
 * as pinned, even if an older build (or a hand edit) put one in the file. The relay handshake
 * refuses it first (e2ee.ts deriveSharedKey); this is the store's own belt.
 */
function isLowOrderKeyB64(pubkeyB64: string): boolean {
  const bytes = Buffer.from(pubkeyB64, 'base64')
  return bytes.length === 32 && isLowOrderPublicKey(Uint8Array.from(bytes))
}

/** True when `pubkeyB64` has been pinned before. Empty input and a low-order key are never pinned. */
export function isPinned(store: ApprovedDevices, pubkeyB64: string): boolean {
  return pubkeyB64.length > 0 && store.pubkeys.includes(pubkeyB64) && !isLowOrderKeyB64(pubkeyB64)
}

/** Return a store with `pubkeyB64` pinned. Idempotent; returns the same object when already present
 *  — or when the key is empty or low-order (refused: see isLowOrderKeyB64). */
export function pinDevice(store: ApprovedDevices, pubkeyB64: string): ApprovedDevices {
  if (pubkeyB64.length === 0 || store.pubkeys.includes(pubkeyB64) || isLowOrderKeyB64(pubkeyB64)) return store
  return { pubkeys: [...store.pubkeys, pubkeyB64] }
}

/** Return a store with `pubkeyB64` unpinned (revoke). Idempotent. */
export function unpinDevice(store: ApprovedDevices, pubkeyB64: string): ApprovedDevices {
  if (!store.pubkeys.includes(pubkeyB64)) return store
  return { pubkeys: store.pubkeys.filter((k) => k !== pubkeyB64) }
}
