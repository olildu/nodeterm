// Is this folder too broad to SHARE with a relay peer (a Team Access scoped guest, a hosted team's
// Viewers and Commenters)?
//
// What a shared folder hands out: every file under it is readable by every peer, Viewers included
// (the fs jail is the shared root minus this app's data dir, and nothing else). A project rooted at
// the host's home directory therefore hands out `~/.ssh`, the agents' credentials and nodeterm's own
// hook tokens; one rooted at `/` hands out the machine (security audit F4, 2026-10). The Share with
// team flow already refuses those folders (shared/share-team.ts `sharePlan`, workspace-store
// `adoptFolderNow`); this is the same rule for every other way a folder becomes shared.
//
// Refused: the filesystem root, the home directory, any ANCESTOR of the home directory, and the data
// directory or any ancestor of it. Compared on REAL paths, segment by segment, so a symlinked project
// folder or home cannot slip past. A folder BELOW the home directory is the ordinary case and is fine.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

/** `p` is `root` or below it. Relative-path based, so a sibling like `/srv/app2` is not inside
 *  `/srv/app`, a root of `/` contains everything, and a path on another Windows drive is outside.
 *  (The one definition; access-policy.ts re-exports it.) */
export function within(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

export const SHARE_ROOT_REFUSAL = Object.freeze({
  root: "This project's folder is the root of the disk. Whoever you share it with could read every file on this machine. Move the project into its own folder, then share it.",
  home: "This project's folder is your home directory. Whoever you share it with could read every file in it, your SSH keys included. Move the project into its own folder, then share it.",
  homeAncestor:
    "This project's folder contains your home directory. Whoever you share it with could read every file in it, your SSH keys included. Move the project into its own folder, then share it.",
  dataDir:
    "This project's folder contains nodeterm's own data folder. Move the project into its own folder, then share it."
})

export interface ShareRootDeps {
  /** The host user's home directory. Default `os.homedir()`. */
  home?: string
  /** This app's own data directory (userData / the server's data dir). */
  dataDir?: string
  /** `fs.realpathSync`, null when the path does not resolve. Injected for tests. */
  realpath?(p: string): string | null
}

const defaultRealpath = (p: string): string | null => {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

/**
 * Why `cwd` may not be shared with a relay peer, or null when it may. A cwd that is not an absolute
 * path is not a root at all (the jail refuses every path against it), so it answers null here; an
 * SSH project (no local folder) likewise.
 */
export function shareRootProblem(cwd: string | undefined | null, deps: ShareRootDeps = {}): string | null {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null
  const realpath = deps.realpath ?? defaultRealpath
  const real = realpath(path.resolve(cwd)) ?? path.resolve(cwd)
  if (path.parse(real).root === real) return SHARE_ROOT_REFUSAL.root
  const home = deps.home ?? os.homedir()
  if (typeof home === 'string' && path.isAbsolute(home)) {
    const homeReal = realpath(path.resolve(home)) ?? path.resolve(home)
    if (within(real, homeReal)) return real === homeReal ? SHARE_ROOT_REFUSAL.home : SHARE_ROOT_REFUSAL.homeAncestor
  }
  const dataDir = deps.dataDir
  if (typeof dataDir === 'string' && path.isAbsolute(dataDir)) {
    const dataReal = realpath(path.resolve(dataDir)) ?? path.resolve(dataDir)
    if (within(real, dataReal)) return SHARE_ROOT_REFUSAL.dataDir
  }
  return null
}
