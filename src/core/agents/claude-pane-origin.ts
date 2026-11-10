/**
 * WHICH CLAUDE IS ALLOWED TO SPEAK FOR A NODE (issues #1112, #1153).
 *
 * A hook event names its node by `NODETERM_NODE_ID`, and that is an ENVIRONMENT variable: every
 * process the node's claude starts inherits it. Two field reports, one mechanism:
 *
 *  - #1112: a background script started from a node ran `claude --model … -p …` every so often.
 *    Each run fired the managed hooks as that node, so its session took over the node's session
 *    id, model and context meter (and, through `setNodeTranscript`, what a context link reads).
 *  - #1153: a Claude fork is hosted by Claude's own daemon (`claude daemon run` →
 *    `claude --bg-pty-host` → `claude --session-id <fork> --fork-session …`), spawned by node A's
 *    claude and carrying A's env. Every hook of the fork was posted as A, so `/rename` in the node
 *    that resumed the fork renamed A.
 *
 * Nothing on the nodeterm side could tell those events from the node's own: the session id is
 * new, the node token is looked up by the same inherited id (so the events even verify), and a
 * new session id on an ordinary event is also what a legitimate `/clear` or a cold-restore resume
 * looks like. Rules keyed on the SESSION (bind to the first one, switch only on `SessionStart`
 * with source clear/resume/compact) fail both ways — a detached `claude -p --resume` sends
 * `source: resume`, and a claude that died without `SessionEnd` locks the next one out
 * (both found in the contributor's prototype on #1112).
 *
 * The rule here is keyed on the PROCESS, and on the one fact about it the kernel keeps: is it the
 * foreground process group of the node's pane? MEASURED on Claude Code 2.1.301 (2026-10-16,
 * Linux, private tmux socket, capture hook via --settings; the hook's own env lists `CLAUDE_PID`):
 *
 *   interactive claude in the pane:   CLAUDE_PID's stat has `+`, tty = the pane's pts
 *   `claude -p` run from claude's Bash tool (setsid'd tool shell): tty `?`, no `+`
 *   a `cmd &` job of the pane's shell: same tty, no `+` (not the foreground group)
 *
 * and, by construction, the daemon-hosted fork of #1153 is foreground on the bg-pty-host's OWN
 * pty, never on the pane's. `CLAUDE_PID` is in the claude binary from at least 2.1.220 (it is
 * absent from 2.1.200; npm `@anthropic-ai/claude-code-linux-x64` checked). The managed claude
 * script (managed-script.ts) reads `ps -o stat= -o tty= -p $CLAUDE_PID` WHILE claude waits on the
 * hook — so the process is alive for the read even on `SessionEnd` — and posts the two facts.
 *
 * Every legitimate session change in a node happens in the pane's foreground: `/clear`,
 * `/resume`, `/compact` (same process), Branch (the source keeps its pane; the branch resumes in
 * its own node), cold-restore resume, the in-place restart, a new `claude` typed after the old one
 * quit. None of them needs a rule of its own, and a claude that dies without `SessionEnd` blocks
 * nothing — there is no binding to release.
 *
 * Fail OPEN wherever a fact is missing: an older script or claude (no pid), a `ps` that cannot
 * answer (Windows / Git Bash, BusyBox), a pane whose tty this core cannot read (Zellij, plain-shell
 * fallback, an SSH node with no live client here). Those events behave exactly as before — the
 * cost of wrongly dropping the pane's OWN events (a node stuck on RUNNING, a meter that never
 * fills) is worse than the bug this closes.
 */

/** What the managed claude hook script reports about the claude process that ran it. */
export interface ClaudeHookOrigin {
  pid?: number
  /** `true`: in the foreground process group of its terminal; `false`: not (or no terminal). */
  foreground?: boolean
  /** The controlling terminal, `ps`'s spelling (`pts/3`, `ttys003`). Absent when there is none. */
  tty?: string
}

export type ClaudeOriginVerdict = 'own' | 'foreign' | 'unknown'

/** Strip a leading `/dev/` so tmux's `#{pane_tty}` and `ps -o tty=` compare as one spelling. */
export function normalizeTty(tty: string | null | undefined): string | null {
  if (!tty) return null
  const t = tty.trim().replace(/^\/dev\//, '')
  if (!t || t.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(t) || t.includes('..')) return null
  return t
}

/**
 * Read the origin out of the hook POST's form fields. Anything malformed is simply absent — the
 * fields are written by a script, but the endpoint takes any bearer holder's POST, so they are
 * parsed, never trusted beyond what `classifyClaudeOrigin` does with them.
 */
export function parseClaudeHookOrigin(form: Record<string, string | undefined>): ClaudeHookOrigin | undefined {
  const fg = form.nodeterm_claude_fg
  const foreground = fg === '1' ? true : fg === '0' ? false : undefined
  if (foreground === undefined) return undefined
  const rawPid = form.nodeterm_claude_pid
  const pid = rawPid && /^\d{1,10}$/.test(rawPid) ? Number(rawPid) : undefined
  const tty = normalizeTty(form.nodeterm_claude_tty) ?? undefined
  return {
    foreground,
    ...(pid !== undefined && pid > 0 ? { pid } : {}),
    ...(tty ? { tty } : {})
  }
}

/**
 * The decision, pure. `paneTty` is the node's pane tty as this core reads it (`null` = could not
 * read it). Only two answers are ever `foreign`: the reporting claude is not in the foreground of
 * any terminal, or it is in the foreground of a terminal that is not the node's pane.
 */
export function classifyClaudeOrigin(
  origin: ClaudeHookOrigin | undefined,
  paneTty: string | null | undefined
): ClaudeOriginVerdict {
  if (!origin || origin.foreground === undefined) return 'unknown'
  if (origin.foreground === false) return 'foreign'
  const own = normalizeTty(origin.tty)
  const pane = normalizeTty(paneTty)
  if (!own || !pane) return 'unknown'
  return own === pane ? 'own' : 'foreign'
}

/** How long a pane tty read is trusted. A tty only changes when the node's session is recreated,
 *  and a mismatch re-reads anyway; the TTL bounds the one case a re-read cannot catch (a recycled
 *  pane whose OLD tty number was handed to some other terminal). */
export const PANE_TTY_TTL_MS = 5 * 60_000
/** A failed read is retried, but not on every event (a Zellij node answers null every time). */
export const PANE_TTY_MISS_TTL_MS = 30_000
/** A tty that DISAGREES with the cached one is re-read at most this often, so a foreign process
 *  posting steadily (the #1153 fork) costs one pane read per window, not one per event. */
export const PANE_TTY_RECHECK_MS = 10_000
/** The probe has no deadline of its own (PtyManager.paneOwner); events wait at most this long. */
export const PANE_TTY_PROBE_MS = 2_000

export interface PaneOriginGateDeps {
  /** The node's pane tty, or null when it cannot be read. Injected by each shell. */
  paneTty?: (nodeId: string) => Promise<string | null>
  now?: () => number
  log?: (line: string) => void
}

export interface PaneOriginGate {
  /**
   * Should this event be delivered as the node's? Resolves in arrival order PER NODE, so an event
   * that waits for a tty read never overtakes or is overtaken by the node's next one.
   */
  admit(nodeId: string, origin: ClaudeHookOrigin | undefined): Promise<boolean>
  setPaneTtyResolver(fn: ((nodeId: string) => Promise<string | null>) | undefined): void
  forgetNode(nodeId: string): void
}

export function createPaneOriginGate(deps: PaneOriginGateDeps = {}): PaneOriginGate {
  let resolver = deps.paneTty
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.warn(line))
  const cache = new Map<string, { tty: string | null; at: number }>()
  const chains = new Map<string, Promise<unknown>>()
  const logged = new Set<string>()

  const probe = async (nodeId: string): Promise<string | null> => {
    const fn = resolver
    if (!fn) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const tty = await Promise.race([
        fn(nodeId).catch(() => null),
        new Promise<null>((r) => {
          timer = setTimeout(() => r(null), PANE_TTY_PROBE_MS)
          ;(timer as { unref?: () => void }).unref?.()
        })
      ])
      const t = normalizeTty(tty)
      cache.set(nodeId, { tty: t, at: now() })
      return t
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const paneTty = async (nodeId: string, reported: string | null): Promise<string | null> => {
    const hit = cache.get(nodeId)
    const age = hit ? now() - hit.at : Infinity
    if (hit && hit.tty === null && age < PANE_TTY_MISS_TTL_MS) return null
    // A cached tty is used only while it AGREES; a disagreement is re-read before anything is
    // called foreign, so a pane recreated under a new tty can never lock its own claude out.
    if (hit && hit.tty !== null && age < PANE_TTY_TTL_MS) {
      if (hit.tty === reported || age < PANE_TTY_RECHECK_MS) return hit.tty
    }
    return probe(nodeId)
  }

  const decide = async (nodeId: string, origin: ClaudeHookOrigin | undefined): Promise<boolean> => {
    let verdict: ClaudeOriginVerdict
    if (!origin || origin.foreground !== true) verdict = classifyClaudeOrigin(origin, null)
    else {
      const reported = normalizeTty(origin.tty)
      verdict = reported ? classifyClaudeOrigin(origin, await paneTty(nodeId, reported)) : 'unknown'
    }
    if (verdict !== 'foreign') return true
    const key = `${nodeId}\u0000${origin?.pid ?? '?'}`
    if (!logged.has(key)) {
      if (logged.size > 1000) logged.clear()
      logged.add(key)
      log(
        `[agent-hooks] ignoring claude hook events for node ${nodeId} from pid ${origin?.pid ?? '?'}: ` +
          `${origin?.foreground ? `foreground on ${origin.tty}, not the node's pane` : 'not the foreground of a terminal'} ` +
          '(a process that inherited NODETERM_NODE_ID; issue #1112)'
      )
    }
    return false
  }

  return {
    admit(nodeId, origin) {
      const prev = chains.get(nodeId) ?? Promise.resolve()
      const next = prev.then(() => decide(nodeId, origin))
      const tail = next.catch(() => true)
      chains.set(nodeId, tail)
      void tail.then(() => {
        if (chains.get(nodeId) === tail) chains.delete(nodeId)
      })
      return next.catch(() => true)
    },
    setPaneTtyResolver(fn) {
      resolver = fn
      cache.clear()
    },
    forgetNode(nodeId) {
      cache.delete(nodeId)
    }
  }
}

/**
 * The ONE wiring both shells call (desktop `src/main/index.ts`, Server Edition
 * `src/server/index.ts`; pinned by hook-verified-parity.test.ts): the pane tty comes from the
 * shell's own PtyManager (`paneOwner` — local tmux, the SSH ControlMaster for a live remote node,
 * the Windows session host), and a destroyed or recycled node forgets it (its next pane has a new
 * tty). A shell that skipped this would still drop a claude with no terminal, but would deliver a
 * daemon-hosted fork's events (#1153) as the node's.
 */
export function wireClaudePaneOrigin(deps: {
  hooks: {
    setPaneTtyResolver(fn: ((nodeId: string) => Promise<string | null>) | undefined): void
    forgetPaneOrigin(nodeId: string): void
  }
  paneOwner: (nodeId: string) => Promise<{ tty?: string } | null>
  /**
   * A node whose pane this core cannot read HONESTLY: an SSH-project node with no live client in
   * this process. `paneOwner` would fall through to the LOCAL tmux socket for it, and a stray local
   * `nt-<id>` (CLAUDE.md, the relay attach section) would answer with a tty from the wrong machine
   * — every event of the real remote claude would then read as foreign. Such a node is "unknown".
   */
  cannotRead?: (nodeId: string) => boolean
  on: (channel: string, cb: (nodeId: string) => void) => void
  destroyChannel: string
  recycleChannel: string
}): void {
  deps.hooks.setPaneTtyResolver(async (nodeId) =>
    deps.cannotRead?.(nodeId) ? null : ((await deps.paneOwner(nodeId))?.tty ?? null)
  )
  deps.on(deps.destroyChannel, (nodeId) => deps.hooks.forgetPaneOrigin(nodeId))
  deps.on(deps.recycleChannel, (nodeId) => deps.hooks.forgetPaneOrigin(nodeId))
}
