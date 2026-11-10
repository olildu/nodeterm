// Removing a managed Claude account MOVES its running sessions onto the system account before the
// account's dir is deleted.
//
// Why: a running `claude` keeps `CLAUDE_CONFIG_DIR=<account dir>` in its tmux session's env, and
// clearing the node's `accountId` cannot change that — the shell's env was fixed at spawn. Deleting
// the dir under it left the CLI logged out with its transcripts gone, and the pane repainted
// half-blank until the user restarted it by hand (and then had to /login again).
//
// So removal first runs the existing account switch onto the system account for every Claude
// session on the account — the active canvas through `runClaudeAccountSwitch` (quit → copy the
// transcript → rebind → recycle → `--resume`), every other project by copying the transcript and
// ending its tmux session, so its next open cold-starts under the system login and resumes. Only
// then is the dir deleted. A session that is mid-turn or waiting on a permission prompt refuses
// the whole removal: quitting it would abandon its work or answer its prompt.
//
// Pure planning lives here (unit-tested). The active canvas registers its side through
// `registerActiveCanvasAccountMover` — the Settings overlay cannot see the live React Flow nodes,
// and the projects store's copy of the active project lags the canvas until the next commit.

/** A serialized terminal node, reduced to what the plan needs. */
export interface RemovalNode {
  id: string
  agentId?: string
  accountId?: string
  /** The account's own `claude /login` node — deleted with the account, never moved. */
  login: boolean
}

export interface RemovalProject {
  id: string
  /** `sshHostKey` of an SSH project's server; undefined for a local project. */
  hostKey?: string
  nodes: RemovalNode[]
}

export interface OtherProjectSession {
  projectId: string
  nodeId: string
  sessionId?: string
}

/**
 * Claude sessions on `accountId` in every project EXCEPT the active one (the active canvas is
 * read live). Only projects on the account's own machine count: a local account's sessions run in
 * local projects, a remote account's in projects on its host. Builtin claude only — no other agent
 * is ever bound to a Claude account (`boundAccountId`).
 */
export function otherProjectSessions(input: {
  accountId: string
  accountHost?: string
  activeProjectId: string | null
  projects: readonly RemovalProject[]
  stateOf: (nodeId: string) => string | undefined
  sessionIdOf: (nodeId: string) => string | undefined
}): { ready: OtherProjectSession[]; busy: string[] } {
  const ready: OtherProjectSession[] = []
  const busy: string[] = []
  for (const p of input.projects) {
    if (p.id === input.activeProjectId) continue
    if ((p.hostKey || undefined) !== (input.accountHost || undefined)) continue
    for (const n of p.nodes) {
      if (n.login || n.agentId !== 'claude' || n.accountId !== input.accountId) continue
      if (isBusyState(input.stateOf(n.id))) busy.push(n.id)
      else ready.push({ projectId: p.id, nodeId: n.id, sessionId: input.sessionIdOf(n.id) })
    }
  }
  return { ready, busy }
}

export function isBusyState(state: string | undefined): boolean {
  return state === 'working' || state === 'blocked'
}

/** The removal's refusal line, or null when nothing blocks it. */
export function removalBlockedText(label: string, busy: number, stuck: number): string | null {
  if (busy) {
    return (
      `${busy} ${busy === 1 ? 'session' : 'sessions'} on "${label}" ${busy === 1 ? 'is' : 'are'} ` +
      'working or waiting for an answer. Let them finish, then remove the account — their ' +
      'conversations move to the system account.'
    )
  }
  if (stuck) {
    return (
      `${stuck} ${stuck === 1 ? 'session' : 'sessions'} on "${label}" could not be moved to the ` +
      'system account, so the account was kept. Check those panes and try again.'
    )
  }
  return null
}

// ── Active canvas bridge (same register/lookup shape as agent-restart's closures) ─────────────

export interface ActiveCanvasAccountMover {
  /** The active canvas's Claude sessions on `accountId` (on `hostKey`'s machine). */
  sessions(accountId: string, hostKey: string | undefined): { ready: string[]; busy: string[] }
  /**
   * Move `ids` onto the system account. Resolves the ids that did NOT land — those still run under
   * the account, so its dir must not be deleted. `ctx` is the connected project on the account's
   * host, for an SSH account.
   */
  moveToSystem(
    accountId: string,
    ids: readonly string[],
    ctx: { projectId: string } | undefined
  ): Promise<string[]>
}

let activeMover: ActiveCanvasAccountMover | undefined

export function registerActiveCanvasAccountMover(mover: ActiveCanvasAccountMover): () => void {
  activeMover = mover
  return () => {
    if (activeMover === mover) activeMover = undefined
  }
}

export function activeCanvasAccountMover(): ActiveCanvasAccountMover | undefined {
  return activeMover
}
