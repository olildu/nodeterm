import { open, readFile } from 'node:fs/promises'
import os from 'node:os'
import { whisperModel } from '../../shared/speech'
import type { WhisperModelStore } from './whisper-models'

export interface WhisperEngineHandle {
  transcribe(pcm: Float32Array, language: string): Promise<string>
  free(): Promise<void>
}

/** User-facing cause for a failed smart-whisper import. Pure — tested. */
export function describeWhisperLoadError(err: unknown): string {
  const code = (err as { code?: string })?.code
  const msg = err instanceof Error ? err.message : String(err)
  if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND')
    return 'the smart-whisper module is not installed — run npm install'
  if (/NODE_MODULE_VERSION|was compiled against a different Node\.js version/.test(msg))
    return 'the native module was built for a different runtime — run npm run rebuild'
  return msg
}

/** ggml weights start with GGML_FILE_MAGIC (0x67676d6c, written little-endian, so "lmgg" on
 * disk). Pure — tested. */
export function isGgmlModelHeader(header: Uint8Array): boolean {
  return (
    header.length >= 4 &&
    header[0] === 0x6c && header[1] === 0x6d && header[2] === 0x67 && header[3] === 0x67
  )
}

/** CPU features the SIMD build of whisper.cpp is compiled for (`-mavx -mavx2 -mfma -mf16c`, see
 * scripts/patch-smart-whisper.mjs). Every one must be present, or that binary SIGILLs the app. */
export const WHISPER_SIMD_FLAGS = ['avx', 'avx2', 'fma', 'f16c'] as const

/** The `flags` line of /proc/cpuinfo as a set. Pure — tested. */
export function parseCpuFlags(cpuinfo: string): Set<string> {
  const line = cpuinfo.split('\n').find((l) => /^flags\s*:/.test(l))
  return new Set(line ? line.slice(line.indexOf(':') + 1).trim().split(/\s+/) : [])
}

/** Which smart-whisper binary to load (issue #1267). The SIMD build exists only on linux x64; on a
 * CPU without its flags — or when the flags could not be read — the baseline is the only safe
 * answer, since a wrong guess is a SIGILL, not an error. Pure — tested. */
export function pickWhisperBinary(input: {
  platform: string
  arch: string
  cpuFlags: ReadonlySet<string> | null
}): 'smart-whisper' | 'smart-whisper-avx2' {
  if (input.platform !== 'linux' || input.arch !== 'x64' || !input.cpuFlags) return 'smart-whisper'
  return WHISPER_SIMD_FLAGS.every((f) => input.cpuFlags!.has(f)) ? 'smart-whisper-avx2' : 'smart-whisper'
}

/** whisper.cpp threads for a machine with `available` logical CPUs. whisper.cpp's own default is
 * min(4, cpus), which leaves most of a modern laptop idle. Using EVERY logical CPU is worse than
 * the default, though: ggml's workers spin-wait, so one oversubscribed or hyperthread-paired worker
 * stalls the whole graph (measured, 12 logical CPUs under load, base model: 4 threads 1.9 s,
 * 8 threads 1.4 s, 12 threads 12.8 s). So: about half plus two, never below whisper's own 4 when
 * the machine has them, capped at 8 where the gain flattens. Pure — tested. */
export function whisperThreads(available: number): number {
  const n = Math.max(1, Math.floor(available) || 1)
  if (n <= 4) return n
  return Math.min(8, Math.max(4, Math.ceil(n / 2) + 2))
}

/** Local dictation via whisper.cpp (smart-whisper). One loaded model at a
 * time (they are hundreds of MB of RAM); same-model loads dedupe onto one
 * in-flight promise; transcriptions run FIFO on a promise chain. The Pro
 * rule (non-tiny needs premium) is validated HERE, not only in the UI, so a
 * bypassed renderer lock still can't use a paid model. */
export class SpeechService {
  private readonly models: WhisperModelStore
  private readonly isPremium: () => boolean
  private readonly engineFactory: (modelPath: string) => Promise<WhisperEngineHandle>
  private loaded: { path: string; engine: Promise<WhisperEngineHandle> } | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(opts: {
    models: WhisperModelStore
    isPremium: () => boolean
    engineFactory?: (modelPath: string) => Promise<WhisperEngineHandle>
  }) {
    this.models = opts.models
    this.isPremium = opts.isPremium
    this.engineFactory = opts.engineFactory ?? defaultEngineFactory
  }

  transcribe(pcm: Float32Array, opts: { model: string; language: string }): Promise<string> {
    // After shutdown, loading a fresh 500MB model is not just wasteful — it re-opens the
    // quit-time crash window (see shutdown), and a late dictation IPC can arrive while the
    // quit flush is still running.
    if (this.closed) return Promise.reject(new Error('Speech is shutting down.'))
    const run = this.queue.then(() => this.transcribeNow(pcm, opts))
    // FIFO: the next caller waits for this one, success or failure.
    this.queue = run.catch(() => {})
    return run
  }

  /** Releases the loaded model and stops accepting work — call this on app quit.
   *
   * The ordering is the whole point. smart-whisper runs a transcription on a libuv
   * worker with a ThreadSafeFunction posting segments back to JS; if the main process's
   * node env is torn down while one is in flight, the TSFN callback is dispatched into a
   * dying env, its `Napi::Error` escapes as a C++ exception and std::terminate()s the WHOLE
   * app (SIGABRT, Napi::ThreadSafeFunction::CallJS in the crash report). Quitting with a
   * merely *loaded* engine is fine — it is the in-flight transcribe that kills us. So the
   * free is queued behind the same FIFO as transcriptions and awaited before quit proceeds.
   *
   * `timeoutMs` caps that wait: a wedged whisper must never hold the quit open forever.
   * Bailing on the timeout means quitting into the crash window again, which is strictly
   * no worse than today and much rarer than the common sub-second case. Never rejects. */
  async shutdown(timeoutMs = 5_000): Promise<void> {
    this.closed = true
    const drained = this.queue.then(async () => {
      const loaded = this.loaded
      this.loaded = null
      if (loaded) await loaded.engine.then((e) => e.free())
    })
    this.queue = drained.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      drained.catch(() => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) }),
    ])
    if (timer) clearTimeout(timer) // a live timer would itself delay the quit it is guarding
  }

  private async transcribeNow(pcm: Float32Array, opts: { model: string; language: string }): Promise<string> {
    const info = whisperModel(opts.model)
    if (!info) throw new Error(`Unknown whisper model: ${opts.model}`)
    if (info.pro && !this.isPremium()) {
      throw new Error(`The ${info.id} model requires nodeterm Pro — the tiny model is free.`)
    }
    if (!(await this.models.has(info.id))) {
      throw new Error(`Download the ${info.id} model in Settings → Speech first.`)
    }
    const path = this.models.modelPath(info.id)
    if (this.loaded && this.loaded.path !== path) {
      const old = this.loaded
      this.loaded = null
      await old.engine.then((e) => e.free()).catch(() => {})
    }
    if (!this.loaded) {
      const engine = this.engineFactory(path)
      this.loaded = { path, engine }
      engine.catch(() => { if (this.loaded?.engine === engine) this.loaded = null })
    }
    const engine = await this.loaded.engine
    const text = (await engine.transcribe(pcm, opts.language)).trim()
    if (!text) throw new Error('No speech detected.')
    return text
  }
}

let loggedBinary = false

/** Linux only — the one platform with a SIMD variant. null = unknown, which picks the baseline. */
async function readCpuFlags(): Promise<Set<string> | null> {
  if (process.platform !== 'linux') return null
  try {
    return parseCpuFlags(await readFile('/proc/cpuinfo', 'utf8'))
  } catch {
    return null
  }
}

async function defaultEngineFactory(modelPath: string): Promise<WhisperEngineHandle> {
  let mod: any
  try {
    // Read by the patched smart-whisper loader (scripts/patch-smart-whisper.mjs) at its first
    // import; later imports are cached, so setting it again is harmless.
    const g = globalThis as { __NODETERM_WHISPER_BINARY__?: string; __NODETERM_WHISPER_LOADED__?: string }
    g.__NODETERM_WHISPER_BINARY__ ??= pickWhisperBinary({
      platform: process.platform,
      arch: process.arch,
      cpuFlags: await readCpuFlags(),
    })
    // @ts-ignore -- optional native dep: absent until installed, and @ts-ignore stays valid either way (an expect-error would break the build the moment it resolves)
    mod = await import('smart-whisper')
    if (!loggedBinary) {
      loggedBinary = true
      console.info(
        `[speech] whisper binary: ${g.__NODETERM_WHISPER_LOADED__ ?? 'smart-whisper (unpatched)'}` +
          ` (wanted ${g.__NODETERM_WHISPER_BINARY__})`,
      )
    }
  } catch (err) {
    console.error('[speech] smart-whisper failed to load:', err)
    throw new Error(
      `Local whisper is unavailable (${describeWhisperLoadError(err)}). Try the Cloud engine.`,
    )
  }
  // whisper.cpp's loader logs timings through the context it just failed to build
  // (LoadModelWorker::Execute → whisper_print_timings(nullptr)), so a model file it rejects
  // SIGSEGVs the entire process instead of rejecting a promise. Screen the header before the
  // native side ever sees the path: a truncated download or an error page saved as .bin is the
  // realistic corruption, and this turns it into a message. (A file with a valid magic but a
  // corrupt body still reaches the null deref — that one needs an upstream fix.)
  const header = new Uint8Array(4)
  const fh = await open(modelPath, 'r')
  try {
    await fh.read(header, 0, 4, 0)
  } finally {
    await fh.close()
  }
  if (!isGgmlModelHeader(header)) {
    throw new Error(
      `The whisper model file at ${modelPath} is not a valid ggml model (corrupt or incomplete download). Delete and re-download it in Settings → Speech.`,
    )
  }
  const whisper = new mod.Whisper(modelPath, { gpu: true })
  const nThreads = whisperThreads(os.availableParallelism?.() ?? os.cpus().length)
  return {
    async transcribe(pcm, language) {
      const task = await whisper.transcribe(pcm, {
        language: language === 'auto' ? 'auto' : language,
        n_threads: nThreads,
      })
      const result = await task.result
      return (Array.isArray(result) ? result.map((r: any) => r.text).join(' ') : String(result ?? '')).trim()
    },
    async free() {
      await whisper.free()
    },
  }
}
