#!/usr/bin/env node
/**
 * patch-smart-whisper.mjs — gives Linux x64 a SIMD build of whisper.cpp (issue #1267).
 *
 * WHAT IT FIXES
 *   smart-whisper's binding.gyp compiles whisper.cpp/ggml with no -m flags, so on x86-64 the
 *   compiler targets the SSE2 baseline and every AVX/AVX2/FMA/F16C kernel in ggml is compiled out
 *   (`objdump -d smart-whisper.node | grep -c ymm` = 0 on the shipped Linux build). macOS arm64 is
 *   unaffected (NEON is baseline and Metal does the heavy lifting). Measured on a 12-thread AVX2
 *   machine, base model, 3 s of audio: 18.8 s as shipped vs 1.9 s with -mavx2 -mfma -mf16c — the
 *   report was large-v3-turbo taking ~7 minutes for one sentence.
 *
 *   A single -mavx2 build would SIGILL on CPUs without AVX2 (pre-Haswell, many Atom/Pentium
 *   parts), killing the whole app on the first dictation. So we build BOTH:
 *     - `smart-whisper.node`       — untouched baseline, loads everywhere
 *     - `smart-whisper-avx2.node`  — linux x64 only, -mavx -mavx2 -mfma -mf16c
 *   and choose at load time from the CPU's own flags (`pickWhisperBinary` in
 *   src/core/speech/speech-service.ts). The choice reaches smart-whisper's loader through
 *   `globalThis.__NODETERM_WHISPER_BINARY__`; the patched loader falls back to the baseline when
 *   the variant file is absent or fails to load, so a missing/broken variant degrades to the old
 *   speed, never to "dictation unavailable".
 *
 * PROPERTIES
 *   - Idempotent (PATCH_MARKER), and every anchor must match exactly once or the script exits
 *     non-zero — a smart-whisper upgrade that reshapes these files fails the install loudly.
 *   - Cross-platform safe: the extra target sits behind a gyp `OS=="linux" and target_arch=="x64"`
 *     condition, so mac/Windows builds are byte-for-byte what they were. The loader change is a
 *     no-op when nothing sets the global.
 *   - Runs before electron-rebuild in `postinstall` / `rebuild`, so the native build sees it.
 *
 * SECOND PATCH: Metal shaders in a packaged app (macOS)
 *   smart-whisper tells whisper.cpp where its Metal shader source is through
 *   GGML_METAL_PATH_RESOURCES, built from its own __dirname. In the packaged app dist/ is inside
 *   app.asar, and native code cannot read inside an asar ("Not a directory"), so Metal init fails
 *   and whisper.cpp silently runs on the CPU. The shader file is already unpacked beside it
 *   (asarUnpack), so the patch points at app.asar.unpacked. Measured on an M5 Pro, Electron 42,
 *   large-v3-turbo, 2.7 s clip, the app's own binary: 5.97 s on the CPU vs 0.64 s on Metal. An
 *   explicit GGML_METAL_PATH_RESOURCES and a dev install are left unchanged.
 *
 * THIRD PATCH: initialized context params (every platform)
 *   smart-whisper's `LoadModel` (src/binding/model.cc) declares `whisper_context_params params;`
 *   and sets only `use_gpu`, so every other field (dtw_token_timestamps, dtw_aheads_preset,
 *   gpu_device, flash_attn, ...) is uninitialized stack memory. What it holds decides the outcome:
 *   with DTW switched on by garbage, whisper_init_state() fails for large-v3-turbo ("tried to set
 *   alignment head on text layer 14, but model only has 4 text layers") and the app aborts in
 *   whisper_free_state. Measured on an M5 Pro, Electron 42, large-v3-turbo, 2.7 s and 21 s clips:
 *   the shipped binary crashed in 4 of 4 runs outside the app; with the params initialized it ran
 *   without a crash (0.56 s and 0.93 s on Metal). The slow dictation seen inside the packaged app is
 *   a separate bug, the second patch above. The fix starts from
 *   whisper_context_default_params(), exactly what whisper.cpp's own examples do.
 *
 * GUARD: src/core/speech/smart-whisper-patch.test.ts asserts every marker is present in the
 * installed sources. If it is red, your node_modules is unpatched — run `npm run rebuild`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PATCH_MARKER = 'NODETERM-PATCH(smart-whisper-simd)'
export const VARIANT_TARGET = 'smart-whisper-avx2'
export const SIMD_FLAGS = ['-mavx', '-mavx2', '-mfma', '-mf16c']

const LOADER_FIND =
  'var module2 = require(import_node_path.default.join(__dirname, "../build/Release/smart-whisper"));'

const LOADER_REPLACE = `// ${PATCH_MARKER}: load the binary nodeterm picked for this CPU, falling back to the baseline.
var module2 = (() => {
  const base = import_node_path.default.join(__dirname, "../build/Release/smart-whisper");
  const want = globalThis.__NODETERM_WHISPER_BINARY__;
  if (typeof want === "string" && /^smart-whisper-[a-z0-9]+$/.test(want)) {
    const file = import_node_path.default.join(__dirname, "../build/Release", want);
    if (require("fs").existsSync(file + ".node")) {
      try {
        const m = require(file);
        globalThis.__NODETERM_WHISPER_LOADED__ = want;
        return m;
      } catch (err) {
        console.warn("[speech] " + want + " failed to load, using the baseline build:", err);
      }
    }
  }
  globalThis.__NODETERM_WHISPER_LOADED__ = "smart-whisper";
  return require(base);
})();`

const GYP_FIND = '    }\n  ],\n}'

export const METAL_MARKER = 'NODETERM-PATCH(smart-whisper-metal-asar)'

const METAL_FIND =
  'process.env.GGML_METAL_PATH_RESOURCES = process.env.GGML_METAL_PATH_RESOURCES || import_node_path.default.join(__dirname, "../whisper.cpp/ggml/src");'

const METAL_REPLACE = `// ${METAL_MARKER}: native code cannot read inside app.asar; use the unpacked copy.
process.env.GGML_METAL_PATH_RESOURCES = process.env.GGML_METAL_PATH_RESOURCES || import_node_path.default.join(__dirname, "../whisper.cpp/ggml/src").replace(/([\\\\/])app\\.asar(?=[\\\\/])/, "$1app.asar.unpacked");`

export const CTX_PARAMS_MARKER = 'NODETERM-PATCH(smart-whisper-ctx-params)'

const PARAMS_FIND = '    whisper_context_params params;\n    params.use_gpu'

const PARAMS_REPLACE =
  `    // ${CTX_PARAMS_MARKER}: start from the defaults; the bare declaration left every\n` +
  `    // other field (DTW, gpu_device, flash_attn, ...) as uninitialized stack memory.\n` +
  '    whisper_context_params params = whisper_context_default_params();\n' +
  '    params.use_gpu'

/** Patches the smart-whisper package in `dir`. Returns 'patched' | 'already-patched'. */
export function patchSmartWhisper(dir) {
  const gypPath = path.join(dir, 'binding.gyp')
  const jsPath = path.join(dir, 'dist', 'index.js')
  const gyp = fs.readFileSync(gypPath, 'utf8')
  const js = fs.readFileSync(jsPath, 'utf8')
  const modelPath = path.join(dir, 'src', 'binding', 'model.cc')
  const model = readOrFail(modelPath, 'src/binding/model.cc')
  const gypDone = gyp.includes(PATCH_MARKER)
  const jsDone = js.includes(PATCH_MARKER)
  const metalDone = js.includes(METAL_MARKER)
  const modelDone = model.includes(CTX_PARAMS_MARKER)
  if (gypDone && jsDone && metalDone && modelDone) return 'already-patched'

  if (!modelDone) {
    expectOnce(model, PARAMS_FIND, 'model.cc context params')
    fs.writeFileSync(modelPath, model.replace(PARAMS_FIND, PARAMS_REPLACE))
  }

  if (!jsDone || !metalDone) {
    if (!jsDone) expectOnce(js, LOADER_FIND, 'dist/index.js binary require')
    if (!metalDone) expectOnce(js, METAL_FIND, 'dist/index.js Metal path')
    let out = js
    if (!jsDone) out = out.replace(LOADER_FIND, LOADER_REPLACE)
    if (!metalDone) out = out.replace(METAL_FIND, METAL_REPLACE)
    fs.writeFileSync(jsPath, out)
  }

  if (!gypDone) {
    const start = gyp.indexOf('    {\n      "target_name": "smart-whisper",')
    expectOnce(gyp, '"target_name": "smart-whisper",', 'binding.gyp target_name')
    expectOnce(gyp, GYP_FIND, 'binding.gyp end of targets')
    expectOnce(gyp, "      'cflags_cc!': [ '-fno-exceptions' ],\n", 'binding.gyp cflags_cc!')
    if (start < 0) fail('binding.gyp target block', 'not found')
    const end = gyp.indexOf(GYP_FIND)
    // The baseline target, copied verbatim so both binaries compile the same sources and defines.
    const target = gyp.slice(start, end + '    }'.length)
    const variant = target
      .replace('"target_name": "smart-whisper",', `"target_name": "${VARIANT_TARGET}",`)
      .replace(
        "      'cflags_cc!': [ '-fno-exceptions' ],\n",
        "      'cflags_cc!': [ '-fno-exceptions' ],\n" +
          `      'cflags': [ ${SIMD_FLAGS.map((f) => `'${f}'`).join(', ')} ],\n`
      )
      .replace(/^/gm, '    ')
    const conditions =
      `  # ${PATCH_MARKER}: an AVX2 build beside the baseline; the loader picks per CPU.\n` +
      `  'conditions': [\n` +
      `    ['OS=="linux" and target_arch=="x64"', {\n` +
      `      'targets': [\n${variant}\n      ],\n` +
      `    }],\n` +
      `  ],\n`
    fs.writeFileSync(gypPath, gyp.replace(GYP_FIND, `    }\n  ],\n${conditions}}`))
  }
  return 'patched'
}

/** Reads a file the patch needs; a missing one is an anchor failure, not a crash. */
function readOrFail(file, name) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') fail(name, 'not found')
    throw err
  }
}

function expectOnce(text, needle, name) {
  const n = text.split(needle).length - 1
  if (n !== 1) fail(name, `expected exactly 1 match, found ${n}`)
}

function fail(name, why) {
  throw new Error(
    `[patch-smart-whisper] anchor "${name}": ${why}. smart-whisper was probably upgraded — ` +
      're-derive the anchors in scripts/patch-smart-whisper.mjs (issue #1267).'
  )
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const dir = path.join(repoRoot, 'node_modules', 'smart-whisper')
  if (!fs.existsSync(dir)) {
    console.log('[patch-smart-whisper] smart-whisper not installed; nothing to patch.')
  } else {
    try {
      console.log(`[patch-smart-whisper] ${patchSmartWhisper(dir)}`)
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err))
      process.exit(1)
    }
  }
}
