// The desktop's half of "Share with team" for an SSH project: hand the project to a nodeterm-server
// running on the same host as the user's own login, so teammates join it over the relay.
//
// Each verb runs ONE generated command (core/remote-ssh/share-team-remote.ts) over the project's
// ControlMaster, and every reply is parsed strictly: a cut-short or unrecognised answer is an error,
// never a half-read success.
//
// The server is not trusted with what it says about itself. A join code is accepted only through
// `decodeJoinCode`, which checks that the hostId is the hash of the key the code carries and that the
// relay endpoint is `wss:` (or loopback `ws:`); a bootstrap whose code names a different host than
// its own reply is refused. `seedBookmark`, which skips the SAS, seeds only a code a successful
// bootstrap returned here.
//
// The probe is cached per project. `bootstrap` and `resume` run the server binary, main.cjs and data
// dir from that cached, validated probe, never from paths the renderer sends, and bootstrap adopts
// the folder that probe resolved. Each verb also re-asks the probe's plan: a host the plan refuses
// (a home folder Viewers could read, a root login, a system install) is never installed on or run
// against, whatever the renderer asks for.
//
// Electron-free on purpose (only core, shared and the bookmark TYPE), so it is unit-tested directly;
// share-team-ipc.ts is the only file that touches `ipcMain`. Every handler answers a `ShareReply`
// and never rejects: a throw becomes `{ ok: false, error }`.
import { childArgs } from '../../core/remote-ssh/control-master'
import {
  SHARE_INSTALL_SCRIPT,
  killVerifyCommand,
  paneCommandsByNode,
  parseKillVerify,
  parseShareProbe,
  parseTeamCliOutput,
  shareProbeCommand,
  teamCliCommand
} from '../../core/remote-ssh/share-team-remote'
import { decodeJoinCode, encodeJoinCode } from '../../core/relay/join-code'
import { CONTROL_RE, ownerLabelProblem, projectIdProblem } from '../../core/relay/team-admin'
import { ADMIN_ERROR_CODE_RE, adminErrorCode } from '../../core/relay/admin-error'
import { TEAM_LABEL_MAX } from '../../core/relay/team-store'
import type { RemoteReadResult } from '../../core/workspace-store'
import { isSafeNodeId } from '../../shared/safe-id'
import {
  RESUME_MAX_SESSIONS,
  SHARE_MAX_TERMINALS,
  parseResumeSessions,
  sharePlan,
  type BootstrapResult,
  type ResumeResultEntry,
  type ResumeStatus,
  type SharePlan,
  type ShareProbe,
  type ShareReply,
  type ShareTeamApi
} from '../../shared/share-team'
import type { SshConnection } from '../../shared/ssh'
import type { RelayBookmark } from '../remote/relay-bookmarks'
import { isRecord } from '../../shared/is-record'

/** ssh timeouts per verb. `bootstrap` and `resume` outlast the server's own admin timeouts behind
 *  them (45 s and 60 s) plus the CLI's start-up, so a slow but healthy server answers before ssh
 *  gives up; the probe outlasts its own bounded `team status`. */
export const SHARE_TIMEOUTS = { probe: 30_000, bootstrap: 60_000, kill: 30_000, resume: 75_000 } as const
/** The installer clones and builds nodeterm-server on the host; a slow machine takes many minutes. */
export const SHARE_INSTALL_TIMEOUT_MS = 30 * 60_000

export interface ShareTeamDeps {
  /** The project's live connection, or undefined when it is not connected. */
  ref(projectId: string): { conn: SshConnection; controlPath: string; remoteCwd?: string } | undefined
  /** One buffered ssh child over the master: full child args, optional stdin, a hard timeout. */
  run(args: string[], stdin: string | undefined, timeoutMs: number): Promise<{ code: number; stdout: string }>
  /** Stream a script on the host (the installer). Never rejects; a failure is a non-zero exit. */
  runInstall(projectId: string, script: string, onChunk: (text: string) => void, signal: AbortSignal): Promise<{ exitCode: number }>
  /** Push every pending throttled project.json mirror write to its host now. */
  flushMirror(): Promise<void>
  /** Read the project's `.nodeterm/project.json` on its host (a checked read). */
  readRemoteProject(projectId: string): Promise<RemoteReadResult>
  /** This desktop's relay public key (standard base64): the key the team makes its owner. */
  ownerKey(): Promise<string>
  /** A human name for this desktop in the team's member list (cleaned here before use). */
  ownerLabel(): string
  bookmarks: {
    list(): Promise<RelayBookmark[]>
    upsert(b: RelayBookmark): Promise<void>
    update(hostId: string, patch: Partial<Pick<RelayBookmark, 'deviceToken' | 'approvedAt'>>): Promise<void>
  }
  now(): number
}

export interface ShareTeamHandlers extends Omit<ShareTeamApi, 'onInstallOutput' | 'install'> {
  install(projectId: string, onChunk: (text: string) => void): Promise<ShareReply<{ exitCode: number }>>
}

type ShareFail = { ok: false; error: string; code?: string }

const NOT_CONNECTED = {
  ok: false,
  code: 'E_NOT_CONNECTED',
  error: 'The project is not connected. Connect it and try again.'
} as const
const NOT_PROBED = {
  ok: false,
  code: 'E_NOT_PROBED',
  error: 'Check the host first (the probe did not run or found no usable server).'
} as const
const PROBE_SSH_FAILED = 'Could not run the check on the host (ssh failed).'
const TEAM_SSH_FAILED = 'Could not run the team command on the host (ssh failed).'
const KILL_SSH_FAILED = 'Could not stop the sessions on the host (ssh failed).'
const PROJECT_UNREADABLE = 'The project file on the host is not readable.'
const PROJECT_READ_FAILED = 'Could not read the project file on the host.'
const BAD_JOIN_CODE = 'The server sent an invalid join code.'
const BAD_BOOTSTRAP = 'The server answered bootstrap with a result this build cannot read.'
const BAD_RESUME = 'The server answered resume with a result this build cannot read.'
const INSTALL_CANCELLED = { ok: false, code: 'E_CANCELLED', error: 'The install was cancelled.' } as const
const NOT_ISSUED = 'Only the invite code Share with team just received can be added without the verification code.'

/** The most of a server-sent sentence shown to the user. */
const SHOWN_MAX = 500
const CONTROL_G = new RegExp(CONTROL_RE.source, 'gu')
const QUOTE_OR_BACKSLASH_G = /['\\]/g
const RESUME_STATUSES: ReadonlySet<string> = new Set<ResumeStatus>(['resumed', 'already-running', 'refused'])

const fail = (error: string, code?: string): ShareFail => ({ ok: false, error, ...(code ? { code } : {}) })
/** A server-sent sentence, made safe to print: controls (and text-direction overrides) blanked, bounded. */
const shown = (text: string): string => text.replace(CONTROL_G, ' ').slice(0, SHOWN_MAX)

/** A thrown error as a reply. A coded error (a locked keyring, a refused value) keeps its code. */
function caught(e: unknown): ShareFail {
  const message = e instanceof Error ? e.message : String(e)
  return fail(message || 'Something went wrong.', adminErrorCode(e))
}

/**
 * The owner label as bootstrap can take it. Controls are stripped, and so are `'` and `\`: the
 * label rides a generated `sh -c '…'` line that every login shell (fish included) must parse, and
 * those two cannot be nested there. Then it is capped at the team's label limit (never splitting a
 * surrogate pair) and, should the server's own check still object, left out.
 */
function ownerLabelFor(raw: string): string {
  let label = raw.replace(CONTROL_G, '').replace(QUOTE_OR_BACKSLASH_G, '').slice(0, TEAM_LABEL_MAX)
  if (/[\uD800-\uDBFF]$/.test(label)) label = label.slice(0, -1)
  return ownerLabelProblem(label) ? '' : label
}

/** A `--name value` flag pair, or `--name=value` when the value itself starts with `--` (the team
 *  CLI would otherwise read it as a missing value). */
const flag = (name: string, value: string): string[] => (value.startsWith('--') ? [`--${name}=${value}`] : [`--${name}`, value])

/** The server's own refusal (`{ ok: false, error, code? }`), passed through. Only a code of the
 *  admin shape survives: the renderer branches on it, so it must be one the server can mean. */
function refusal(body: unknown): ShareFail | null {
  if (!isRecord(body) || body.ok !== false) return null
  const error = typeof body.error === 'string' && body.error.trim() ? shown(body.error) : 'The host refused the request.'
  const code = typeof body.code === 'string' && ADMIN_ERROR_CODE_RE.test(body.code) ? body.code : undefined
  return fail(error, code)
}

/** `team bootstrap --json`'s success, strictly: only the known fields, each of its kind. */
function bootstrapResult(body: unknown): BootstrapResult | null {
  if (!isRecord(body)) return null
  const { hostId, projectId, projectName, joinCode, hosting, created } = body
  if (typeof hostId !== 'string' || typeof projectId !== 'string' || typeof projectName !== 'string' || typeof joinCode !== 'string') {
    return null
  }
  if (hosting !== 'up' && hosting !== 'starting') return null
  if (!isRecord(created)) return null
  const { team, owner, project, share } = created
  if (typeof team !== 'boolean' || typeof owner !== 'boolean' || typeof project !== 'boolean' || typeof share !== 'boolean') {
    return null
  }
  if (projectIdProblem(projectId) !== null) return null
  return { hostId, projectId, projectName: shown(projectName), joinCode, hosting, created: { team, owner, project, share } }
}

/** `team resume --json`'s results, strictly: one entry per session at most, each of a known status. */
function resumeResults(body: unknown): ResumeResultEntry[] | null {
  if (!isRecord(body) || !Array.isArray(body.results) || body.results.length > RESUME_MAX_SESSIONS) return null
  const out: ResumeResultEntry[] = []
  for (const e of body.results as unknown[]) {
    if (!isRecord(e) || typeof e.nodeId !== 'string' || typeof e.status !== 'string' || !RESUME_STATUSES.has(e.status)) {
      return null
    }
    if (e.reason !== undefined && typeof e.reason !== 'string') return null
    out.push({
      nodeId: e.nodeId,
      status: e.status as ResumeStatus,
      ...(typeof e.reason === 'string' ? { reason: shown(e.reason) } : {})
    })
  }
  return out
}

export function createShareTeamHandlers(deps: ShareTeamDeps): ShareTeamHandlers {
  const probes = new Map<string, ShareProbe>()
  const installs = new Map<string, AbortController>()
  /** The join code each project's last SUCCESSFUL bootstrap returned: the only codes `seedBookmark`
   *  may seed, because only those arrived over the project's own authenticated ssh channel. */
  const issuedCodes = new Map<string, string>()

  /** The cached probe and its plan. A plan that refuses answers with its own reason, under the
   *  not-probed code: nothing ran, and the renderer must not read it as a server failure. */
  const plannedProbe = (projectId: string): { probe: ShareProbe; plan: SharePlan } | ShareFail => {
    const probe = probes.get(projectId)
    if (!probe) return NOT_PROBED
    const plan = sharePlan(probe)
    return plan.kind === 'refuse' ? fail(plan.reason, NOT_PROBED.code) : { probe, plan }
  }
  /** The cached probe, only when its plan says the host can take the share now. */
  const readyProbe = (projectId: string): (ShareProbe & { adoptCwd: string }) | ShareFail => {
    const planned = plannedProbe(projectId)
    if ('ok' in planned) return planned
    const { probe, plan } = planned
    // `ready` implies a folder (the plan refuses a missing one); the check only narrows the type.
    return plan.kind === 'ready' && probe.adoptCwd !== null ? { ...probe, adoptCwd: probe.adoptCwd } : NOT_PROBED
  }

  return {
    async probe(projectId, nodeIds) {
      try {
        const ref = deps.ref(projectId)
        if (!ref) return NOT_CONNECTED
        // A probe that fails must not leave an older one behind for bootstrap to run against.
        probes.delete(projectId)
        const command = shareProbeCommand(ref.remoteCwd ?? '~')
        const r = await deps.run(childArgs(ref.conn, ref.controlPath, command), undefined, SHARE_TIMEOUTS.probe)
        if (r.code !== 0) return fail(PROBE_SSH_FAILED)
        const probe = parseShareProbe(r.stdout)
        if ('error' in probe) return fail(probe.error)
        probes.set(projectId, probe)
        return {
          ok: true,
          probe,
          plan: sharePlan(probe),
          paneCommands: paneCommandsByNode(probe.panes, nodeIds.filter((id) => isSafeNodeId(id)))
        }
      } catch (e) {
        return caught(e)
      }
    },

    // Probe-cache invalidation is not this verb's job: the renderer probes again after an install,
    // and that probe replaces the cached one.
    async install(projectId, onChunk) {
      try {
        if (!deps.ref(projectId)) return NOT_CONNECTED
        const planned = plannedProbe(projectId)
        if ('ok' in planned) return planned
        if (installs.has(projectId)) return fail('An install is already running.')
        const ctrl = new AbortController()
        installs.set(projectId, ctrl)
        // Output reaches the renderer over IPC, and a send to a disposed frame throws; that must not
        // escape into the runner's stream callbacks.
        const chunk = (text: string): void => {
          try {
            onChunk(text)
          } catch {
            // The window is gone; the run itself carries on and still reports its exit code.
          }
        }
        try {
          const { exitCode } = await deps.runInstall(projectId, SHARE_INSTALL_SCRIPT, chunk, ctrl.signal)
          // A cancelled run is never "finished": the renderer must end the share, not re-probe a
          // host that may still read as ready.
          if (ctrl.signal.aborted) return INSTALL_CANCELLED
          return { ok: true, exitCode }
        } finally {
          installs.delete(projectId)
        }
      } catch (e) {
        return caught(e)
      }
    },

    async cancelInstall(projectId) {
      installs.get(projectId)?.abort()
    },

    async flushMirror(projectId) {
      try {
        if (!deps.ref(projectId)) return NOT_CONNECTED
        // Flush first: a throttled mirror write still pending would leave nodes out of the read.
        await deps.flushMirror()
        const read = await deps.readRemoteProject(projectId)
        if (read.status === 'absent') return { ok: true, nodeIds: [] }
        if (read.status === 'error') return fail(PROJECT_READ_FAILED)
        let parsed: unknown
        try {
          parsed = JSON.parse(read.content)
        } catch {
          return fail(PROJECT_UNREADABLE)
        }
        if (!isRecord(parsed) || !Array.isArray(parsed.nodes)) return fail(PROJECT_UNREADABLE)
        const nodeIds = (parsed.nodes as unknown[]).flatMap((n) => (isRecord(n) && typeof n.id === 'string' ? [n.id] : []))
        return { ok: true, nodeIds }
      } catch (e) {
        return caught(e)
      }
    },

    async bootstrap(projectId) {
      try {
        const ref = deps.ref(projectId)
        if (!ref) return NOT_CONNECTED
        const probe = readyProbe(projectId)
        if ('ok' in probe) return probe
        const label = ownerLabelFor(deps.ownerLabel())
        const args = [
          'bootstrap',
          ...flag('owner-key', await deps.ownerKey()),
          ...(label ? flag('owner-label', label) : []),
          ...flag('adopt', probe.adoptCwd),
          '--json'
        ]
        const r = await deps.run(childArgs(ref.conn, ref.controlPath, teamCliCommand(probe, args)), undefined, SHARE_TIMEOUTS.bootstrap)
        if (r.code !== 0) return fail(TEAM_SSH_FAILED)
        const out = parseTeamCliOutput(r.stdout)
        if ('error' in out) return fail(out.error)
        const refused = refusal(out.body)
        if (refused) return refused
        const result = bootstrapResult(out.body)
        if (!result) return fail(BAD_BOOTSTRAP)
        const code = decodeJoinCode(result.joinCode)
        if (!code || code.hostId !== result.hostId) return fail(BAD_JOIN_CODE)
        issuedCodes.set(projectId, result.joinCode)
        return { ok: true, result }
      } catch (e) {
        return caught(e)
      }
    },

    async killSessions(projectId, nodeIds) {
      try {
        const ref = deps.ref(projectId)
        if (!ref) return NOT_CONNECTED
        if (nodeIds.length > SHARE_MAX_TERMINALS) {
          return fail(`A share stops at most ${SHARE_MAX_TERMINALS} terminal sessions.`)
        }
        if (!nodeIds.every((id) => isSafeNodeId(id))) {
          return fail('A terminal node id is not a safe id (letters, digits, ".", "_" and "-" only).')
        }
        if (nodeIds.length === 0) return { ok: true, results: [] }
        const command = killVerifyCommand(nodeIds)
        const r = await deps.run(childArgs(ref.conn, ref.controlPath, command), undefined, SHARE_TIMEOUTS.kill)
        if (r.code !== 0) return fail(KILL_SSH_FAILED)
        const results = parseKillVerify(r.stdout, nodeIds)
        if ('error' in results) return fail(results.error)
        return { ok: true, results }
      } catch (e) {
        return caught(e)
      }
    },

    async resume(projectId, serverProjectId, sessions) {
      try {
        const ref = deps.ref(projectId)
        if (!ref) return NOT_CONNECTED
        const probe = readyProbe(projectId)
        if ('ok' in probe) return probe
        const idProblem = projectIdProblem(serverProjectId)
        if (idProblem) return fail(idProblem)
        const list = parseResumeSessions(sessions)
        if (typeof list === 'string') return fail(list)
        // The session list travels on stdin, never argv: it is long, and argv shows up in `ps`.
        const command = teamCliCommand(probe, ['resume', ...flag('project', serverProjectId), '--json'])
        const r = await deps.run(childArgs(ref.conn, ref.controlPath, command), JSON.stringify(list), SHARE_TIMEOUTS.resume)
        if (r.code !== 0) return fail(TEAM_SSH_FAILED)
        const out = parseTeamCliOutput(r.stdout)
        if ('error' in out) return fail(out.error)
        const refused = refusal(out.body)
        if (refused) return refused
        const results = resumeResults(out.body)
        if (!results) return fail(BAD_RESUME)
        return { ok: true, results }
      } catch (e) {
        return caught(e)
      }
    },

    async seedBookmark(joinCode) {
      try {
        // The ONE join that skips the SAS, so it takes only a code a successful bootstrap handed
        // out here: that code arrived over the project's own ssh channel, whose host key
        // known_hosts authenticated, and it names the relay key it was minted for — the same
        // assurance a human comparing six digits gives. Any other code, valid or not, still
        // compares the SAS.
        if (![...issuedCodes.values()].includes(joinCode)) return fail(NOT_ISSUED)
        const code = decodeJoinCode(joinCode)
        if (!code) return fail('That is not a valid team invite code.')
        const at = new Date(deps.now()).toISOString()
        const existing = (await deps.bookmarks.list()).find((b) => b.hostId === code.hostId)
        if (existing && decodeJoinCode(existing.code)?.hostPublicKeyB64 === code.hostPublicKeyB64) {
          // Same team, same key: keep its device token; approve it if it never was.
          if (!existing.approvedAt) await deps.bookmarks.update(code.hostId, { approvedAt: at })
        } else {
          // New, or the stored bookmark names another key: its token and approval belong to that
          // key, so they are not carried over.
          await deps.bookmarks.upsert({
            hostId: code.hostId,
            code: encodeJoinCode(code),
            label: code.label,
            deviceToken: null,
            approvedAt: at,
            source: 'ssh'
          })
        }
        return { ok: true, hostId: code.hostId, label: code.label }
      } catch (e) {
        return caught(e)
      }
    }
  }
}
