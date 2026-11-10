// Stop Monaco's TypeScript / JavaScript worker once no model of that language is left.
//
// Why: in monaco-editor 0.57 the css/html/json WorkerManagers stop
// their worker after 2 min idle, but the TypeScript WorkerManager has NO idle path — it only stops
// when its defaults fire `onDidChange` (or on dispose), and it is created with `keepIdleModels`.
// So the first .ts/.tsx/.js file opened in an EditorNode or DiffNode starts a worker isolate holding
// the TS compiler (13.3 MB unminified script), lib.d.ts and a language service for the rest of the
// session; TS and JS have SEPARATE managers, so both can be pinned at once (order of 70-100 MB each,
// unmeasured). The supported way to stop one is a no-op `setCompilerOptions(getCompilerOptions())`:
// `onDidChange` -> `WorkerManager._stopWorker()`, and the next request lazily starts a fresh worker
// with the same options and extra libs (both live on the defaults, not the worker).
//
// The decision is kept Monaco-free so it is testable in node: monaco-setup.ts passes the real
// model list and the real stop; tests pass fakes and fake timers.

/** The languages whose worker Monaco never idles out. Each has its own WorkerManager. */
export const TS_WORKER_LANGUAGES = ['typescript', 'javascript'] as const
export type TsWorkerLanguage = (typeof TS_WORKER_LANGUAGES)[number]

/**
 * Grace period after the last TS/JS model leaves before the worker is stopped. Matches Monaco's
 * own `STOP_WHEN_IDLE_FOR` (2 min) for the css/html/json workers, so closing one .ts file and
 * opening another — or a project switch that remounts every editor — reuses the warm worker
 * instead of recompiling lib.d.ts. Every model event re-arms it, so it is one timer, not N.
 */
export const TS_WORKER_STOP_GRACE_MS = 2 * 60 * 1000

export interface TsWorkerReaperDeps {
  /** Language ids of every LIVE model (Monaco: `editor.getModels().map(m => m.getLanguageId())`). */
  liveLanguageIds(): readonly string[]
  /** Stop that language's worker (Monaco: the no-op `setCompilerOptions` kick). */
  stopWorker(language: TsWorkerLanguage): void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  graceMs?: number
}

export interface TsWorkerReaper {
  /** A model of `language` was created or changed TO `language`: a worker may now exist. */
  modelEntered(language: string): void
  /** A model of `language` is being disposed or changed AWAY from `language`. */
  modelLeft(language: string): void
  /** Cancel any pending check (tests / teardown). */
  dispose(): void
}

function isTsWorkerLanguage(language: string): language is TsWorkerLanguage {
  return (TS_WORKER_LANGUAGES as readonly string[]).includes(language)
}

export function createTsWorkerReaper(deps: TsWorkerReaperDeps): TsWorkerReaper {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const graceMs = deps.graceMs ?? TS_WORKER_STOP_GRACE_MS
  // Languages that have had a model since their worker was last stopped. Only these are kicked:
  // a no-op setCompilerOptions on a language that never started a worker is harmless, but it is
  // also pointless work (it re-runs that language's diagnostics pass over every model).
  const armed = new Set<TsWorkerLanguage>()
  let timer: unknown = null

  const check = (): void => {
    timer = null
    // Re-read the truth now rather than keeping a counter: `onWillDisposeModel` fires BEFORE the
    // model leaves `getModels()`, so a count taken at the event is off by one, and a file reopened
    // inside the grace window simply shows up here as a live model.
    const live = new Set(deps.liveLanguageIds())
    for (const language of [...armed]) {
      if (live.has(language)) continue
      armed.delete(language)
      deps.stopWorker(language)
    }
  }

  return {
    modelEntered(language) {
      if (isTsWorkerLanguage(language)) armed.add(language)
    },
    modelLeft(language) {
      if (!isTsWorkerLanguage(language) || !armed.has(language)) return
      if (timer !== null) clearTimer(timer)
      timer = setTimer(check, graceMs)
    },
    dispose() {
      if (timer !== null) clearTimer(timer)
      timer = null
    }
  }
}
