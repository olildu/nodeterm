import { describe, it, expect } from 'vitest'
import { createChildProcessGoneLog, createHangTracker, formatRenderProcessGone } from './process-health-log'

describe('createChildProcessGoneLog', () => {
  it('logs a GPU crash at warn with type, reason, exitCode and a per-type session count', () => {
    const log = createChildProcessGoneLog()
    expect(log({ type: 'GPU', reason: 'crashed', exitCode: 11 })).toEqual({
      level: 'warn',
      msg: 'GPU process gone: reason=crashed exitCode=11 — #1 GPU this session'
    })
    expect(log({ type: 'GPU', reason: 'killed', exitCode: 9 }).msg).toContain('#2 GPU this session')
  })

  it('counts each process type on its own', () => {
    const log = createChildProcessGoneLog()
    log({ type: 'GPU', reason: 'crashed', exitCode: 11 })
    expect(log({ type: 'Utility', reason: 'oom', exitCode: 0, name: 'Audio Service' }).msg).toBe(
      'Utility (Audio Service) process gone: reason=oom exitCode=0 — #1 Utility this session'
    )
  })

  it('treats a clean-exit as routine (info), every other reason as a real death (warn)', () => {
    const log = createChildProcessGoneLog()
    expect(log({ type: 'Utility', reason: 'clean-exit', exitCode: 0, serviceName: 'network.mojom.NetworkService' }).level).toBe('info')
    for (const reason of ['abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction']) {
      expect(log({ type: 'GPU', reason, exitCode: 1 }).level).toBe('warn')
    }
  })

  it('falls back to serviceName when name is absent, and to the bare type when both are', () => {
    const log = createChildProcessGoneLog()
    expect(log({ type: 'Utility', reason: 'crashed', exitCode: 1, serviceName: 'svc' }).msg).toMatch(/^Utility \(svc\) /)
    expect(log({ type: 'Zygote', reason: 'crashed', exitCode: 1 }).msg).toMatch(/^Zygote process gone/)
  })

  it('keeps its count per instance (no module-global state)', () => {
    createChildProcessGoneLog()({ type: 'GPU', reason: 'crashed', exitCode: 11 })
    expect(createChildProcessGoneLog()({ type: 'GPU', reason: 'crashed', exitCode: 11 }).msg).toContain('#1 GPU')
  })
})

describe('formatRenderProcessGone', () => {
  it('warns on a crash, informs on a deliberate teardown', () => {
    expect(formatRenderProcessGone({ reason: 'oom', exitCode: 0 })).toEqual({
      level: 'warn',
      msg: 'renderer process gone: reason=oom exitCode=0'
    })
    expect(formatRenderProcessGone({ reason: 'clean-exit', exitCode: 0 }).level).toBe('info')
  })
})

describe('createHangTracker', () => {
  it('pairs unresponsive → responsive into one hang with its duration', () => {
    const t = createHangTracker()
    expect(t.unresponsive(1000)).toEqual({ level: 'warn', msg: 'window unresponsive — hang #1 this session' })
    const back = t.responsive(4250)
    expect(back?.msg).toMatch(/^window responsive again after 3250 ms /)
    expect(back?.msg).toContain('hang #1')
  })

  it('a repeat unresponsive while hung keeps the FIRST timestamp and logs nothing', () => {
    const t = createHangTracker()
    t.unresponsive(1000)
    expect(t.unresponsive(2000)).toBeNull()
    expect(t.responsive(5000)?.msg).toContain('after 4000 ms')
  })

  it('a responsive with no open hang logs nothing (an unmeasured duration is not zero)', () => {
    const t = createHangTracker()
    expect(t.responsive(1000)).toBeNull()
    t.unresponsive(2000)
    t.responsive(3000)
    expect(t.responsive(4000)).toBeNull()
  })

  it('a renderer that died while hung closes the hang: its successor\'s hang is a new one', () => {
    const t = createHangTracker()
    t.unresponsive(1000)
    t.reset() // render-process-gone: the hung page is gone, and the reload is a fresh renderer
    // No 'responsive' will ever answer the dead page; one that arrives is not its duration.
    expect(t.responsive(9000)).toBeNull()
    // The new page hanging is logged, not swallowed as a repeat of the dead page's hang.
    expect(t.unresponsive(10_000)?.msg).toContain('hang #2')
    expect(t.responsive(12_000)?.msg).toContain('after 2000 ms')
  })

  it('numbers successive hangs, and never reports a negative duration on a clock step back', () => {
    const t = createHangTracker()
    t.unresponsive(1000)
    t.responsive(2000)
    expect(t.unresponsive(5000)?.msg).toContain('hang #2')
    expect(t.responsive(4000)?.msg).toContain('after 0 ms')
  })
})
