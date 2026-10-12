import path from 'node:path'

/**
 * Makes the parent folder of a `--screenshot` path so the first shot into `.maestro/` (or any folder
 * that does not exist yet) works — and ONLY when that folder lies inside the project.
 *
 * The path jail the verb shares with `browser` (`resolveScreenshotPath`) canonicalises the PARENT of
 * the target with `realpath`, which a folder that does not exist yet cannot satisfy, so it refused
 * "must be inside the project directory" for a perfectly fine `shots/home.png`. Creating the folder
 * first would be unsafe done naively: `mkdir -p` follows symlinks, and a symlink committed into the
 * repository (`shots -> ~/.ssh`) would make the agent create folders outside it before the jail ever
 * ran. So the folders that already exist are CANONICALISED first, the deepest one must be inside the
 * project's real path, and only the missing remainder — which by definition holds no symlink — is
 * created, under that canonical ancestor. The jail still runs afterwards and judges the result; this
 * only removes a refusal that was never about safety.
 */
export interface ScreenshotDirOps {
  realpath(p: string): Promise<string>
  mkdir(p: string, opts: { recursive: true }): Promise<unknown>
}

export async function prepareScreenshotParent(
  projectCwd: string | undefined,
  rawPath: string,
  fs: ScreenshotDirOps
): Promise<void> {
  if (!projectCwd) return
  const parent = path.dirname(path.resolve(projectCwd, rawPath))
  let realBase: string
  try {
    realBase = await fs.realpath(projectCwd)
  } catch {
    return
  }
  // Walk up to the deepest folder that exists.
  let existing = parent
  let realExisting: string | null = null
  for (;;) {
    try {
      realExisting = await fs.realpath(existing)
      break
    } catch {
      const up = path.dirname(existing)
      if (up === existing) return
      existing = up
    }
  }
  const withSep = realBase.endsWith(path.sep) ? realBase : realBase + path.sep
  if (realExisting !== realBase && !realExisting.startsWith(withSep)) return
  const remainder = path.relative(existing, parent)
  if (!remainder) return // the folder is already there
  await fs.mkdir(path.join(realExisting, remainder), { recursive: true })
}
