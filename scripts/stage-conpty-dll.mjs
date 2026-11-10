#!/usr/bin/env node
/**
 * stage-conpty-dll.mjs — put node-pty's bundled ConPTY (`conpty.dll` + `OpenConsole.exe`) beside
 * the electron-rebuilt `conpty.node`, on Windows only.
 *
 * WHY: node-pty's native `LoadConptyDll` (src/win/conpty.cc) looks for
 * `<directory of the loaded conpty.node>\conpty\conpty.dll` when spawned with
 * `useConptyDll: true`. node-pty's own post-install.js copies the files from
 * `third_party/conpty/<version>/win10-<arch>/` into `build/Release/conpty/` — but our postinstall
 * then runs `electron-rebuild -f`, which is `node-gyp rebuild`, whose `clean` step deletes the
 * whole `build/` directory. The rebuilt `build/Release/conpty.node` is the one node-pty loads
 * (build/Release is tried before prebuilds/), so without this step the sidecar is gone and
 * `src/core/windows-conpty-dll.ts` falls back to the OS inbox ConPTY — which on Windows 10 does
 * not pass mouse-tracking / alternate-screen modes through (see docs/windows-session-host.md).
 *
 * Runs AFTER electron-rebuild (postinstall + rebuild). A no-op off Windows, when the rebuilt module
 * is absent, or when the arch has no bundled ConPTY. Never fails the install: the runtime helper
 * already degrades to the inbox ConPTY when the files are missing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CONPTY_FILES = ['conpty.dll', 'OpenConsole.exe']
const SUPPORTED_ARCH = ['x64', 'arm64']

/**
 * @param {{ ptyDir: string, platform?: string, arch?: string, fsImpl?: typeof fs }} opts
 * @returns {{ staged: boolean, reason: string }}
 */
export function stageConptyDll({ ptyDir, platform = process.platform, arch, fsImpl = fs }) {
  if (platform !== 'win32') return { staged: false, reason: 'not Windows' }
  const windowsArch = arch ?? process.env.npm_config_arch ?? process.arch
  if (!SUPPORTED_ARCH.includes(windowsArch)) {
    return { staged: false, reason: `no bundled ConPTY for ${windowsArch}` }
  }
  const releaseDir = path.join(ptyDir, 'build', 'Release')
  if (!fsImpl.existsSync(path.join(releaseDir, 'conpty.node'))) {
    return { staged: false, reason: 'build/Release/conpty.node not built' }
  }
  const conptyRoot = path.join(ptyDir, 'third_party', 'conpty')
  if (!fsImpl.existsSync(conptyRoot)) return { staged: false, reason: 'third_party/conpty missing' }
  // node-pty's own post-install takes the first (and only) version folder; do the same.
  const versionFolder = fsImpl.readdirSync(conptyRoot).sort()[0]
  if (!versionFolder) return { staged: false, reason: 'third_party/conpty is empty' }
  const sourceDir = path.join(conptyRoot, versionFolder, `win10-${windowsArch}`)
  const destDir = path.join(releaseDir, 'conpty')
  for (const f of CONPTY_FILES) {
    if (!fsImpl.existsSync(path.join(sourceDir, f))) {
      return { staged: false, reason: `missing ${path.join(sourceDir, f)}` }
    }
  }
  fsImpl.mkdirSync(destDir, { recursive: true })
  for (const f of CONPTY_FILES) fsImpl.copyFileSync(path.join(sourceDir, f), path.join(destDir, f))
  return { staged: true, reason: `copied ${versionFolder}/win10-${windowsArch}` }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const ptyDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty')
  try {
    const r = stageConptyDll({ ptyDir })
    console.log(`[stage-conpty-dll] ${r.staged ? 'staged' : 'skipped'}: ${r.reason}`)
  } catch (err) {
    // Never fail the install: the runtime falls back to the inbox ConPTY.
    console.warn(`[stage-conpty-dll] could not stage the bundled ConPTY: ${err && err.message}`)
  }
}
