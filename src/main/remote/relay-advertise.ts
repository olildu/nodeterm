// Relay advertisement — the cure for the LAN-only-pairing trap without re-pairing.
//
// `connection.relay` on the phone is otherwise written at exactly ONE moment (the pairing
// exchange), so a phone paired while "Reach this Mac from anywhere" was OFF stayed LAN-only
// forever: flipping the toggle later changed nothing, and off-LAN every open died with a raw
// connection error (field report). While the standing phone host is UP, we now advertise the
// relay identity in ~/.nodeterm/relay.json. The phone reads it over the SAME TOFU-verified SSH
// bootstrap it already uses for agent.json, then mints its own device token against the API
// (the free-tier TOFU mint). The file carries ONLY public material — the same block every
// pairing QR embeds, plus this desktop's device id for that mint; relay ACCESS remains gated
// host-side by the pin-once SAS approval, exactly as for a pairing-minted identity.

import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { removeAtomic, writeFileAtomic } from '../../core/fs-atomic'

const FILE = path.join(os.homedir(), '.nodeterm', 'relay.json')

export interface RelayAdvertisement {
  v: 1
  hostId: string
  hostPublicKeyB64: string
  relayEndpoint: string
  hostDeviceId: string
}

/**
 * The advertisement writer for one file. The standing host calls `write` on EVERY successful
 * listener open — every ~90 s, 24/7, with byte-identical content (measured: the mtime
 * refreshing each cycle, ~960 mkdir + temp-write + rename a day for nothing). So an
 * unchanged advertisement is skipped: the last string we wrote is kept in memory, and the file is
 * rewritten only when the content changes or the file has gone (a user or another tool deleted it —
 * one stat per cycle is what that costs). `remove` forgets it, so the next start always writes.
 * A factory so the tests can point it at a temp dir and never touch the live ~/.nodeterm.
 */
export function createRelayAdvertiser(file: string): {
  write(ad: RelayAdvertisement): Promise<void>
  remove(): Promise<void>
} {
  let lastWritten: string | null = null
  return {
    /** Best-effort atomic write — a failed advertisement only means late adoption is unavailable. */
    async write(ad) {
      const content = JSON.stringify(ad, null, 2) + '\n'
      try {
        if (content === lastWritten) {
          try {
            await fs.access(file)
            return // unchanged and still there
          } catch {
            /* gone — fall through and rewrite it */
          }
        }
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
        await writeFileAtomic(file, content, { mode: 0o600 })
        lastWritten = content
      } catch {
        // Advertisement is opportunistic; pairing-time provisioning still works. `lastWritten` is
        // untouched, so a failed write is retried on the next cycle.
      }
    },
    /** Remove the advertisement (host stopped / toggle off) so phones stop offering adoption.
     *  `removeAtomic` retries transient Windows sharing violations and treats "already absent"
     *  (ENOENT) as success; it never throws. */
    async remove() {
      lastWritten = null
      await removeAtomic(file)
    }
  }
}

const advertiser = createRelayAdvertiser(FILE)

/** Best-effort atomic write of ~/.nodeterm/relay.json; skipped when unchanged (see above). */
export async function writeRelayAdvertisement(ad: RelayAdvertisement): Promise<void> {
  await advertiser.write(ad)
}

/** Remove ~/.nodeterm/relay.json (host stopped / toggle off); never throws. */
export async function removeRelayAdvertisement(): Promise<void> {
  await advertiser.remove()
}
