import type { PtyCreateResult } from './types'

/** Shared by canvas and board: account refusal is never an SSH connection failure. */
export function ptyRefusal(unavailable: NonNullable<PtyCreateResult['unavailable']>): {
  message: string
  connectionLost: boolean
} {
  if (unavailable === 'codex-account') {
    return {
      message: 'Codex account scope is unavailable. Local managed homes must exist; SSH managed accounts are not supported yet, and SSH system accounts require a resolved remote home. Nothing was started.',
      connectionLost: false
    }
  }
  // A hosted-relay viewer asked for a terminal it could not find running. Nothing is disconnected —
  // read as a lost connection it would report an SSH drop and kick the reconnector for a healthy
  // project. The refusal covers two facts (tmux said the session is gone; tmux could not be asked),
  // so the sentence claims only what both share: no running terminal was FOUND.
  if (unavailable === 'join-only') {
    return {
      message: 'no running terminal was found to watch — a viewer can only watch terminals that are already open',
      connectionLost: false
    }
  }
  // A remote node's create found its id held by a live session that is not on its host (a local
  // session, or another endpoint) and did not join it. The project's master may be perfectly
  // healthy, so this is not a lost connection — reporting one would kick the reconnector, whose
  // respawn refuses again.
  if (unavailable === 'held-elsewhere') {
    return {
      message:
        "a session with this terminal's id is already running somewhere other than its host, so it was not joined — nothing was started",
      connectionLost: false
    }
  }
  // A relay guest's create for a node it added itself found a session already running under that
  // node's name (or could not check). Joining it would hand the guest a terminal it did not start;
  // nothing is offline, and retrying refuses again while that session runs.
  if (unavailable === 'new-only') {
    return {
      message:
        "a session with this terminal's id already exists on the host, so it was not joined — nothing was started",
      connectionLost: false
    }
  }
  return { message: 'not connected — nothing was started locally', connectionLost: true }
}
