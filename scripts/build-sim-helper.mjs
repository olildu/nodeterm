#!/usr/bin/env node
/**
 * Build the native iOS Simulator helper (`resources/bin/sim-helper`) from native/sim-helper/src.
 *
 * WHY a native binary: the Simulator's screen, HID input and accessibility tree are only reachable
 * through Apple's private CoreSimulator / SimulatorKit / AccessibilityPlatformTranslation frameworks.
 * One long-lived Objective-C process per device speaks a small stdio protocol
 * (native/sim-helper/PROTOCOL.md) so nodeterm's main process never links private API itself.
 *
 * Shape: clang compiles each arch slice (arm64 + x86_64) and `lipo` joins them. Only the Xcode
 * command line tools are needed — no npm dependencies, no Xcode project. The private frameworks are
 * dlopen'ed at RUN time (from /Library/Developer/PrivateFrameworks and `xcode-select -p`), so the
 * build does not need them and the binary starts (and says so) on a machine without Xcode.
 *
 * The output is gitignored (resources/bin/ is); this script is the source of truth. macOS only.
 *
 * Usage: node scripts/build-sim-helper.mjs [--force] [--verbose] [--host-arch-only]
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(repoRoot, 'native', 'sim-helper', 'src')
const outDir = path.join(repoRoot, 'resources', 'bin')
const outFile = path.join(outDir, 'sim-helper')
const markerFile = path.join(outDir, '.sim-helper-build-hash')

/** Bump when the recipe (flags, slices) changes in a way the sources' hash does not capture. */
const RECIPE_REV = 'r1'
const ARCHS = [
  { arch: 'arm64', minOs: '11.0' },
  { arch: 'x86_64', minOs: '10.15' }
]
const FRAMEWORKS = ['Foundation', 'AppKit', 'CoreImage', 'ImageIO', 'IOSurface', 'CoreGraphics']
const CFLAGS = [
  '-fobjc-arc', '-O2', '-Wall', '-Wno-deprecated-declarations', '-Wno-unused-function',
  // The err out-params are only written synchronously, inside the caller's autorelease pool.
  '-Wno-block-capture-autoreleasing'
]

const force = process.argv.includes('--force')
const verbose = process.argv.includes('--verbose')
const hostOnly = process.argv.includes('--host-arch-only')

function run(cmd, args) {
  if (verbose) console.log(`$ ${cmd} ${args.join(' ')}`)
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

if (process.platform !== 'darwin') {
  console.log('[sim-helper] macOS only — skipping')
  process.exit(0)
}

const sources = fs.readdirSync(srcDir).filter((f) => /\.(m|h)$/.test(f)).sort()
const hash = crypto.createHash('sha256')
for (const f of sources) hash.update(f).update(fs.readFileSync(path.join(srcDir, f)))
const archs = hostOnly ? ARCHS.filter((a) => a.arch === os.arch().replace('x64', 'x86_64')) : ARCHS
const marker = `${hash.digest('hex')} ${RECIPE_REV} ${archs.map((a) => a.arch).join('+')}\n`

if (!force && fs.existsSync(outFile) && fs.existsSync(markerFile) && fs.readFileSync(markerFile, 'utf8') === marker) {
  console.log(`[sim-helper] up to date: ${path.relative(repoRoot, outFile)}`)
  process.exit(0)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-helper-build-'))
try {
  const slices = []
  for (const { arch, minOs } of archs) {
    const out = path.join(tmp, `sim-helper-${arch}`)
    run('clang', [
      ...CFLAGS, '-arch', arch, `-mmacosx-version-min=${minOs}`,
      ...FRAMEWORKS.flatMap((f) => ['-framework', f]),
      ...sources.filter((f) => f.endsWith('.m')).map((f) => path.join(srcDir, f)),
      '-o', out
    ])
    slices.push(out)
  }
  fs.mkdirSync(outDir, { recursive: true })
  const staged = path.join(outDir, `.sim-helper.${process.pid}.tmp`)
  if (slices.length === 1) fs.copyFileSync(slices[0], staged)
  else run('lipo', ['-create', ...slices, '-output', staged])
  fs.chmodSync(staged, 0o755)
  // Ad-hoc sign so the linker-signed slices survive lipo; real signing is the release job's.
  try { run('codesign', ['--force', '--sign', '-', staged]) } catch { /* unsigned still runs locally */ }
  fs.renameSync(staged, outFile)
  fs.writeFileSync(markerFile, marker)
  const v = run(outFile, ['--version']).trim()
  const info = run('lipo', ['-info', outFile]).trim()
  console.log(`[sim-helper] built ${path.relative(repoRoot, outFile)} — ${v} — ${info.replace(/^.*: /, '')}`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
