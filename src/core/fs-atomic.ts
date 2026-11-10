// Atomic file writes that survive Windows.
//
// Every store in this app persists the same way: write a temp file, then rename it over the
// target, so a reader sees either the old bytes or the new ones and never a half-written file.
// That is correct on POSIX, where `rename(2)` is atomic and replaces the destination
// unconditionally.
//
// It is NOT sufficient on Windows, and the difference is quiet. `MoveFileEx` fails with a sharing
// violation — surfacing through Node as `EPERM` (sometimes `EACCES`/`EBUSY`) — whenever the
// DESTINATION is open by anyone at that instant. Not held open for long: opened. The usual
// culprits are not exotic:
//
//   - Windows Defender's real-time scanner opens each file we just wrote, to scan it;
//   - the search indexer does the same;
//   - a backup or sync client (OneDrive over a user profile, very common) holds a read handle;
//   - two of our own concurrent writers race their renames onto one destination.
//
// The last one was reproducible on demand and exposed this: the approved-devices store originally
// had three un-queued writers, and its old overlapping-save test failed on Windows with
// `EPERM: operation not permitted, rename`. The store now also serializes its read-modify-write
// decisions, but retrying rename remains required for scanners/indexers and independent processes.
//
// The consequence is worse than a failed save. These are the stores holding the user's canvas
// layout, their settings, their pinned remote devices and their sealed credentials. On Windows a
// scanner touching the file at the wrong millisecond turned a routine save into a thrown error,
// and the save was simply lost — intermittently, unreproducibly, and more often on exactly the
// machines that are most protected.
//
// One file already knew. `src/core/github/cache.ts` carried a full write-up of this — naming
// EPERM, naming NTFS, and citing a direct measurement: "two concurrent writers to one path failed
// with EPERM in roughly 3 of 5 runs on this host" — and had its own bounded retry loop. It had had
// it for some time. The knowledge sat in that one file and reached none of the other twenty-odd
// stores doing the identical thing a few directories away, because a comment cannot propagate and
// nothing scanned for the pattern. That is the argument for the guard test beside this file rather
// than for another comment: a written explanation protects the file it is written in.
//
// The fix is the standard one: retry the rename briefly. Each attempt is still a single atomic
// rename, so retrying cannot tear a write — it only tries the same indivisible operation again
// once whoever held the destination has let go. The window these scanners hold is milliseconds.
//
// What this deliberately does NOT do:
//   - It does not retry forever. A genuinely locked file must fail, and fail loudly: several
//     callers (revocation.ts's `persisted:false`, for one) have contracts that depend on a failed
//     save being reported as a failed save.
//   - It does not retry every error. `ENOENT` means the temp file is gone, which is a bug in the
//     caller, and retrying only delays a clearer error. `ENOSPC` will not improve by waiting.
//   - It does not swallow the final failure. The last error is thrown with its original code.

import { promises as fs, renameSync } from 'fs'
import { randomUUID } from 'crypto'
import path from 'path'
import { sleep } from '../shared/sleep'

/**
 * Errors that mean "someone else has the destination open right now", rather than "this will
 * never work". Windows reports a sharing violation as EPERM most often, EACCES and EBUSY
 * occasionally, depending on which layer refused.
 */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Backoff between rename attempts, in ms. Five tries over ~310 ms total.
 *
 *  Sized against what actually holds the file: an antivirus or indexer scan of a small JSON file
 *  finishes in single-digit milliseconds, so the first retry usually wins. The long tail exists
 *  for a sync client mid-upload. It stays under a third of a second because these calls sit
 *  behind user actions — a save that blocks for seconds is its own defect. */
const RETRY_DELAYS_MS = [10, 25, 75, 200]

function codeOf(e: unknown): string {
  return typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''
}

/**
 * Rename `tmp` over `target`, retrying briefly if the destination is momentarily held open.
 *
 * Use this instead of `fs.rename` for every temp-then-publish write. The retry is a no-op on
 * POSIX, where these codes do not arise from this operation, so there is no reason to branch on
 * platform — and branching would mean the behaviour under test on a developer's Mac was not the
 * behaviour shipped to a user on Windows.
 */
export async function renameAtomic(tmp: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, target)
      return
    } catch (e) {
      // Out of attempts, or an error waiting will not fix: give the caller the real error, with
      // its original code, so `persisted:false` contracts and error messages stay accurate.
      if (attempt >= RETRY_DELAYS_MS.length || !TRANSIENT.has(codeOf(e))) throw e
      await sleep(RETRY_DELAYS_MS[attempt])
    }
  }
}

/**
 * The synchronous twin, for the paths that cannot be async: hook installers that run during
 * startup, the codex trust-hash write, the per-node token file. Same retry, same codes, same
 * refusal to loop forever.
 *
 * It blocks the thread while it waits, which is the honest cost of a synchronous API and the
 * reason the budget is the same ~310 ms rather than something more generous. `Atomics.wait` is a
 * real sleep rather than a spin, so the wait does not also burn a core — Node permits it on the
 * main thread (browsers do not).
 *
 * `rename` is a parameter only because a spy cannot be attached to an ESM namespace export, so a
 * test has no other way to make this fail on a platform where it does not. Production never
 * passes it. Injecting it here rather than exporting a mutable hook keeps the seam typed and
 * visible, and keeps every other caller exercising the real default.
 */
export function renameAtomicSync(
  tmp: string,
  target: string,
  rename: (from: string, to: string) => void = renameSync
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(tmp, target)
      return
    } catch (e) {
      if (attempt >= RETRY_DELAYS_MS.length || !TRANSIENT.has(codeOf(e))) throw e
      Atomics.wait(SLEEP_SLOT, 0, 0, RETRY_DELAYS_MS[attempt])
    }
  }
}

/** A slot that is never written, so `Atomics.wait` always waits out its full timeout. */
const SLEEP_SLOT = new Int32Array(new SharedArrayBuffer(4))

/**
 * Minimum age before a startup/save sweep may consider temp litter abandoned.
 *
 * The grace is intentionally long. PID-bearing temps are never collected automatically because
 * local process liveness says nothing reliable about a writer in another PID namespace. The age
 * applies only to the historical ownerless `<target>.tmp` shape.
 */
export const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000

export interface SweepStaleTempOptions {
  /** Test seam; production uses the wall clock. */
  now?: number
}

interface AtomicTempCandidate {
  ownerPid?: number
}

/** Recognize only the temp formats this module has actually published. Prefix checking is part of
 * the decision: two unrelated basenames can have the same length, and slicing first made one
 * store's sweeper mistake the other's file for its own. */
function atomicTempCandidate(base: string, entry: string): AtomicTempCandidate | null {
  if (!entry.startsWith(base)) return null
  const suffix = entry.slice(base.length)
  if (suffix === '.tmp') return {}
  // Accept the historical pid+sequence name and ONLY the canonical v4 UUID shape emitted now.
  // A broad "anything without a dot" token made unrelated lookalikes part of cleanup policy.
  const owned = /^\.(\d+)\.\d+(?:\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?\.tmp$/.exec(suffix)
  return owned ? { ownerPid: Number(owned[1]) } : null
}

/**
 * Best-effort collection of abandoned temp files next to `target`.
 *
 * Current temp names are `<target>.<pid>.<seq>.<uuid>.tmp`; the prior pid+sequence form is also
 * recognized during upgrades. A different pid is NOT proof that a writer died: desktop
 * multi-instance mode and two Server Edition processes may deliberately share a data directory.
 * A pid-bearing temp is never removed automatically. Signal-0/ESRCH is namespace-local, so it
 * cannot prove that a writer on a shared Docker/Server volume is dead; PID reuse makes the inverse
 * equally unreliable. Credential Clear reports such a temp as incomplete instead. The legacy
 * fixed `<target>.tmp` name has no owner or UUID and predates cross-process-safe writers, so the
 * long age grace is the only evidence available for collecting that one exact shape.
 *
 * Unknown temp-name shapes are left alone. Every current writer removes its own temp on failure;
 * this sweep exists only for process death and must never recreate the writer-vs-sweeper race that
 * unique names fixed.
 *
 * A store whose orphaned temp would be a live credential uses `sweepForeignTempFiles` instead.
 */
export async function sweepStaleTempFiles(
  target: string,
  opts: SweepStaleTempOptions = {}
): Promise<void> {
  const now = opts.now ?? Date.now()
  try {
    const directory = path.dirname(target)
    const base = path.basename(target)
    for (const entry of await fs.readdir(directory)) {
      const candidate = atomicTempCandidate(base, entry)
      if (!candidate) continue

      const temp = path.join(directory, entry)
      let mtimeMs: number
      try {
        mtimeMs = (await fs.lstat(temp)).mtimeMs
      } catch {
        continue
      }
      if (!Number.isFinite(mtimeMs) || now - mtimeMs < STALE_TEMP_AGE_MS) continue

      // Foreign ownership cannot be proved dead across PID namespaces; fail conservative.
      if (candidate.ownerPid !== undefined) continue
      await fs.rm(temp, { force: true }).catch(() => undefined)
    }
  } catch {
    // A directory we cannot read is not a reason to fail the load/save that requested the sweep.
  }
}

/**
 * The AGGRESSIVE sibling of `sweepStaleTempFiles`, for a target whose orphaned temp is a live
 * credential (a token, a cookie, a device bearer). With no age grace it removes the legacy fixed
 * `<target>.tmp` and every pid-bearing temp whose pid is not this process's. Temps bearing our own
 * pid stay: one may be a concurrent write sitting between its `writeFile` and its `rename`.
 *
 * This deliberately gives up what `sweepStaleTempFiles` protects. A foreign pid can be a second
 * LIVE process on the same directory (desktop multi-instance, two servers on one `--data-dir`, the
 * host agent on ~/.nodeterm), and deleting its temp makes that process's rename fail with ENOENT,
 * rethrown to its caller. The callers accept that trade because the alternative is worse for
 * them: a unique temp name is never written twice, so an orphan holding a secret would otherwise
 * sit on disk at 0600 forever.
 *
 * It recognizes exactly the shapes `atomicTempCandidate` does, so a change to `tempNameFor`
 * reaches both sweeps. This rule used to be re-typed at five call sites, each with its own copy of
 * the temp-name regex. Best effort: an unreadable directory never fails the caller's save.
 */
export async function sweepForeignTempFiles(target: string): Promise<void> {
  try {
    const directory = path.dirname(target)
    const base = path.basename(target)
    for (const entry of await fs.readdir(directory)) {
      const candidate = atomicTempCandidate(base, entry)
      if (!candidate || candidate.ownerPid === process.pid) continue
      await fs.rm(path.join(directory, entry), { force: true }).catch(() => undefined)
    }
  } catch {
    // A directory we cannot read is not a reason to fail (or skip) the save that requested it.
  }
}

/**
 * Delete `target`, retrying the same transient Windows codes, and treating "already gone" as
 * success. Returns false if it is still there afterwards.
 *
 * Deleting has the identical Windows hazard as renaming — a scanner or sync client holding the
 * file open makes `unlink` fail with `EPERM` — but it usually matters less, because a failed
 * delete leaves litter and says so, where a failed rename lost the write silently.
 *
 * The case it matters for is a delete whose PURPOSE is to stop something happening. Removing the
 * relay advertisement is one: it exists so phones stop minting tokens against a host that will
 * never answer, so a delete that quietly fails leaves the user's "phone access off" unenforced.
 *
 * The trap this closes is not the retry, it is the reporting. Such a delete is normally written
 * as an unlink wrapped in a bare catch commented "already absent", which is correct for the
 * failure the author had in mind and wrong for every other one: ENOENT really is fine, and EPERM
 * means the file is still sitting there. Only ENOENT counts as gone here.
 */
export async function removeAtomic(target: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.unlink(target)
      return true
    } catch (e) {
      const code = codeOf(e)
      if (code === 'ENOENT') return true // genuinely absent — the caller's goal is met
      if (attempt >= RETRY_DELAYS_MS.length || !TRANSIENT.has(code)) return false
      await sleep(RETRY_DELAYS_MS[attempt])
    }
  }
}

/** The counter keeps names readable and ordered within this module instance. It is not the unique
 *  dimension: workers and separate PID namespaces can share a pid and start their counters at 1. */
let writeSeq = 0

export interface TempNameOptions {
  /** Deterministic seams for behavior tests that model separate PID namespaces/module instances. */
  pid?: number
  sequence?: number
  uuid?: () => string
}

export interface ClearAtomicTargetResult {
  /** True only when the canonical path is absent and no recognized publication temp remains. */
  cleared: boolean
  /** Whether the canonical path was removed (or was already absent). */
  canonicalRemoved: boolean
  /** Recognized legacy/current temps retained because they may be live or could not be removed. */
  retainedTempCount: number
  /** False when the parent directory could not be inspected, so absence cannot be claimed. */
  inspectionComplete: boolean
}

/**
 * Remove an atomic target without claiming a credential clear that did not actually finish.
 *
 * The ordinary sweep remains conservative: a pid-bearing temp may be a live writer in another PID
 * namespace at any age and must not be deleted merely because signal 0 reports ESRCH here. Clear removes
 * the canonical file, then reports every recognized temp still present. Callers can surface an
 * explicit incomplete-clear error instead of telling the UI that a PAT/cookie is gone while its
 * bearer bytes remain next door. This is a point-in-time result, not a cross-process lock; a
 * foreign writer that publishes after the inspection still has last-publisher semantics.
 */
export async function clearAtomicTarget(
  target: string,
  opts: SweepStaleTempOptions = {}
): Promise<ClearAtomicTargetResult> {
  await sweepStaleTempFiles(target, opts)
  const removeSucceeded = await removeAtomic(target)
  const directory = path.dirname(target)
  const base = path.basename(target)
  let retainedTempCount = 0
  let inspectionComplete = true
  try {
    const entries = await fs.readdir(directory)
    retainedTempCount = entries.filter((entry) => atomicTempCandidate(base, entry) !== null).length
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') inspectionComplete = false
  }
  // A foreign writer can rename its temp onto the canonical path after our unlink and before the
  // directory scan. Temp-count zero is therefore not enough: recheck the destination last so this
  // point-in-time result cannot report success over a credential that has already reappeared.
  let canonicalAbsent = removeSucceeded
  if (canonicalAbsent) {
    try {
      await fs.lstat(target)
      canonicalAbsent = false
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') canonicalAbsent = false
    }
  }
  return {
    cleared: canonicalAbsent && inspectionComplete && retainedTempCount === 0,
    canonicalRemoved: canonicalAbsent,
    retainedTempCount,
    inspectionComplete
  }
}

/**
 * A temp path for publishing over `target`, unique per call.
 *
 * The second bug that lives at every temp-then-rename site, independent of the platform question
 * above: a **fixed** name (always `<file>.tmp`). Two writers then share one temp path, so one
 * writer's rename publishes the other's half-written bytes — or moves the temp out from under it,
 * and the loser fails with a confusing `ENOENT` that says nothing about what actually happened.
 *
 * The UUID is the uniqueness guarantee. PID plus a module counter is useful ownership/diagnostic
 * metadata, but is not globally unique: two containers can both be PID 1, worker isolates share a
 * PID while loading separate module counters, and an OS can reuse a PID after crash litter remains.
 *
 * The cost of uniqueness is that a temp never self-heals the way a fixed one did, where the next
 * save simply overwrote the litter. Every caller therefore owes its own cleanup on failure —
 * `writeFileAtomic` does it for you, and a site that builds its own sequence must do it by hand.
 */
export function tempNameFor(target: string, opts: TempNameOptions = {}): string {
  const pid = opts.pid ?? process.pid
  const sequence = opts.sequence ?? ++writeSeq
  const uuid = opts.uuid ?? randomUUID
  return `${target}.${pid}.${sequence}.${uuid()}.tmp`
}

/**
 * Write `data` to `target` atomically: unique temp file, then a retrying rename.
 *
 * The temp name is unique per call, which matters wherever more than one writer can reach a store
 * with nothing queueing them. With one shared `<file>.tmp`, a writer's rename publishes the
 * other's half-written bytes — or moves the temp out from under it, so the loser's rename fails
 * with a confusing ENOENT.
 *
 * A failed write removes its own temp (a unique name never self-heals the way a fixed one did,
 * where the next save simply reused it) and rethrows. The OLD file is left byte-for-byte intact
 * either way, which is the half callers depend on when they report a save as not persisted.
 */
export async function writeFileAtomic(
  target: string,
  data: string,
  opts: { mode?: number } = {}
): Promise<void> {
  const tmp = tempNameFor(target)
  try {
    // `wx`: fail if the temp already exists rather than following it. The name is unique per call,
    // so this never fires in normal operation — its job is to refuse a symlink an attacker
    // pre-planted at the (now guessable-in-principle) temp path, so a publish can never be
    // redirected to write through it. On the expected fresh path it is a plain exclusive create.
    await fs.writeFile(tmp, data, { encoding: 'utf-8', flag: 'wx', ...opts })
    await renameAtomic(tmp, target)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}
