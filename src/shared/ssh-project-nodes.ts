// Where an SSH project's nodes RUN is decided by the PROJECT, never by the node's own fields
// (issue #1186).
//
// An SSH project's `.nodeterm/project.json` lives on the remote host, and other writers put nodes
// into it: the host's own desktop (which opened the same folder as a LOCAL project — its nodes carry
// a portable `cwd: "."` and no `ssh`/`sshRemoteTmux`, because on the host they ARE local), a
// teammate, git, a hand edit. Routing used to come only from `data.sshRemoteTmux`, stamped by the
// node factories at creation on THIS machine, so every node another writer added was treated as a
// LOCAL terminal: an agent shown inside the SSH project ran on this machine, in whatever directory
// "." meant here, under the same `nt-<id>` the host was running.
//
// Two halves, both pure:
//  - `routeSshProjectNodes` (READ): every session node of an SSH project runs on the project's host,
//    with its cwd resolved against the project's remote folder. Applied wherever an SSH project's
//    nodes are turned into canvas state (`fileToProject`) or read back for a routing decision
//    (`WorkspaceStore.persistedCanvases` / `getNodeResolved`).
//  - `neutralSshProjectNodes` (WRITE): the same fields are taken back OUT of the file we write to
//    the host. The file is shared with whoever else opens that folder — above all the host's own
//    desktop, for which a node stamped "runs over ssh on <host>" is a node that cannot run at all.
//    The file therefore records shared LAYOUT, and each machine derives where a node runs from its
//    own machine-local record of the project.
//
// Two node shapes keep their own routing, because the node's fields say something the project
// cannot: a plain `ssh <host>` terminal (`ssh` without `sshRemoteTmux` — a LOCAL pty whose program
// is `ssh`), and a host ATTACHMENT (`sshRemoteTmux` with an `ssh` naming another host). Neither can
// put a local shell on this machine that the user did not already get from the same field in any
// local project.
import type { CanvasNodeState } from './types'
import type { SshConnection } from './ssh'

export interface SshProjectBinding {
  server: SshConnection
  remoteCwd: string
}

/** Kinds that run a pty session (`nodeStatesToFlow` reads a missing kind as `terminal`). */
const isSessionKind = (n: CanvasNodeState): boolean => n.kind === undefined || n.kind === 'terminal'
/** Kinds whose file access goes over the project's remote fs when `sshFs` is set. */
const isRemoteFsKind = (n: CanvasNodeState): boolean =>
  n.kind === 'editor' || n.kind === 'video' || n.kind === 'files'

const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\')

/**
 * A node cwd as the REMOTE shell must see it. Portable `.`/`./x` (and a bare relative path) are
 * joined onto the project's remote folder with POSIX separators; an absolute POSIX path or a `~`
 * path is the host's already. A missing cwd, or one only another OS could have written (a Windows
 * drive path), falls back to the project folder rather than to the remote `$HOME`.
 */
export function remoteNodeCwd(cwd: unknown, remoteCwd: string): string {
  if (typeof cwd !== 'string' || cwd === '' || cwd === '.' || cwd === './') return remoteCwd
  if (cwd.startsWith('/') || cwd === '~' || cwd.startsWith('~/')) return cwd
  if (isWindowsPath(cwd)) return remoteCwd
  const rel = cwd.startsWith('./') ? cwd.slice(2) : cwd
  return `${remoteCwd.replace(/\/+$/, '')}/${rel}`
}

/** The portable inverse of `remoteNodeCwd` for the shared file: a path inside the project folder
 *  becomes `.`/`./x`, so a machine that opened the same folder LOCALLY resolves it against its own
 *  root. Anything outside the folder is left as written. */
export function portableRemoteCwd(cwd: string | undefined, remoteCwd: string): string | undefined {
  if (typeof cwd !== 'string') return cwd
  const root = remoteCwd.replace(/\/+$/, '')
  if (!root) return cwd
  if (cwd === root || cwd === `${root}/`) return '.'
  if (cwd.startsWith(`${root}/`)) return `./${cwd.slice(root.length + 1)}`
  return cwd
}

/** A plain `ssh <host>` terminal: a local pty whose program is `ssh`. */
const isPlainSshTerminal = (n: CanvasNodeState): boolean => !!n.ssh && n.sshRemoteTmux !== true

/** A remote session attached to ANOTHER host than the project's own (see `sshConnectionIdForProject`). */
const isForeignAttachment = (n: CanvasNodeState, server: SshConnection): boolean =>
  n.sshRemoteTmux === true && !!n.ssh?.host && n.ssh.host !== server.host

/** One node, routed by its SSH project (see the file header). */
export function routeSshProjectNode(n: CanvasNodeState, binding: SshProjectBinding): CanvasNodeState {
  if (isSessionKind(n)) {
    if (isPlainSshTerminal(n) || isForeignAttachment(n, binding.server)) return n
    return {
      ...n,
      ssh: { ...binding.server },
      sshRemoteTmux: true,
      cwd: remoteNodeCwd(n.cwd, binding.remoteCwd)
    }
  }
  if (isRemoteFsKind(n)) {
    return {
      ...n,
      sshFs: true,
      ...(n.kind === 'files' ? { cwd: remoteNodeCwd(n.cwd, binding.remoteCwd) } : {})
    }
  }
  return n
}

export function routeSshProjectNodes(
  nodes: CanvasNodeState[],
  binding: SshProjectBinding | undefined
): CanvasNodeState[] {
  if (!binding) return nodes
  return nodes.map((n) => routeSshProjectNode(n, binding))
}

/** One node, as written to the SSH project's shared file (see the file header). */
export function neutralSshProjectNode(n: CanvasNodeState, binding: SshProjectBinding): CanvasNodeState {
  if (isSessionKind(n)) {
    if (n.sshRemoteTmux !== true || isForeignAttachment(n, binding.server)) return n
    const { ssh: _ssh, sshRemoteTmux: _tmux, ...rest } = n
    const cwd = portableRemoteCwd(n.cwd, binding.remoteCwd)
    return { ...rest, ...(cwd === undefined ? {} : { cwd }) }
  }
  if (isRemoteFsKind(n) && n.sshFs !== undefined) {
    const { sshFs: _fs, ...rest } = n
    if (n.kind !== 'files') return rest
    const cwd = portableRemoteCwd(n.cwd, binding.remoteCwd)
    return { ...rest, ...(cwd === undefined ? {} : { cwd }) }
  }
  return n
}

export function neutralSshProjectNodes(
  nodes: CanvasNodeState[],
  binding: SshProjectBinding | undefined
): CanvasNodeState[] {
  if (!binding) return nodes
  return nodes.map((n) => neutralSshProjectNode(n, binding))
}
