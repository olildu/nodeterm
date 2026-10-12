/**
 * Where `sim-helper` lives: `<Resources>/bin/sim-helper` in a packaged build (electron-builder's
 * mac extraResources), `<repo>/resources/bin/sim-helper` under `electron-vite dev` — the same two
 * candidates, in the same order, as the bundled tmux (`bundledTmuxPath`), and for the same reason
 * (`npm run build:sim-helper` writes the dev copy). `exists` is injected so this stays pure; a
 * throwing `exists` reads as "not here". There is no "system" candidate to prefer: the helper is
 * ours, so a missing one is a named error the node shows, never a lookup that wanders onto PATH.
 */
export function simHelperPath(opts: {
  resourcesPath?: string | null
  repoRoot?: string | null
  exists: (path: string) => boolean
}): string | null {
  const candidates: string[] = []
  if (opts.resourcesPath) candidates.push(`${opts.resourcesPath}/bin/sim-helper`)
  if (opts.repoRoot) candidates.push(`${opts.repoRoot}/resources/bin/sim-helper`)
  for (const candidate of candidates) {
    try {
      if (opts.exists(candidate)) return candidate
    } catch {
      // unreadable — keep looking
    }
  }
  return null
}
