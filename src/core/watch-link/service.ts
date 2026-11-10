// The live-link registry (docs/live-links.md): the owner's side of every link this machine hosts —
// at most MAX_LINKS_PER_MACHINE, each with its link host (link-host.ts). Records are persisted
// (spec D8) and resumed at launch. Owner state goes to OWNER clients only (`sendToOwners`): every
// view carries the link's URL, and the URL carries the secret.
//
// A LINK ENDS on: the owner's Stop (`revoke`, no notice — the owner did it), Stop all (`revokeAll`,
// one server call, awaited and reported — it is what reaches other machines' links), its expiry (a timer, plus a re-check on every host change because timers are
// monotonic and a closed lid pauses them — G24), the node leaving every project, or the server saying
// it is gone (a mint or status answering 410 — `onGone`, which does raise a notice).
//
// NODE GONE IS TRI-STATE (controller ruling R40). `nodeState` answers present / absent / unknown, and
// only ABSENT ends a link and revokes it server-side: an empty answer during the launch-time workspace
// load, or for a node in a project whose file was not read this run, is not evidence the node is gone,
// and a revoke cannot be undone. `init()` first waits for the workspace load it is handed, then keeps
// (and hosts) a link whose node is unknown — its join is join-only, so a node that never comes back
// costs a waiting viewer, never a spawned session. Create requires PRESENT. The same check runs before
// every join (R29): the link host is registry-free, so the registry wraps its `pty.join`.
//
// PERSISTENCE never blocks the owner (Task 9 note B, spec revoke order). Ending a link removes the
// record and ISSUES the write (the store snapshots at call time) before the sessions end, and never
// waits for it before the server revoke: a disk that hangs must not keep a revoked link's viewers
// connected or its server row alive. A create does wait for its write (a link that cannot be
// written must not exist: the server row is revoked), but no longer than PERSIST_TIMEOUT_MS.
// A links file that could not be read (WatchLinkStoreUnreadable) turns this run MEMORY-ONLY: the
// store is latched and never written, links still work and end at quit, and the owner is told on
// every create (R22, R42c). A keychain that refuses to SEAL is narrower (R45): the store still writes
// every link it holds a sealed form of — read at boot or sealed earlier this run — so only a link that
// was never sealed (the one just created) is not saved; it answers memory-only, and the owner is told.
// `init()` writes only when it actually pruned something (R42a), so a boot never rewrites the file.
//
// ENTITLEMENT. A host never mints with an empty entitlement (the API would answer 400, which stops
// minting for good): it answers itself a local refusal, and `onEntitlementChanged` re-arms every host
// the API refused once the license layer reports a change — a 7-day token expiring under a running
// link is the ordinary case (R41).
//
// CONTROL LINKS (role 'controller'). The password is checked by `controlPasswordProblem` and hashed
// (scrypt, ./password.ts) BEFORE the server row is created, so a hash that fails creates nothing; only
// {salt, hash} is kept, never the plaintext, and nothing logged carries the password, the hash or the
// salt. Every scrypt run of this process — the hosts' unlock checks and the owner's new passwords — goes
// through ONE FIFO gate of SCRYPT_SLOTS (each run is ~32 MiB and ~80 ms on libuv's 4-thread pool, and
// unlock attempts arrive from strangers): a run waits for a slot, it is never refused. The lock the
// link host asks for (`onControlLocked`) is set on the record synchronously — the host reads the record
// live — and is never undone by a failed write. So is the link-wide count of wrong attempts the host
// reports (`onWrongAttempt`): it goes on the record and is written, at most WRONG_PER_LINK writes per
// link (the last rides the lock's), so an app restart does not reset it; a new password and Allow
// control again reset it. The owner's changes go by DIRECTION. One that NARROWS access (typing off, a
// new password) is the owner's brake: it reaches the record and the host at once — a leaked password or
// an unwanted typist must not wait on the disk — and is NEVER undone: a write that fails or does not
// answer within PERSIST_TIMEOUT_MS answers 'unsaved' (in force now, undone by a restart unless a later
// write lands — every write carries the whole list from memory, so the next one that lands saves it;
// Stop ends it for good). One that WIDENS it (typing on, allow again) is written first, from a copy of
// the record, and reaches the record and the host only once that write landed: nobody can unlock and
// type during a write the owner is then told failed, which answers false. The owner is never told a
// change was kept that the next launch would not have. A later change to the same field supersedes an
// earlier one still being written (its late apply is skipped).
//
// AN UNLIMITED LINK (`ttlSeconds` 0) has `expiresAt: null`: no expiry timer, no expiry check on a host
// change, never pruned for time at launch. It ends like any link otherwise, and when its owner's Pro
// lapses the server refuses its host-token mint (402) — the host stops minting and the view says
// `refused`, the same state as any refused mint.
//
// THE SERVER EDITION registers this same service with `unsupported: true` until it has a license layer
// (R43): create answers `unsupported`, list answers [], nothing is loaded, hosted or revoked. The same
// mode is what a Server Edition that does not own its data dir would need (G15).
//
// Nothing here throws out of a callback or a void promise; every timer is cleared by `end`/`shutdown`.
import type { CorePlatform } from '../platform'
import type { WorkspaceStore } from '../workspace-store'
import { IPC } from '../../shared/ipc'
import { isSafeNodeId } from '../../shared/safe-id'
import { formatWatchLink } from '../../shared/watch-link/link'
import { deriveWatchLinkKeys, newWatchLinkSecret, sha256Hex } from '../../shared/watch-link/keys'
import type { WatchChatMessage, WatchLinkEndReason } from '../../shared/watch-link/protocol'
import {
  LABEL_MAX,
  MAX_LINKS_PER_MACHINE,
  TITLE_MAX,
  WATCH_LINK_TTLS,
  stripBidiControls,
  type ControlSupport,
  type ControlChangeResult,
  type CreateWatchLinkError,
  type CreateWatchLinkRequest,
  type CreateWatchLinkResult,
  type RevokeAllOutcome,
  type WatchLinkNotice,
  type WatchLinkView,
  type WatchLinkViewerView
} from '../../shared/watch-link-types'
import { controlPasswordProblem } from '../../shared/watch-link-password'
import type { HostTokenResult, WatchLinkApi as WatchLinkApiClient } from './api'
import { WRONG_PER_LINK, createLinkHost, type LinkHost, type QuietClients, type WatchPty } from './link-host'
import type { HistoryRead } from './history'
import { hashControlPassword, verifyControlPassword, type ControlPasswordHash } from './password'
import {
  CONTROL_LOCK_STEP_MAX,
  WatchLinkStoreUnreadable,
  controlLockMs,
  type WatchLinkControlRecord,
  type WatchLinkRecord,
  type WatchLinkStore
} from './store'
import type { RelayTransport } from '../relay/relay-socket'
import { errorText } from '../../shared/error-text'
import { CONTROL_LOCK_MAX_MS } from '../../shared/watch-link/protocol'

/** setTimeout's own ceiling (a longer delay fires at once). A link lives ≤ 24 h, far below it. */
const MAX_DELAY_MS = 2_147_483_647
/** The longest a create waits for its local write (or for the links file's boot load). */
export const PERSIST_TIMEOUT_MS = 10_000
/** The longest `init()` waits for the boot workspace load before deciding with the nodes it cannot
 *  place yet read as unknown (which keeps their links: the safe side). */
export const WORKSPACE_READY_TIMEOUT_MS = 10_000
/** Concurrent scrypt runs (unlock checks and new passwords) this process allows. */
export const SCRYPT_SLOTS = 2

export type WatchLinkNodeState = 'present' | 'absent' | 'unknown'

export interface WatchLinkServiceDeps {
  api: WatchLinkApiClient
  relayUrl: string
  store: Pick<WatchLinkStore, 'load' | 'save' | 'discardOpaque' | 'opaqueCount'>
  /** The stored Pro entitlement token, or null. Travels only in the API client's JSON body. */
  entitlement(): string | null
  /** False in a build that may not relay (an unpackaged dev build): no create, and resumed links
   *  are kept but not hosted (G21) — a dev run must not host the installed app's links. */
  relayAllowed(): boolean
  /** Is the node in some project (present), provably in none (absent), or cannot be told (unknown)?
   *  The shells answer with `workspaceNodeState`. */
  nodeState(nodeId: string): WatchLinkNodeState
  /** Resolves once the workspace index has been read: `init()` decides nothing before it (R40). */
  workspaceReady?(): Promise<unknown>
  clients: QuietClients
  pty: WatchPty
  /** Owner clients only (`sendToOwners`). */
  emit(channel: string, ...args: unknown[]): void
  /** Can this node's terminal take a Control link's input (`PtyManager.nodeControlSupport`)? Absent,
   *  throwing or anything else answers `unknown`, which leaves the create to decide. */
  controlSupport?(nodeId: string): ControlSupport
  /** Read-back (`watch:history`): one transcript page of `nodeId`'s conversation ending at `before`
   *  (null: the newest), through the SAME reader as the ⌘M panel and the phone's `chat.page`. Rejects
   *  on a failed read. The link host cuts every page at the link's creation (./history.ts); the reader
   *  knows nothing of links. Absent: viewers are told read-back is not available. */
  history?(nodeId: string, before: number | null): Promise<HistoryRead>
  /** Is `nodeId` an agent whose conversation `history` can read? Rides every join's meta. */
  historySupported?(nodeId: string): boolean
  /** This shell cannot host links (the Server Edition until it has a license layer — R43). */
  unsupported?: boolean
  now?(): number
  setTimeout?(fn: () => void, ms: number): unknown
  clearTimeout?(h: unknown): void
  /** TEST ONLY. */
  persistTimeoutMs?: number
  /** TEST ONLY. */
  workspaceWaitMs?: number
  /** TEST ONLY. */
  createHost?: typeof createLinkHost
  /** TEST ONLY: the relay transport the link hosts dial. */
  transport?: () => RelayTransport
  /** TEST ONLY: scrypt's hash (./password.ts). */
  hashPassword?: (pw: string) => Promise<ControlPasswordHash>
  /** TEST ONLY: scrypt's check (./password.ts). */
  verifyPassword?: (pw: string, h: ControlPasswordHash) => Promise<boolean>
}

export interface WatchLinkService {
  /** Load and resume the persisted links. Idempotent (one promise); never rejects. */
  init(): Promise<void>
  create(req: unknown): Promise<CreateWatchLinkResult>
  list(): WatchLinkView[]
  revoke(linkId: string): Promise<void>
  /** Stop this machine's links at once, then ask the server to revoke every link of the license and
   *  answer what that reached (`RevokeAllOutcome`). Never rejects. */
  revokeAll(): Promise<RevokeAllOutcome>
  kick(linkId: string, viewerId: string): boolean
  sendChat(linkId: string, text: string): WatchChatMessage | null
  chatHistory(linkId: string): WatchChatMessage[]
  /** After every workspace load/save: a node that is now ABSENT ends its links. */
  onWorkspaceChanged(): void
  /** After the license layer reports a change: re-arm every host the API refused. */
  onEntitlementChanged(): void
  /** A live Control link: turn typing on or off (`ControlChangeResult`). False for any other link, or
   *  typing ON that could not be saved (then nothing changed); 'unsaved' for typing OFF that could not
   *  be saved (it holds all the same). */
  setControl(linkId: string, enabled: boolean): Promise<ControlChangeResult>
  /** A live Control link: replace its password (every controller drops back to watching, the link-wide
   *  wrong count starts over). False for a password `controlPasswordProblem` refuses, any other link,
   *  or a hash that failed; 'unsaved' for a new password in force that could not be saved. */
  setPassword(linkId: string, pw: string): Promise<ControlChangeResult>
  /** A live Control link locked by wrong passwords: allow unlocking again. False as setControl. */
  allowControl(linkId: string): Promise<boolean>
  /** Whether this node's terminal can take a Control link's input (the create dialog asks). */
  controlSupport(nodeId: string): ControlSupport
  /** Stop every host (`host-stopping`), keep the records for the next launch. Resolves once the
   *  last write this service issued has settled (the caller bounds it). */
  shutdown(): Promise<void>
}

/**
 * The node-gone rule over the workspace store, shared by both shells: present when some project
 * holds the node; absent only when the store has a COMPLETE read of every project
 * (`knownNodeIdsStrict`) and the node is not in it; unknown otherwise (the index not loaded yet, a
 * project file not read this run, an SSH project with no cache, an index rebuilt from nothing this
 * run). The STRICT accessor, never the mirror's `knownNodeIds`: absent here revokes a link for good.
 */
export function workspaceNodeState(
  store: Pick<WorkspaceStore, 'projectIdsForNode' | 'knownNodeIdsStrict'>,
  nodeId: string
): WatchLinkNodeState {
  if (store.projectIdsForNode(nodeId).length > 0) return 'present'
  const known = store.knownNodeIdsStrict()
  if (!known) return 'unknown'
  return known.has(nodeId) ? 'present' : 'absent'
}

// C0/C1 controls and DEL; the bidi controls are `stripBidiControls`'s.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g

/** A label or title as the owner typed it (or as a git-shared node title says): controls and bidi
 *  overrides gone, trimmed, capped at `max` UTF-16 units — the unit the store checks on load —
 *  without splitting a surrogate pair. null when nothing is left. */
function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const s = stripBidiControls(raw.replace(CONTROLS, '')).trim()
  let out = ''
  for (const ch of s) {
    if (out.length + ch.length > max) break
    out += ch
  }
  out = out.trim()
  return out || null
}

/** A create request as the owner sent it: everything checked, the password apart from the request
 *  (only a Control link carries one; another role's `password` field is ignored). */
type ParsedRequest = { req: Omit<CreateWatchLinkRequest, 'password'>; password: string | null }

function parseRequest(raw: unknown): ParsedRequest | 'bad-request' | 'bad-password' {
  if (!raw || typeof raw !== 'object') return 'bad-request'
  const r = raw as Record<string, unknown>
  // `isSafeNodeId` coerces: `12` passes its regex. The type check comes first.
  if (typeof r.nodeId !== 'string' || !isSafeNodeId(r.nodeId)) return 'bad-request'
  if (r.role !== 'viewer' && r.role !== 'commenter' && r.role !== 'controller') return 'bad-request'
  // 0 is Unlimited: no end time.
  if (!(WATCH_LINK_TTLS as readonly unknown[]).includes(r.ttlSeconds)) return 'bad-request'
  const label = cleanText(r.label, LABEL_MAX)
  if (!label) return 'bad-request'
  const title = cleanText(r.title, TITLE_MAX) ?? 'Terminal'
  const req: ParsedRequest['req'] = { nodeId: r.nodeId, role: r.role, ttlSeconds: r.ttlSeconds as CreateWatchLinkRequest['ttlSeconds'], label, title }
  if (r.role !== 'controller') return { req, password: null }
  if (controlPasswordProblem(r.password) !== null) return 'bad-password'
  return { req, password: r.password as string }
}

/**
 * At most `slots` tasks run at once; the rest wait, and get a slot in the order they asked (FIFO). A
 * task's failure (a rejection, or a throw) frees its slot like a success. Nothing is ever refused.
 */
export function createFifoGate(slots: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  const release = (): void => {
    const next = waiting.shift()
    if (next) next() // the slot passes straight to the next in line
    else active--
  }
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        let p: Promise<T>
        try {
          p = Promise.resolve(task())
        } catch (err) {
          p = Promise.reject(err)
        }
        p.then(resolve, reject).finally(release)
      }
      if (active < slots) {
        active++
        run()
      } else waiting.push(run)
    })
}

/** A live Control link's record, with its control state. */
type ControlRecord = WatchLinkRecord & { control: WatchLinkControlRecord }

/** A chat message as the OWNER is shown it: whatever a viewer wrote, without bidi overrides. */
function ownerChat(msg: WatchChatMessage): WatchChatMessage {
  return { ...msg, name: stripBidiControls(msg.name), text: stripBidiControls(msg.text) }
}

/** Send to the machine's OWNER clients only — never a relay peer, never a live link's viewer. */
export function sendToOwners(
  p: Pick<CorePlatform, 'clientIds' | 'isOwnerClient' | 'sendTo'>,
  channel: string,
  ...args: unknown[]
): void {
  for (const id of p.clientIds()) if (p.isOwnerClient?.(id) === true) p.sendTo(id, channel, ...args)
}

/** An error's NAME only: what failed around a password (its hash, its check) may be in the message. */
const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'not an Error')
const TIMEOUT = Symbol('timeout')

export function createWatchLinkService(deps: WatchLinkServiceDeps): WatchLinkService {
  const now = deps.now ?? Date.now
  const setT = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const createHost = deps.createHost ?? createLinkHost
  const persistTimeoutMs = deps.persistTimeoutMs ?? PERSIST_TIMEOUT_MS
  const workspaceWaitMs = deps.workspaceWaitMs ?? WORKSPACE_READY_TIMEOUT_MS
  const hashPassword = deps.hashPassword ?? hashControlPassword
  const verifyPassword = deps.verifyPassword ?? verifyControlPassword
  // ONE gate for every scrypt run of this service — the process has one — whichever link asks.
  const scrypt = createFifoGate(SCRYPT_SLOTS)
  // A wait on init covers init's own (bounded) workspace wait plus the links file's load: init's
  // bound always fires first, so a slow workspace never reads as a failed write.
  const initWaitMs = workspaceWaitMs + persistTimeoutMs
  const unsupported = deps.unsupported === true

  const records = new Map<string, WatchLinkRecord>()
  /** Created server-side, being written: in every write's snapshot (a concurrent write must not drop
   *  it from disk), but not yet a link — not listed, not hosted, and no stop path can end it half-way. */
  const writing = new Map<string, WatchLinkRecord>()
  const hosts = new Map<string, LinkHost>()
  const expiry = new Map<string, unknown>()
  /** A timed wrong-password lock's timer, per link (finding L2). */
  const lockTimers = new Map<string, unknown>()
  let initPromise: Promise<void> | null = null
  /** Creates between their cap check and their answer (G17): they count against the cap. A create's
   *  record joins `records` only as it answers, so it is never counted twice. */
  let creating = 0
  let stopped = false
  /** The links file could not be read: never write it this run (R22). */
  let storeLatched = false
  /** The last write could not seal (the keychain refused): links live in memory only. */
  let sealRefused = false
  let lastWrite: Promise<unknown> = Promise.resolve()

  const fail = (error: CreateWatchLinkError): CreateWatchLinkResult => ({ ok: false, error })
  const warn = (line: string): void => console.warn(`[watch-link] ${line}`)
  const warned = new Set<string>()
  const warnOnce = (kind: string, line: string): void => {
    if (warned.has(kind)) return
    warned.add(kind)
    warn(line)
  }
  const persistentNow = (): boolean => !storeLatched && !sealRefused

  function safeEmit(channel: string, ...args: unknown[]): void {
    try {
      deps.emit(channel, ...args)
    } catch (err) {
      warn(`telling the owner failed: ${errorText(err)}`)
    }
  }
  const notice = (n: WatchLinkNotice): void => safeEmit(IPC.watchLinkNotice, n)

  function nodeStateOf(nodeId: string): WatchLinkNodeState {
    try {
      const s = deps.nodeState(nodeId)
      return s === 'present' || s === 'absent' ? s : 'unknown'
    } catch {
      return 'unknown' // a check that cannot answer is never evidence of absence
    }
  }

  /** `p`'s answer, or TIMEOUT after `ms` (the timer is cleared as soon as `p` settles). A rejection
   *  reads as a timeout: either way the caller got no answer. */
  function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
    return new Promise((resolve) => {
      const h = setT(() => resolve(TIMEOUT), ms)
      p.then(
        (v) => {
          clearT(h)
          resolve(v)
        },
        () => {
          clearT(h)
          resolve(TIMEOUT)
        }
      )
    })
  }

  function viewOf(r: WatchLinkRecord): WatchLinkView {
    const h = hosts.get(r.linkId)
    // No host: a build that may not relay (G21), or a host that could not be built — nobody can
    // watch it, which is what `refused` says.
    let status: WatchLinkView['status'] = 'refused'
    let viewers: WatchLinkViewerView[] = []
    if (h) {
      try {
        status = h.status()
        viewers = h.viewers().map((v) => ({
          viewerId: v.viewerId,
          name: v.name === null ? null : stripBidiControls(v.name),
          joinedAt: v.joinedAt,
          waiting: v.waiting === true,
          controlling: v.controlling === true,
          typing: v.typing === true
        }))
      } catch (err) {
        warn(`reading a link's state failed: ${errorText(err)}`)
      }
    }
    return {
      linkId: r.linkId,
      nodeId: r.nodeId,
      role: r.role,
      label: stripBidiControls(r.label),
      title: stripBidiControls(r.title),
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      url: formatWatchLink(r.linkId, r.secret),
      status,
      viewers,
      control:
        r.role === 'controller' && r.control
          ? {
              enabled: r.control.enabled,
              locked: r.control.locked,
              lockedUntil: r.control.locked && typeof r.control.lockedUntil === 'number' ? r.control.lockedUntil : null
            }
          : null
    }
  }
  const list = (): WatchLinkView[] => (unsupported ? [] : [...records.values()].map(viewOf))
  // Coalesced (R46/M7): ending a link stops its host, whose `stop` reports a change, and then the end
  // reports its own; a shutdown stops every host. One push per synchronous burst — each push carries
  // every link's URL, and the list is read when the push goes out, so it is never stale.
  let statePending = false
  const emitState = (): void => {
    if (statePending) return
    statePending = true
    queueMicrotask(() => {
      statePending = false
      // `formatWatchLink` throws on a record it could not make a URL of. Every record passed its
      // checks (the API client's link-id rule, the store's load rules), but a throw here would be
      // uncaught inside a microtask, so it is caught and reported instead.
      try {
        safeEmit(IPC.watchLinkState, list())
      } catch (err) {
        warn(`listing live links failed: ${errorText(err)}`)
      }
    })
  }
  /** Links this machine holds but cannot host this run (sealed, keychain locked) — they count against
   *  the cap like any link (R46/M3). */
  const opaqueHeld = (): number => {
    try {
      return deps.store.opaqueCount()
    } catch {
      return 0
    }
  }

  /** Write the current records. Called, not awaited, wherever the owner must not wait on the disk;
   *  the store snapshots at call time and serializes its writes, so disk order is call order.
   *  `instead` is written in place of the record with its id (a change not yet applied in memory). */
  function persist(instead?: WatchLinkRecord): Promise<boolean> {
    if (storeLatched) return Promise.resolve(true) // memory-only this run: nothing is written
    const list = [...records.values(), ...writing.values()].map((x) => (instead && x.linkId === instead.linkId ? instead : x))
    const p = deps.store.save(list).then(
      (outcome) => {
        sealRefused = outcome === 'memory-only'
        return outcome !== 'failed'
      },
      () => false
    )
    lastWrite = p
    return p
  }

  function controlSupportOf(nodeId: string): ControlSupport {
    try {
      const s = deps.controlSupport?.(nodeId)
      return s === 'ok' || s === 'unsupported' ? s : 'unknown'
    } catch {
      return 'unknown' // a check that cannot answer leaves the create to decide
    }
  }

  /** The scrypt check of a Control link, through the gate. The record's {salt, hash} is read when the
   *  check RUNS — a password change swaps them in place, and a check queued for a slot meanwhile must
   *  be made against the new one. Never rejects (a failed check is a wrong password). */
  function checkPassword(r: WatchLinkRecord, pw: string): Promise<boolean> {
    if (r.role !== 'controller' || !r.control) return Promise.resolve(false)
    return scrypt(() => {
      const c = r.control
      return c ? verifyPassword(pw, { salt: c.salt, hash: c.hash }) : Promise.resolve(false)
    }).then(
      (ok) => ok === true,
      (err) => {
        warn(`checking a control password failed (${errorName(err)})`)
        return false
      }
    )
  }

  function revokeServer(linkId: string): void {
    const ent = deps.entitlement()
    if (!ent) return
    void deps.api.revoke(linkId, ent).catch(() => false) // best effort (the client never rejects)
  }

  function armExpiry(r: WatchLinkRecord): void {
    const t = expiry.get(r.linkId)
    if (t !== undefined) clearT(t)
    expiry.delete(r.linkId)
    const at = r.expiresAt
    if (at === null) return // an Unlimited link: no end time, no timer
    const delay = Math.min(MAX_DELAY_MS, Math.max(0, at - now()))
    expiry.set(
      r.linkId,
      setT(() => {
        expiry.delete(r.linkId)
        if (records.get(r.linkId) !== r) return
        if (now() < at) armExpiry(r) // a clamped delay: not yet
        else end(r.linkId, 'expired', { serverRevoke: false, notify: true })
      }, delay)
    )
  }

  /**
   * A Control link's wrong-password lock lifts by itself at `lockedUntil` (finding L2): arm that, or
   * lift it now when its time has passed (an app restart past it, a lid-close). A lock with no
   * `lockedUntil` (one written before timed locks) has nothing to arm: it waits for the owner, as it
   * always did. A `lockedUntil` further away than the longest lock (the clock went back, a hand edit)
   * is brought in to that: no lock outlasts `CONTROL_LOCK_MAX_MS` from now.
   */
  function armLock(r: WatchLinkRecord): void {
    const t = lockTimers.get(r.linkId)
    if (t !== undefined) clearT(t)
    lockTimers.delete(r.linkId)
    const c = r.control
    if (!c || !c.locked || typeof c.lockedUntil !== 'number') return
    if (c.lockedUntil - now() > CONTROL_LOCK_MAX_MS) c.lockedUntil = now() + CONTROL_LOCK_MAX_MS
    const until = c.lockedUntil
    const delay = until - now()
    if (delay <= 0) {
      liftLock(r, until)
      return
    }
    lockTimers.set(
      r.linkId,
      setT(() => {
        lockTimers.delete(r.linkId)
        liftLock(r, until)
      }, Math.min(MAX_DELAY_MS, delay))
    )
  }
  /** The lock armed for `until` lifts: unlocking is allowed again and the link-wide count starts over;
   *  `lockStep` stays, so the next lock lasts twice as long. Nothing if the link ended, or the lock
   *  changed meanwhile (lifted by the owner, or a new lock). The record changes first and is then
   *  written; a write that fails changes nothing that matters — a `lockedUntil` in the past reads as
   *  lifted at the next launch too. */
  function liftLock(r: WatchLinkRecord, until: number): void {
    const c = r.control
    if (stopped || !c || !c.locked || c.lockedUntil !== until) return
    if (now() < until) {
      armLock(r) // a clamped delay: not yet
      return
    }
    c.locked = false
    c.lockedUntil = null
    c.wrong = 0
    // The link may still be loading (`init` lifts a lapsed lock before any host exists).
    if (records.get(r.linkId) !== r) return
    tellHost(r.linkId, (h) => h.allowControl())
    emitState()
    void persist().then((saved) => {
      if (!saved) warn("a Control link's lifted lock could not be saved; it reads as lifted at the next launch anyway")
    })
  }

  /** The host's pty seam, with the node-gone check before every join (R29, G8). */
  function guardedPty(r: WatchLinkRecord): WatchPty {
    return {
      join: async (clientId, nodeId, viewerId) => {
        // Off the link host's own call stack: ending the link stops that host.
        await Promise.resolve()
        if (nodeStateOf(nodeId) === 'absent') {
          end(r.linkId, 'node-gone', { serverRevoke: true, notify: true })
          return null
        }
        return deps.pty.join(clientId, nodeId, viewerId)
      },
      leave: (clientId, sessionId, viewerId) => deps.pty.leave(clientId, sessionId, viewerId),
      captureVisible: (sessionId) => deps.pty.captureVisible(sessionId),
      syncSize: (sessionId) => deps.pty.syncSize(sessionId),
      alive: (sessionId) => deps.pty.alive(sessionId),
      input: (sessionId, chunk, isCurrent) => deps.pty.input(sessionId, chunk, isCurrent)
    }
  }

  function onHostChange(linkId: string): void {
    const r = records.get(linkId)
    if (r && r.expiresAt !== null && now() >= r.expiresAt) {
      // A reconnect after a lid-close: the expiry timer may not have fired yet (G24). Deferred: this
      // runs inside the link host's own status callback, and ending the link stops that host.
      queueMicrotask(() => end(linkId, 'expired', { serverRevoke: false, notify: true }))
      return
    }
    emitState()
  }

  function start(r: WatchLinkRecord): void {
    if (stopped || hosts.has(r.linkId)) return
    armExpiry(r)
    // Before the host exists: a lock whose time passed while nodeterm was closed is lifted first, so the
    // host starts from a wrong count of 0.
    armLock(r)
    if (!deps.relayAllowed()) return // kept and listed `refused`, never hosted (G21)
    let host: LinkHost
    try {
      host = createHost(r, {
        relayUrl: deps.relayUrl,
        mint: async (): Promise<HostTokenResult> => {
          const ent = deps.entitlement()
          // Never a request with an empty entitlement: the API answers 400, and a 400 stops minting
          // for good. The same end state, reached locally; `onEntitlementChanged` re-arms it (R41).
          if (!ent) return { ok: false, kind: 'refused', status: 402 }
          return deps.api.hostToken(r.linkId, ent)
        },
        status: async () => {
          const ent = deps.entitlement()
          return ent ? deps.api.status(r.linkId, ent) : 'unknown'
        },
        clients: deps.clients,
        pty: guardedPty(r),
        transport: deps.transport,
        now,
        setTimeout: setT,
        clearTimeout: clearT,
        onChange: () => onHostChange(r.linkId),
        onChat: (msg) => safeEmit(IPC.watchLinkChat, r.linkId, ownerChat(msg)),
        onViewerJoined: (count) =>
          notice({ kind: 'joined', linkId: r.linkId, nodeId: r.nodeId, title: stripBidiControls(r.title), viewers: count }),
        onGone: (reason) => end(r.linkId, reason, { serverRevoke: false, notify: true }),
        verifyPassword: (pw) => checkPassword(r, pw),
        // Bound to THIS link's node: a viewer names no node, only a cursor.
        ...(deps.history ? { history: (before: number | null) => deps.history!(r.nodeId, before) } : {}),
        ...(deps.historySupported ? { historySupported: () => deps.historySupported!(r.nodeId) } : {}),
        onControlTaken: (name) => {
          notice({
            kind: 'control-taken',
            linkId: r.linkId,
            nodeId: r.nodeId,
            title: stripBidiControls(r.title),
            // A name the viewer gave itself (sanitized by the host); no bidi override reaches the owner.
            name: stripBidiControls(String(name))
          })
          emitState()
        },
        onControlLocked: (by) => {
          // SYNCHRONOUSLY, before any I/O: the host's lock rests on this flag (it reads the record live
          // and never writes it). Never undone by a failed write: a lock whose write fails still holds,
          // and still lifts at its time (finding L2: it lifts by itself — 15 minutes for the first since
          // the owner last allowed control, doubling each time, 24 h at most).
          const c = r.control
          let until: number | null = null
          if (c) {
            const step = Number.isInteger(c.lockStep) ? (c.lockStep as number) : 0
            until = now() + controlLockMs(step)
            c.locked = true
            c.lockedUntil = until
            c.lockStep = Math.min(CONTROL_LOCK_STEP_MAX, step + 1)
          }
          takeTurn(r, 'locked') // an "allow again" still being written must not land over it
          if (records.get(r.linkId) === r) {
            armLock(r)
            void persist().then((saved) => {
              if (!saved) warn("a Control link's lock could not be saved; a restart would lift it early")
            })
          }
          notice({
            kind: 'control-locked',
            linkId: r.linkId,
            nodeId: r.nodeId,
            title: stripBidiControls(r.title),
            // A name the attempt gave itself (sanitized by the host): a claim, shown as one.
            by: typeof by === 'string' && by ? stripBidiControls(by) : null,
            until
          })
          emitState()
        },
        onWrongAttempt: (count) => {
          // On the record SYNCHRONOUSLY (a later write snapshots it), as an integer 0..WRONG_PER_LINK:
          // the store refuses to write anything else.
          if (!r.control || typeof count !== 'number' || Number.isNaN(count)) return
          r.control.wrong = Math.min(WRONG_PER_LINK, Math.max(0, Math.floor(count)))
          // The count that locks rides the lock's own write (`onControlLocked`, which follows): at most
          // WRONG_PER_LINK writes per link between resets.
          if (r.control.wrong >= WRONG_PER_LINK || records.get(r.linkId) !== r) return
          void persist().then((saved) => {
            if (!saved) warn("a Control link's wrong-attempt count could not be saved; an app restart would reset it")
          })
        }
      })
    } catch (err) {
      warn(`a link could not be hosted: ${errorText(err)}`)
      return
    }
    hosts.set(r.linkId, host)
    try {
      host.start()
    } catch (err) {
      warn(`a link host did not start: ${errorText(err)}`)
    }
  }

  /** Forget the record and its timer; the host is returned for the caller to stop AFTER the write
   *  was issued (spec: delete and write the record first, then end the sessions). */
  function drop(linkId: string): { record: WatchLinkRecord; host: LinkHost | undefined } | null {
    const record = records.get(linkId)
    if (!record) return null
    records.delete(linkId)
    const t = expiry.get(linkId)
    if (t !== undefined) clearT(t)
    expiry.delete(linkId)
    const lt = lockTimers.get(linkId)
    if (lt !== undefined) clearT(lt)
    lockTimers.delete(linkId)
    const host = hosts.get(linkId)
    hosts.delete(linkId)
    return { record, host }
  }
  function stopHost(host: LinkHost | undefined, reason: WatchLinkEndReason): void {
    try {
      host?.stop(reason)
    } catch (err) {
      warn(`stopping a link host failed: ${errorText(err)}`)
    }
  }

  function end(
    linkId: string,
    reason: 'expired' | 'revoked' | 'node-gone',
    o: { serverRevoke: boolean; notify: boolean }
  ): void {
    const gone = drop(linkId)
    if (!gone) return
    void persist()
    stopHost(gone.host, reason)
    emitState()
    if (o.notify) {
      notice({ kind: 'ended', linkId, nodeId: gone.record.nodeId, title: stripBidiControls(gone.record.title), reason })
    }
    if (o.serverRevoke) revokeServer(linkId)
  }

  async function runInit(): Promise<void> {
    if (unsupported) return
    if (deps.workspaceReady) {
      // A failed load leaves nodes unknown, which keeps every link: the safe side. A load that does
      // not finish (a stalled mount) is waited for no longer than WORKSPACE_READY_TIMEOUT_MS (R46/M5).
      const ready = await within(
        Promise.resolve().then(() => deps.workspaceReady!()).then(() => 'ready', () => 'failed'),
        workspaceWaitMs
      )
      if (ready === TIMEOUT) {
        warn(`the workspace did not finish loading within ${workspaceWaitMs} ms; resuming links whose node cannot be placed yet`)
      }
    }
    let loaded: WatchLinkRecord[] = []
    try {
      loaded = await deps.store.load()
    } catch (err) {
      // The store refuses to write over a file it could not read (and latched itself); any other
      // failure is treated the same way, because writing over it is the one unrecoverable mistake.
      storeLatched = true
      const why = err instanceof WatchLinkStoreUnreadable ? `${err.reason}: ${err.message}` : errorText(err)
      warn(`live links will not be saved this run — the links file could not be read (${why})`)
    }
    if (stopped) return
    const t = now()
    let pruned = false
    for (const r of loaded) {
      if (records.has(r.linkId)) continue
      if (r.expiresAt !== null && r.expiresAt <= t) {
        pruned = true
        continue
      }
      if (nodeStateOf(r.nodeId) === 'absent') {
        pruned = true
        revokeServer(r.linkId)
        continue
      }
      if (records.size >= MAX_LINKS_PER_MACHINE) {
        // A hand-edited file: this machine hosts five links at most.
        pruned = true
        revokeServer(r.linkId)
        continue
      }
      records.set(r.linkId, r)
    }
    if (pruned) void persist()
    for (const r of [...records.values()]) start(r)
    emitState()
    if (!persistentNow()) notice({ kind: 'not-persistent' })
  }

  const init = (): Promise<void> =>
    (initPromise ??= runInit().catch((err) => warn(`resuming live links failed: ${errorText(err)}`)))

  /** The record of a LIVE Control link (listed, a controller, with its control state), or null. */
  function liveControl(linkId: unknown): ControlRecord | null {
    if (unsupported || stopped || typeof linkId !== 'string') return null
    const r = records.get(linkId)
    return r && r.role === 'controller' && r.control ? (r as ControlRecord) : null
  }
  function tellHost(linkId: string, fn: (h: LinkHost) => void): void {
    const h = hosts.get(linkId)
    if (!h) return
    try {
      fn(h)
    } catch (err) {
      warn(`telling a link host about a control change failed: ${errorText(err)}`)
    }
  }

  /** Each owner change (and a lock) takes a TURN on the field it touches; an earlier WIDENING of the
   *  same field still being written sees it lost its turn and does not apply (a narrowing applies at
   *  once and is never undone, so it has nothing to skip). */
  type ControlField = 'enabled' | 'locked' | 'password'
  const turns = new WeakMap<WatchLinkRecord, Record<ControlField, number>>()
  function takeTurn(r: WatchLinkRecord, f: ControlField): number {
    const t = turns.get(r) ?? { enabled: 0, locked: 0, password: 0 }
    turns.set(r, t)
    return ++t[f]
  }
  const hasTurn = (r: WatchLinkRecord, f: ControlField, n: number): boolean => turns.get(r)?.[f] === n

  /**
   * An owner's change that NARROWS access (typing off, a new password): the owner's BRAKE. Applied in
   * memory and told to the host AT ONCE, then written — and NEVER undone. A write that fails, or does
   * not answer within PERSIST_TIMEOUT_MS, answers 'unsaved': the change holds until nodeterm quits, and
   * the next write that lands (every write carries the whole list as memory holds it) saves it. Undoing
   * it instead would hand typing back, or re-open a possibly leaked password, because a disk hiccuped.
   */
  async function narrowControl(
    r: ControlRecord,
    field: ControlField,
    o: { apply(): void; host(h: LinkHost): void }
  ): Promise<true | 'unsaved'> {
    takeTurn(r, field) // a widening of this field still being written must not land over it
    o.apply()
    tellHost(r.linkId, o.host)
    emitState()
    const written = await within(persist(), persistTimeoutMs)
    if (written === true) return true
    warn("an owner's change to a Control link could not be saved; it holds until nodeterm quits")
    return 'unsaved'
  }

  /**
   * An owner's change that WIDENS access (typing on, allow again): written FIRST, from a copy of the
   * record — the record the host reads is untouched, so nobody can unlock during the write — and
   * applied to the record and told to the host only once that write landed. A write that fails or does
   * not answer changes nothing in memory (the list as it is is queued behind it) and answers false. A
   * later change to the same field wins: this one is then not applied, and the list as memory holds it
   * is written again over this write's copy.
   */
  async function widenControl(
    r: ControlRecord,
    field: ControlField,
    o: { change(c: WatchLinkControlRecord): void; host(h: LinkHost): void }
  ): Promise<boolean> {
    const turn = takeTurn(r, field)
    const next = { ...r.control }
    o.change(next)
    const write = persist({ ...r, control: next })
    const written = await within(write, persistTimeoutMs)
    const live = liveControl(r.linkId) === r
    if (written !== true) {
      if (live) void persist()
      warn("an owner's change to a Control link could not be saved; nothing changed")
      return false
    }
    if (!live) return false
    if (!hasTurn(r, field, turn)) {
      void persist() // this write's copy is on disk; memory says what the later change made of it
      return true
    }
    o.change(r.control)
    // A write issued meanwhile snapshotted the record before this change, and lands after this one.
    if (lastWrite !== write) void persist()
    tellHost(r.linkId, o.host)
    emitState()
    return true
  }

  return {
    init,

    async create(raw) {
      if (unsupported || stopped) return fail('unsupported')
      const parsed = parseRequest(raw)
      if (parsed === 'bad-request' || parsed === 'bad-password') return fail(parsed)
      const req = parsed.req
      if (!deps.relayAllowed()) return fail('relay-unavailable')
      // The resumed links count against the cap, and init must never start a host for a link a
      // create already started (G11). Bounded: a hung disk answers, it does not hang the dialog.
      if ((await within(init(), initWaitMs)) === TIMEOUT) {
        warnOnce('init-timeout', `the live-links file did not load within ${initWaitMs} ms`)
        return fail('persist-failed')
      }
      if (stopped) return fail('unsupported')
      if (nodeStateOf(req.nodeId) !== 'present') return fail('node-missing')
      // Before any request: a terminal whose key bindings are session-wide (Zellij) is never typed into.
      if (req.role === 'controller' && controlSupportOf(req.nodeId) === 'unsupported') return fail('control-unsupported')
      if (records.size + creating + opaqueHeld() >= MAX_LINKS_PER_MACHINE) return fail('limit-machine')
      const ent = deps.entitlement()
      if (!ent) return fail('not-entitled')
      creating++
      try {
        // Hashed BEFORE the server row exists: a hash that fails creates nothing anywhere. Only the
        // {salt, hash} goes on; the plaintext is not referenced past this.
        let control: WatchLinkControlRecord | undefined
        if (req.role === 'controller' && parsed.password !== null) {
          let h: ControlPasswordHash
          try {
            h = await scrypt(() => hashPassword(parsed.password as string))
          } catch (err) {
            // `unsupported` ("can't be created here right now"): the one error that names no cause —
            // `network` would say nodeterm's service could not be reached, which is not what happened.
            warn(`hashing a control password failed (${errorName(err)}); nothing was created`)
            return fail('unsupported')
          }
          parsed.password = null
          control = { enabled: true, locked: false, wrong: 0, lockedUntil: null, lockStep: 0, salt: h.salt, hash: h.hash }
        }
        const secret = newWatchLinkSecret()
        const joinKeyHash = await sha256Hex(deriveWatchLinkKeys(secret).joinKey)
        const created = await deps.api.create(ent, joinKeyHash, req.ttlSeconds)
        if (!created.ok) return fail(created.error)
        if (stopped) {
          revokeServer(created.linkId)
          return fail('unsupported')
        }
        const record: WatchLinkRecord = {
          linkId: created.linkId,
          nodeId: req.nodeId,
          role: req.role,
          label: req.label,
          title: req.title,
          createdAt: now(),
          // null for an Unlimited link (the API accepts a null only for a `ttlSeconds` 0 request).
          expiresAt: created.expiresAt,
          secret,
          ...(control ? { control } : {})
        }
        writing.set(record.linkId, record)
        let written: boolean | typeof TIMEOUT
        try {
          written = await within(persist(), persistTimeoutMs)
        } finally {
          writing.delete(record.linkId)
        }
        if (written !== true || stopped) {
          // No half-created link: queue the list without it behind whatever is stuck (so a write
          // that lands late is overwritten), and revoke the server row. (Quitting meanwhile is the
          // same: the owner was never shown this link.)
          void persist()
          revokeServer(record.linkId)
          return fail(stopped ? 'unsupported' : 'persist-failed')
        }
        // The node may have left every project while the record was being written — a workspace
        // change could not see this record then (it is not a link yet). Absent now: undo it (R46/M4).
        if (nodeStateOf(record.nodeId) === 'absent') {
          void persist()
          revokeServer(record.linkId)
          return fail('node-missing')
        }
        records.set(record.linkId, record)
        start(record)
        emitState()
        if (!persistentNow()) notice({ kind: 'not-persistent' })
        return { ok: true, link: viewOf(record) }
      } catch (err) {
        warn(`creating a live link failed: ${errorText(err)}`)
        return fail('network')
      } finally {
        creating--
      }
    },

    list,

    async revoke(linkId) {
      if (unsupported || typeof linkId !== 'string') return
      await within(init(), initWaitMs) // no link exists before init; a hung load must not hang the stop
      end(linkId, 'revoked', { serverRevoke: true, notify: false })
    },

    async revokeAll() {
      if (unsupported) return 'unsupported'
      // Bounded like revoke: on a disk that hangs, "Stop all" still reaches the server below.
      await within(init(), initWaitMs)
      const gone = [...records.keys()].map(drop)
      // "Stop all" revokes every link of the license server-side, the ones this run cannot unseal too.
      try {
        deps.store.discardOpaque()
      } catch (err) {
        warn(`forgetting unreadable links failed: ${errorText(err)}`)
      }
      void persist()
      for (const g of gone) stopHost(g?.host, 'revoked')
      emitState()
      // This machine's links are stopped. The server call is the only thing that reaches the links of
      // OTHER machines on the license, so it is AWAITED and its answer reported (R62): a stop that did
      // not reach the server must not look like one that did.
      let ent: string | null
      try {
        ent = deps.entitlement()
      } catch {
        ent = null
      }
      if (!ent) return 'no-entitlement'
      try {
        return (await deps.api.revokeAll(ent)) ? 'stopped' : 'failed'
      } catch {
        return 'failed'
      }
    },

    kick(linkId, viewerId) {
      try {
        return hosts.get(linkId)?.kick(viewerId) ?? false
      } catch (err) {
        warn(`kicking a viewer failed: ${errorText(err)}`)
        return false
      }
    },

    sendChat(linkId, text) {
      try {
        const msg = hosts.get(linkId)?.postSharerChat(text) ?? null
        return msg ? ownerChat(msg) : null
      } catch (err) {
        warn(`sending a chat message failed: ${errorText(err)}`)
        return null
      }
    },

    chatHistory(linkId) {
      try {
        return (hosts.get(linkId)?.chatHistory() ?? []).map(ownerChat)
      } catch {
        return []
      }
    },

    onWorkspaceChanged() {
      if (unsupported || stopped) return
      void init().then(() => {
        if (stopped) return
        for (const r of [...records.values()]) {
          if (nodeStateOf(r.nodeId) === 'absent') end(r.linkId, 'node-gone', { serverRevoke: true, notify: true })
        }
      })
    },

    onEntitlementChanged() {
      if (stopped) return
      for (const h of hosts.values()) {
        try {
          if (h.status() === 'refused') h.start()
        } catch (err) {
          warn(`re-arming a link host failed: ${errorText(err)}`)
        }
      }
    },

    async setControl(linkId, enabled) {
      const r = liveControl(linkId)
      if (!r || typeof enabled !== 'boolean') return false
      const c = r.control
      if (c.enabled === enabled) {
        // Nothing to change here — but it is still the owner's latest word on this field: an earlier
        // change still being written must not land over it.
        takeTurn(r, 'enabled')
        return true
      }
      if (enabled) {
        return widenControl(r, 'enabled', {
          change: (x) => {
            x.enabled = true
          },
          host: (h) => h.controlChanged()
        })
      }
      return narrowControl(r, 'enabled', {
        apply: () => {
          c.enabled = false
        },
        host: (h) => h.controlChanged()
      })
    },

    async setPassword(linkId, pw) {
      if (!liveControl(linkId) || controlPasswordProblem(pw) !== null) return false
      let h: ControlPasswordHash
      try {
        h = await scrypt(() => hashPassword(pw))
      } catch (err) {
        warn(`hashing a new control password failed (${errorName(err)}); nothing changed`)
        return false
      }
      // The link may have ended (or this run stopped) while the hash ran.
      const r = liveControl(linkId)
      if (!r) return false
      const c = r.control
      return narrowControl(r, 'password', {
        apply: () => {
          c.salt = h.salt
          c.hash = h.hash
          // A new password starts the link-wide wrong count over (the host resets its own).
          c.wrong = 0
        },
        // Every controller drops back to watching and must unlock with the new password.
        host: (x) => x.passwordChanged()
      })
    },

    async allowControl(linkId) {
      const r = liveControl(linkId)
      if (!r) return false
      if (!r.control.locked) {
        takeTurn(r, 'locked')
        return true
      }
      return widenControl(r, 'locked', {
        change: (x) => {
          x.locked = false
          x.lockedUntil = null
          x.wrong = 0 // the count starts over with the lock (the host resets its own)
          x.lockStep = 0 // and so does the backoff: the next lock lasts 15 minutes again
        },
        host: (h) => {
          armLock(r) // nothing left to lift
          h.allowControl()
        }
      })
    },

    controlSupport(nodeId) {
      if (typeof nodeId !== 'string' || !isSafeNodeId(nodeId)) return 'unknown'
      return controlSupportOf(nodeId)
    },

    shutdown() {
      if (!stopped) {
        stopped = true
        for (const t of expiry.values()) clearT(t)
        expiry.clear()
        for (const t of lockTimers.values()) clearT(t)
        lockTimers.clear()
        const all = [...hosts.values()]
        hosts.clear()
        for (const h of all) stopHost(h, 'host-stopping')
      }
      return lastWrite.then(
        () => undefined,
        () => undefined
      )
    }
  }
}

/**
 * `shutdown()` bounded: the service's last write may hang on a stalled disk, and a shell's close must
 * not (R46/M6). The Server Edition awaits this in both close paths; the desktop races its own 1.5 s
 * flush instead. The timer is cleared (and never holds the process) either way.
 */
export async function shutdownWithin(s: WatchLinkService | null, ms: number): Promise<void> {
  if (!s) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
  try {
    await Promise.race([s.shutdown(), bound])
  } finally {
    clearTimeout(timer)
  }
}

/** The owner IPC. Relay peers never reach these handlers (the `watchLink:` prefix is host-only and
 *  refused before any policy runs); the owner check is the belt behind that, for any other client. */
export function registerWatchLinkIpc(
  p: Pick<CorePlatform, 'handleWithSender' | 'isOwnerClient'>,
  s: WatchLinkService
): void {
  const owner = (id: number): boolean => p.isOwnerClient?.(id) === true
  const str = (v: unknown): v is string => typeof v === 'string'
  p.handleWithSender(IPC.watchLinkCreate, (sender: number, req: unknown) =>
    owner(sender) ? s.create(req) : ({ ok: false, error: 'unsupported' } satisfies CreateWatchLinkResult))
  p.handleWithSender(IPC.watchLinkList, (sender: number) => (owner(sender) ? s.list() : []))
  p.handleWithSender(IPC.watchLinkRevoke, (sender: number, id: unknown) =>
    owner(sender) && str(id) ? s.revoke(id) : undefined)
  p.handleWithSender(IPC.watchLinkRevokeAll, (sender: number) =>
    owner(sender) ? s.revokeAll() : ('unsupported' satisfies RevokeAllOutcome))
  p.handleWithSender(IPC.watchLinkKick, (sender: number, id: unknown, viewer: unknown) =>
    owner(sender) && str(id) && str(viewer) ? s.kick(id, viewer) : false)
  p.handleWithSender(IPC.watchLinkChatSend, (sender: number, id: unknown, text: unknown) =>
    owner(sender) && str(id) && str(text) ? s.sendChat(id, text) : null)
  p.handleWithSender(IPC.watchLinkChatHistory, (sender: number, id: unknown) =>
    owner(sender) && str(id) ? s.chatHistory(id) : [])
  p.handleWithSender(IPC.watchLinkSetControl, (sender: number, id: unknown, enabled: unknown) =>
    owner(sender) && str(id) && typeof enabled === 'boolean' ? s.setControl(id, enabled) : false)
  // The password is handed straight to the service, which keeps only its hash; never logged here.
  p.handleWithSender(IPC.watchLinkSetPassword, (sender: number, id: unknown, pw: unknown) =>
    owner(sender) && str(id) && str(pw) ? s.setPassword(id, pw) : false)
  p.handleWithSender(IPC.watchLinkAllowControl, (sender: number, id: unknown) =>
    owner(sender) && str(id) ? s.allowControl(id) : false)
  p.handleWithSender(IPC.watchLinkControlSupport, (sender: number, nodeId: unknown) =>
    owner(sender) && str(nodeId) ? s.controlSupport(nodeId) : ('unknown' satisfies ControlSupport))
}
