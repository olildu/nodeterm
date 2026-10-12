#!/usr/bin/env node
/**
 * Build the Android emulator helper (`resources/bin/android-helper.cjs`) from native/android-helper/src.
 *
 * WHY a Node script and not a native binary: everything it needs is public — the emulator's gRPC
 * endpoint (screen + input) and adb (uiautomator) — so one CommonJS file run by Electron's own Node
 * (`ELECTRON_RUN_AS_NODE=1`, see src/core/sim/helper-path.ts) covers every desktop OS. It speaks the
 * same stdio protocol as the iOS `sim-helper` (native/sim-helper/PROTOCOL.md).
 *
 * esbuild bundles the sources into one file with NO runtime dependencies except `sharp`, which stays
 * external: nodeterm already ships it (asar-unpacked), and the helper resolves it from the app
 * (`NODETERM_REQUIRE_FROM`) or, in dev, from the repo's node_modules.
 *
 * The output is gitignored (resources/bin/ is); this script is the source of truth.
 *
 * Usage: node scripts/build-android-helper.mjs [--force]
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(repoRoot, 'native', 'android-helper', 'src')
const outDir = path.join(repoRoot, 'resources', 'bin')
const outFile = path.join(outDir, 'android-helper.cjs')
const markerFile = path.join(outDir, '.android-helper-build-hash')
const RECIPE_REV = 'r1'

const sources = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort()
const hash = crypto.createHash('sha256')
for (const f of sources) hash.update(f).update(fs.readFileSync(path.join(srcDir, f)))
const marker = `${hash.digest('hex')} ${RECIPE_REV}\n`

if (!process.argv.includes('--force') && fs.existsSync(outFile) && fs.existsSync(markerFile) && fs.readFileSync(markerFile, 'utf8') === marker) {
  console.log(`[android-helper] up to date: ${path.relative(repoRoot, outFile)}`)
  process.exit(0)
}

fs.mkdirSync(outDir, { recursive: true })
const staged = path.join(outDir, `.android-helper.${process.pid}.tmp`)
await build({
  entryPoints: [path.join(srcDir, 'main.ts')],
  outfile: staged,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['sharp'],
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  logLevel: 'warning'
})
fs.chmodSync(staged, 0o755)
fs.renameSync(staged, outFile)
fs.writeFileSync(markerFile, marker)
console.log(`[android-helper] built ${path.relative(repoRoot, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)`)
