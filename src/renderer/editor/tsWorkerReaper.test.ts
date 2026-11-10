import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTsWorkerReaper, TS_WORKER_STOP_GRACE_MS, type TsWorkerLanguage } from './tsWorkerReaper'

// The reaper's decision, driven the way monaco-setup.ts drives it: `live` stands in for
// `editor.getModels()`, and — like Monaco's `onWillDisposeModel` — a model is still in `live`
// when `modelLeft` fires and only removed after.
describe('tsWorkerReaper (stop the TS/JS worker once no TS/JS model remains)', () => {
  let live: string[]
  let stopped: TsWorkerLanguage[]
  let reaper: ReturnType<typeof createTsWorkerReaper>

  const open = (language: string): void => {
    live.push(language)
    reaper.modelEntered(language)
  }
  const close = (language: string): void => {
    reaper.modelLeft(language) // fires before the model leaves getModels()
    live.splice(live.indexOf(language), 1)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    live = []
    stopped = []
    reaper = createTsWorkerReaper({ liveLanguageIds: () => live, stopWorker: (l) => stopped.push(l) })
  })
  afterEach(() => {
    reaper.dispose()
    vi.useRealTimers()
  })

  it('stops the TS worker after the grace period once the last TS model is disposed', () => {
    open('typescript')
    close('typescript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS - 1)
    expect(stopped).toEqual([])
    vi.advanceTimersByTime(1)
    expect(stopped).toEqual(['typescript'])
  })

  it('does not stop while another model of the language is live (DiffNode: one of two models gone)', () => {
    open('typescript')
    open('typescript')
    close('typescript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    expect(stopped).toEqual([])
  })

  it('does not stop when a TS file is reopened inside the grace window (switching files)', () => {
    open('typescript')
    close('typescript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS / 2)
    open('typescript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    expect(stopped).toEqual([])
  })

  it('treats TS and JS separately: JS keeps its worker while a JS model is live', () => {
    open('typescript')
    open('javascript')
    close('typescript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    expect(stopped).toEqual(['typescript'])
    close('javascript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    expect(stopped).toEqual(['typescript', 'javascript'])
  })

  it('stops both when both go, with one timer for repeated leaves (one stop each, not N)', () => {
    open('typescript')
    open('typescript')
    open('javascript')
    close('typescript')
    close('javascript')
    close('typescript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    expect(stopped.sort()).toEqual(['javascript', 'typescript'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts a language change away from TS as leaving', () => {
    open('typescript')
    reaper.modelLeft('typescript')
    live[0] = 'markdown'
    reaper.modelEntered('markdown')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    expect(stopped).toEqual(['typescript'])
  })

  it('never kicks a language that has no worker: other languages, or TS already stopped', () => {
    open('json')
    close('json')
    expect(vi.getTimerCount()).toBe(0)
    open('typescript')
    close('typescript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    expect(stopped).toEqual(['typescript'])
    // Already stopped and nothing reopened: a stray leave event must not stop it again.
    reaper.modelLeft('typescript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    expect(stopped).toEqual(['typescript'])
  })

  it('re-arms after a stop: a TS file opened later is reaped again when it closes', () => {
    open('typescript')
    close('typescript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    open('typescript')
    close('typescript')
    vi.advanceTimersByTime(TS_WORKER_STOP_GRACE_MS)
    expect(stopped).toEqual(['typescript', 'typescript'])
  })
})
