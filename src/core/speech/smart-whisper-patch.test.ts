import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import {
  CTX_PARAMS_MARKER,
  METAL_MARKER,
  PATCH_MARKER,
  SIMD_FLAGS,
  VARIANT_TARGET,
  patchSmartWhisper
} from '../../../scripts/patch-smart-whisper.mjs'
import { WHISPER_SIMD_FLAGS } from './speech-service'
import { testTmpDir } from '../test-tmp'

/**
 * scripts/patch-smart-whisper.mjs builds an AVX2 variant of whisper.cpp beside the baseline on
 * linux x64 and lets the loader pick per CPU (issue #1267). These tests run the patch over a pristine
 * fixture of the package and the patched loader against fake binaries; the first test asserts the
 * installed sources carry the patch, so an install that skipped it fails loudly.
 */
const PKG = path.resolve(__dirname, '../../../node_modules/smart-whisper')
const installed = fs.existsSync(path.join(PKG, 'binding.gyp'))
/** Pristine smart-whisper 0.8.1 binding.gyp, src/binding/model.cc, and its dist/index.js (dist-index.js). */
const FIXTURE = path.resolve(__dirname, '__fixtures__/smart-whisper-0.8.1')

function copyPackage(dir = testTmpDir('sw-patch-')): string {
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.copyFileSync(path.join(FIXTURE, 'binding.gyp'), path.join(dir, 'binding.gyp'))
  // Stored flat: the repo's .gitignore drops every dist/ directory.
  fs.copyFileSync(path.join(FIXTURE, 'dist-index.js'), path.join(dir, 'dist', 'index.js'))
  fs.mkdirSync(path.join(dir, 'src', 'binding'), { recursive: true })
  fs.copyFileSync(path.join(FIXTURE, 'model.cc'), path.join(dir, 'src', 'binding', 'model.cc'))
  return dir
}

describe('patch-smart-whisper', () => {
  it.skipIf(!installed)('is applied to the installed smart-whisper', () => {
    const howto = 'node_modules is unpatched — run `npm run rebuild`.'
    expect(fs.readFileSync(path.join(PKG, 'binding.gyp'), 'utf8'), howto).toContain(PATCH_MARKER)
    expect(fs.readFileSync(path.join(PKG, 'dist', 'index.js'), 'utf8'), howto).toContain(PATCH_MARKER)
    expect(fs.readFileSync(path.join(PKG, 'dist', 'index.js'), 'utf8'), howto).toContain(METAL_MARKER)
    expect(fs.readFileSync(path.join(PKG, 'src', 'binding', 'model.cc'), 'utf8'), howto).toContain(CTX_PARAMS_MARKER)
  })

  it('starts the model context params from whisper.cpp defaults and is idempotent', () => {
    // The pristine declaration leaves every field but use_gpu as stack garbage (DTW among them).
    const dir = copyPackage()
    const modelPath = path.join(dir, 'src', 'binding', 'model.cc')
    expect(fs.readFileSync(modelPath, 'utf8')).toMatch(/^\s*whisper_context_params params;$/m)
    expect(patchSmartWhisper(dir)).toBe('patched')
    const model = fs.readFileSync(modelPath, 'utf8')
    expect(model).toContain('whisper_context_params params = whisper_context_default_params();')
    expect(model).not.toMatch(/^\s*whisper_context_params params;$/m)
    expect(model).toContain('params.use_gpu = info.Length() == 2')
    expect(patchSmartWhisper(dir)).toBe('already-patched')
    expect(fs.readFileSync(modelPath, 'utf8')).toBe(model)
  })

  it('refuses a model.cc whose params declaration moved', () => {
    const dir = copyPackage()
    fs.writeFileSync(path.join(dir, 'src', 'binding', 'model.cc'), '// rewritten upstream\n')
    expect(() => patchSmartWhisper(dir)).toThrow(/anchor "model.cc context params"/)
  })

  it('builds for exactly the CPU flags the runtime checks', () => {
    // A flag compiled in but not checked at load time is a SIGILL on the CPU that lacks it.
    expect(SIMD_FLAGS.map((f: string) => f.replace(/^-m/, '')).sort()).toEqual([...WHISPER_SIMD_FLAGS].sort())
  })

  it('adds a linux-x64-only variant target and is idempotent', () => {
    const dir = copyPackage()
    const pristine = fs.readFileSync(path.join(dir, 'binding.gyp'), 'utf8')
    expect(patchSmartWhisper(dir)).toBe('patched')
    const gyp = fs.readFileSync(path.join(dir, 'binding.gyp'), 'utf8')
    expect(gyp.startsWith(pristine.slice(0, pristine.lastIndexOf('  ],\n}')))).toBe(true)
    expect(gyp).toContain(`['OS=="linux" and target_arch=="x64"', {`)
    expect(gyp).toContain(`"target_name": "${VARIANT_TARGET}",`)
    expect(gyp).toContain("'cflags': [ '-mavx', '-mavx2', '-mfma', '-mf16c' ],")
    expect(patchSmartWhisper(dir)).toBe('already-patched')
    expect(fs.readFileSync(path.join(dir, 'binding.gyp'), 'utf8')).toBe(gyp)
  })

  it('refuses an anchor it cannot find instead of writing a half-patched package', () => {
    const dir = testTmpDir('sw-patch-bad-')
    fs.mkdirSync(path.join(dir, 'dist'))
    fs.writeFileSync(path.join(dir, 'binding.gyp'), '{}')
    fs.writeFileSync(path.join(dir, 'dist', 'index.js'), 'module.exports = {}')
    expect(() => patchSmartWhisper(dir)).toThrow(/anchor/)
  })

  it('refuses a dist/index.js whose Metal path line moved', () => {
    const dir = copyPackage()
    const js = path.join(dir, 'dist', 'index.js')
    fs.writeFileSync(js, fs.readFileSync(js, 'utf8').replace(/^process\.env\.GGML_METAL.*\n/m, ''))
    expect(() => patchSmartWhisper(dir)).toThrow(/Metal/)
  })

  describe('Metal shader path', () => {
    const KEY = 'GGML_METAL_PATH_RESOURCES'

    /** Loads a patched package from `pkgDir` and returns the shader dir it hands whisper.cpp. */
    function metalPath(pkgDir: string, preset?: string): string | undefined {
      copyPackage(pkgDir)
      patchSmartWhisper(pkgDir)
      const rel = path.join(pkgDir, 'build', 'Release')
      fs.mkdirSync(rel, { recursive: true })
      fs.writeFileSync(path.join(rel, 'smart-whisper.js'), 'module.exports = {}')
      const saved = process.env[KEY]
      if (preset === undefined) delete process.env[KEY]
      else process.env[KEY] = preset
      try {
        createRequire(path.join(pkgDir, 'dist', 'index.js'))('./index.js')
        return process.env[KEY]
      } finally {
        if (saved === undefined) delete process.env[KEY]
        else process.env[KEY] = saved
      }
    }

    it('points a packaged app at the unpacked copy, which native code can read', () => {
      // Inside app.asar the path is "Not a directory" to Metal, so whisper.cpp ran on the CPU.
      const res = path.join(testTmpDir('sw-metal-'), 'Resources')
      const pkg = path.join(res, 'app.asar', 'node_modules', 'smart-whisper')
      expect(metalPath(pkg)).toBe(path.join(res, 'app.asar.unpacked', 'node_modules', 'smart-whisper', 'whisper.cpp', 'ggml', 'src'))
    })

    it('leaves a dev install, an unpacked path and an explicit setting alone', () => {
      const dev = path.join(testTmpDir('sw-metal-dev-'), 'node_modules', 'smart-whisper')
      expect(metalPath(dev)).toBe(path.join(dev, 'whisper.cpp', 'ggml', 'src'))
      const unpacked = path.join(testTmpDir('sw-metal-unp-'), 'app.asar.unpacked', 'node_modules', 'smart-whisper')
      expect(metalPath(unpacked)).toBe(path.join(unpacked, 'whisper.cpp', 'ggml', 'src'))
      const asar = path.join(testTmpDir('sw-metal-set-'), 'app.asar', 'node_modules', 'smart-whisper')
      expect(metalPath(asar, '/custom/metal')).toBe('/custom/metal')
    })
  })

  describe('patched loader', () => {
    type G = { __NODETERM_WHISPER_BINARY__?: string; __NODETERM_WHISPER_LOADED__?: string }
    const g = globalThis as G

    /** A patched package whose "binaries" are JS stubs (require resolves .js before .node). */
    function fakePackage(variant: 'ok' | 'broken' | 'absent'): string {
      const dir = copyPackage()
      patchSmartWhisper(dir)
      const rel = path.join(dir, 'build', 'Release')
      fs.mkdirSync(rel, { recursive: true })
      fs.writeFileSync(path.join(rel, 'smart-whisper.js'), 'module.exports = { WhisperModel: class { which = "base" } }')
      if (variant !== 'absent') fs.writeFileSync(path.join(rel, `${VARIANT_TARGET}.node`), 'not a binary')
      if (variant === 'ok')
        fs.writeFileSync(path.join(rel, `${VARIANT_TARGET}.js`), 'module.exports = { WhisperModel: class { which = "avx2" } }')
      return dir
    }

    function load(dir: string, want: string | undefined): string | undefined {
      delete g.__NODETERM_WHISPER_LOADED__
      g.__NODETERM_WHISPER_BINARY__ = want
      try {
        const mod = createRequire(path.join(dir, 'dist', 'index.js'))('./index.js')
        return new mod.binding.WhisperModel().which
      } finally {
        delete g.__NODETERM_WHISPER_BINARY__
      }
    }

    it('loads the requested variant', () => {
      expect(load(fakePackage('ok'), VARIANT_TARGET)).toBe('avx2')
      expect(g.__NODETERM_WHISPER_LOADED__).toBe(VARIANT_TARGET)
    })

    it('falls back to the baseline when the variant is absent or fails to load', () => {
      expect(load(fakePackage('absent'), VARIANT_TARGET)).toBe('base')
      expect(load(fakePackage('broken'), VARIANT_TARGET)).toBe('base')
      expect(g.__NODETERM_WHISPER_LOADED__).toBe('smart-whisper')
    })

    it('ignores a missing or malformed request', () => {
      expect(load(fakePackage('ok'), undefined)).toBe('base')
      expect(load(fakePackage('ok'), '../../evil')).toBe('base')
    })
  })
})
