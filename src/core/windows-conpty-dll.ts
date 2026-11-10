import fs from 'fs'
import path from 'path'

/**
 * Which ConPTY a Windows terminal spawns on: the node-pty-BUNDLED one, when it is actually there.
 *
 * WHY: the inbox ConPTY of Windows 10 (the 19041 servicing line, 22H2 = 19045 included) does not
 * pass the DEC private mouse-tracking modes (?1000/?1002/?1006) or the alternate screen (?1049)
 * through to the terminal on the other end. xterm.js therefore never enters mouse-tracking mode,
 * never forwards a wheel event to the pty, and — because ConPTY repaints in place — has no
 * scrollback of its own either: in a full-screen TUI (Claude Code's `/tui fullscreen`) the wheel
 * does nothing and earlier conversation is unreachable. node-pty 1.1.0 ships a newer ConPTY
 * (`conpty.dll` + `OpenConsole.exe`) that is used instead of the OS one with `useConptyDll: true`.
 *
 * WHERE node-pty looks: NOT in `third_party/`. The native `LoadConptyDll` (src/win/conpty.cc)
 * resolves `<directory of the loaded conpty.node>\conpty\conpty.dll`, and `conpty.node` is the
 * first one `loadNativeModule` (lib/utils.js) finds among `build/Release`, `build/Debug`,
 * `prebuilds/<platform>-<arch>`, each tried relative to `lib/..` and then `lib/.`. A missing DLL
 * there is a THROWN spawn, not a fallback — so we only ask for it after seeing both files at that
 * exact place (`scripts/stage-conpty-dll.mjs` puts them next to the electron-rebuilt module).
 *
 * Fail-open by construction: any other platform, any missing file, any fs/resolve error ⇒ `{}`,
 * i.e. the inbox ConPTY and the spawn options byte-identical to before. Never throws.
 */
export interface ConptyDllDeps {
  platform?: NodeJS.Platform
  arch?: string
  /** node-pty's package root (the directory holding its package.json). */
  nodePtyRoot?: () => string
  exists?: (p: string) => boolean
}

const NATIVE_DIRS = (platform: string, arch: string): string[] => [
  'build/Release',
  'build/Debug',
  `prebuilds/${platform}-${arch}`
]

export function windowsConptySpawnOptions(deps: ConptyDllDeps = {}): { useConptyDll?: true } {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return {}
  try {
    const arch = deps.arch ?? process.arch
    const exists = deps.exists ?? ((p: string) => fs.existsSync(p))
    const root = (deps.nodePtyRoot ?? (() => path.dirname(require.resolve('node-pty/package.json'))))()
    const libDir = path.join(root, 'lib')
    for (const d of NATIVE_DIRS(platform, arch)) {
      for (const r of ['..', '.']) {
        const dir = path.join(libDir, r, d)
        if (!exists(path.join(dir, 'conpty.node'))) continue
        // This is the conpty.node node-pty will load, so its sidecar is the one that counts — a
        // DLL beside a later candidate would not be found by the native loader.
        const ok =
          exists(path.join(dir, 'conpty', 'conpty.dll')) &&
          exists(path.join(dir, 'conpty', 'OpenConsole.exe'))
        return ok ? { useConptyDll: true } : {}
      }
    }
    return {}
  } catch {
    return {}
  }
}
