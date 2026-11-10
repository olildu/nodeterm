// The live link's pty seam (link-host.ts `WatchPty`) over PtyManager — ONE definition both shells
// wire, because the join's rules are easy to get subtly wrong and a second copy is how one shell
// ends up a rule behind the other:
//  - the join passes only ids the host chose: the node id, the viewer id the link host minted, and
//    remote fields from the shell's own records (`remoteFor`) — never a size (R39): a watcher's own
//    tmux client is spawned at the window size PtyManager reads itself, or not at all (R19/R20);
//  - the size the viewer is told is the JOINED session's current size (`sessionSize`, R25), and a
//    session whose size is unknown is REFUSED rather than given a guessed 80x24 (R37/R39);
//  - a refusal that had already attached leaves what it attached (the link host only knows a session
//    id this seam answered, so it could not leave it);
//  - `alive` is PtyManager's explicit `hasSession` (R38), `syncSize` its per-session serialized sync (R24);
//  - a join reports how a controller's input reaches the JOINED session's PANE
//    (`watcherInputRoute`: `none` for Zellij or a session it no longer holds, which refuses control),
//    and `input` is `controlInput` — the pane, never a tmux client's key table — with the link host's
//    `isCurrent` predicate, asked right before the step runs.
//
// WHERE a node's session lives is `watchRemoteFor`, also ONE definition: an SSH project's node and a
// remote-tmux node in a LOCAL project (`ssh` + `sshRemoteTmux` on the node, served by the project's host
// attachment) are both watched on their HOST, over the master this machine already holds for them, or
// not at all (`requireRemote`): an unheld one must never join a same-named session on the LOCAL socket.
import type { PtyCreateOptions } from '../../shared/types'
import { sshConnectionIdForProject, type SshConnection } from '../../shared/ssh'
import type { PtyManager } from '../pty-manager'
import type { WorkspaceStore } from '../workspace-store'
import type { WatchPty } from './link-host'

export type WatchPtyManager = Pick<
  PtyManager,
  | 'joinAsWatcher'
  | 'sessionSize'
  | 'kill'
  | 'captureVisible'
  | 'syncWatcherClientSize'
  | 'hasSession'
  | 'controlInput'
  | 'watcherInputRoute'
>

/** Where a node's session lives, from the SHELL's own records. `requireRemote` for every node of an
 *  SSH project (a downed master must never let the local tmux attach a same-named local orphan). */
export interface WatchRemote {
  sshRemote?: PtyCreateOptions['sshRemote']
  requireRemote?: boolean
}

/** The shell's own records `watchRemoteFor` reads. Nothing here comes from a viewer. */
export interface WatchRemoteRecords {
  /** The SSH project that holds the node (`WorkspaceStore.sshProjectIdForNode`). */
  sshProjectIdForNode(nodeId: string): string | undefined
  /** Every persisted copy of the node: the machine-local id of the project holding it, that project's
   *  own SSH server (absent for a local project), and the node's binding fields as stored. */
  nodeCopies(nodeId: string): readonly { projectId: string; projectServer?: unknown; ssh?: unknown; sshRemoteTmux?: unknown }[]
  /** The live master of a connection id (`SshProjectManager.refForProject`); undefined when it is down. */
  refFor(connectionId: string): { conn: SshConnection; controlPath: string; remoteCwd?: string } | undefined
}

/**
 * The records over the workspace store — the same in both shells; only the masters differ (the desktop's
 * SSH-project manager; the Server Edition has none). The copies come from every project holding the
 * node (`projectIdsForNode`, memoized, answers "none" without a scan of every project file), each with
 * that project's own SSH server.
 */
export function watchRemoteRecords(
  store: Pick<WorkspaceStore, 'sshProjectIdForNode' | 'projectIdsForNode' | 'persistedCanvases' | 'projectTargetInfo'>,
  refFor: WatchRemoteRecords['refFor']
): WatchRemoteRecords {
  return {
    sshProjectIdForNode: (id) => store.sshProjectIdForNode(id),
    nodeCopies: (id) => {
      if (store.projectIdsForNode(id).length === 0) return []
      return store.persistedCanvases().flatMap((c) => {
        const n = c.nodes.find((x) => x.id === id)
        if (!n) return []
        return [{ projectId: c.id, projectServer: store.projectTargetInfo(c.id)?.ssh?.server, ssh: n.ssh, sshRemoteTmux: n.sshRemoteTmux }]
      })
    },
    refFor
  }
}

/** A binding read from hand-editable, git-shared data: an object with a non-empty string host. */
function sshConnOf(v: unknown): SshConnection | null {
  if (typeof v !== 'object' || v === null) return null
  const host = (v as { host?: unknown }).host
  return typeof host === 'string' && host ? (v as SshConnection) : null
}

/**
 * Where a watcher join for `nodeId` goes, from the shell's own records:
 *  - a node of an SSH project: that project's master (`requireRemote` always);
 *  - a node with `sshRemoteTmux` in any persisted copy — a remote-tmux node in a LOCAL project — its
 *    connection's master, chosen the way the canvas chooses it (`sshConnectionIdForProject`: the
 *    project's own when the hosts match, else the project × endpoint attachment), `requireRemote`
 *    whether or not that master is up (the renderer's own rule for the node's spawn);
 *  - anything else (a local node, a standalone ssh terminal whose `ssh` runs in LOCAL tmux): local.
 * Records that throw answer `requireRemote` with no master: a join that cannot be placed never reaches
 * the local socket. It joins only a REMOTE session this process already holds; a held LOCAL one is
 * refused (`held-elsewhere`, see PtyManager `join`), and otherwise it waits.
 */
export function watchRemoteFor(nodeId: string, r: WatchRemoteRecords): WatchRemote {
  try {
    const sshProject = r.sshProjectIdForNode(nodeId)
    if (sshProject) return remoteOver(r.refFor(sshProject))
    let remote = false
    for (const copy of r.nodeCopies(nodeId)) {
      if (copy.sshRemoteTmux !== true) continue
      remote = true
      const conn = sshConnOf(copy.ssh)
      if (!conn) continue
      const ref = r.refFor(sshConnectionIdForProject(copy.projectId, conn, sshConnOf(copy.projectServer) ?? undefined))
      if (ref) return remoteOver(ref)
    }
    return remote ? { requireRemote: true } : {}
  } catch {
    return { requireRemote: true }
  }
}
function remoteOver(ref: ReturnType<WatchRemoteRecords['refFor']>): WatchRemote {
  return {
    requireRemote: true,
    ...(ref ? { sshRemote: { conn: ref.conn, controlPath: ref.controlPath, remoteCwd: ref.remoteCwd ?? '~' } } : {})
  }
}

export function createWatchPty(pty: WatchPtyManager, remoteFor: (nodeId: string) => WatchRemote = () => ({})): WatchPty {
  return {
    async join(clientId, nodeId, viewerId) {
      const remote = remoteFor(nodeId)
      const res = await pty.joinAsWatcher(clientId, {
        persistKey: nodeId,
        viewerId,
        ...(remote.sshRemote ? { sshRemote: remote.sshRemote } : {}),
        ...(remote.requireRemote ? { requireRemote: true } : {})
      })
      if (!res.sessionId) return null
      const size = res.unavailable ? null : pty.sessionSize(res.sessionId)
      if (!size) {
        pty.kill(clientId, res.sessionId, viewerId)
        return null
      }
      return {
        sessionId: res.sessionId,
        cols: size.cols,
        rows: size.rows,
        altScreen: res.tmuxClient === true,
        input: pty.watcherInputRoute(res.sessionId)
      }
    },
    leave: (clientId, sessionId, viewerId) => pty.kill(clientId, sessionId, viewerId),
    captureVisible: (sessionId) => pty.captureVisible(sessionId),
    syncSize: (sessionId) => pty.syncWatcherClientSize(sessionId),
    alive: (sessionId) => pty.hasSession(sessionId),
    input: (sessionId, chunk, isCurrent) => pty.controlInput(sessionId, chunk, isCurrent)
  }
}
