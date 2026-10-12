import path from 'node:path'
import { prepareScreenshotParent, type ScreenshotDirOps } from './screenshot-dir'

/**
 * Where `sim --screenshot` may write: inside the project folder OR inside the OS temp area. An agent's
 * natural scratch space (its scratchpad, `os.tmpdir()`, `/tmp`) is outside the project, and refusing it
 * pushed agents to write into the repository. The same jail logic judges both kinds of root, and
 * everything is decided on REAL paths: the parent of the target must canonicalise inside the root
 * (a symlink anywhere on the way out refuses), and a symlink planted at the target name itself is refused.
 *
 * `roots` are the temp areas to accept (the shell passes `os.tmpdir()` and, on POSIX, `/tmp`); each is
 * canonicalised here, so `/tmp` → `/private/tmp` on macOS is handled.
 */
export interface SimShotPathDeps extends ScreenshotDirOps {
  lstat(p: string): Promise<{ isSymbolicLink(): boolean }>
}

export type SimShotPath = { ok: true; abs: string } | { ok: false; message: string }

export const SIM_SHOT_OUTSIDE =
  'sim: --screenshot path must be inside the project directory or the OS temp directory'

async function insideRoot(root: string, raw: string, deps: SimShotPathDeps): Promise<SimShotPath | null> {
  const abs = path.resolve(root, raw)
  let realRoot: string
  try {
    realRoot = await deps.realpath(root)
  } catch {
    return null
  }
  const lexical = root.endsWith(path.sep) ? root : root + path.sep
  const lexicalOk = abs.startsWith(lexical) || abs === root
  // A path that is neither lexically under the root nor under its real path cannot be inside it.
  const realLexical = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
  if (!lexicalOk && !abs.startsWith(realLexical)) return null
  // Make missing folders (only below an existing ancestor that is really inside the root).
  try {
    await prepareScreenshotParent(root, raw, deps)
  } catch {
    return null
  }
  let realParent: string
  try {
    realParent = await deps.realpath(path.dirname(abs))
  } catch {
    return null
  }
  if (realParent !== realRoot && !realParent.startsWith(realLexical)) return null
  const target = path.join(realParent, path.basename(abs))
  try {
    if ((await deps.lstat(target)).isSymbolicLink()) return null
  } catch {
    /* does not exist yet — the normal case */
  }
  return { ok: true, abs: target }
}

export async function resolveSimScreenshotPath(
  projectCwd: string | undefined,
  tempRoots: string[],
  raw: string,
  deps: SimShotPathDeps
): Promise<SimShotPath> {
  if (projectCwd) {
    const r = await insideRoot(projectCwd, raw, deps)
    if (r) return r
  }
  // Temp areas take an ABSOLUTE path, or a relative one when there is no project folder. A relative path
  // the project jail refused (`../x`) must never be retried against a temp root.
  if (projectCwd && !path.isAbsolute(raw)) return { ok: false, message: SIM_SHOT_OUTSIDE }
  for (const root of tempRoots) {
    const r = await insideRoot(root, raw, deps)
    if (r) return r
  }
  return { ok: false, message: SIM_SHOT_OUTSIDE }
}
