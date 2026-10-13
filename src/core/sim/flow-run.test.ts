import { describe, expect, it } from 'vitest'
import type { FlowStep } from './flow'
import { classifyFailure, renderRunSummary, runFlow, type StepOutcome } from './flow-run'

const steps = (n: number): FlowStep[] =>
  Array.from({ length: n }, (_, i) => ({ index: i + 1, op: 'sim' as const, display: `tap "S${i + 1}"`, origin: `f.yaml step ${i + 1}` }))

function harness(outcomes: Record<number, StepOutcome | (() => StepOutcome)> = {}, stepMs = 1000) {
  const clock = { t: 0 }
  const ran: number[] = []
  return {
    ran,
    clock,
    run: (over: { n?: number; fromStep?: number; total?: number; secret?: string } = {}) =>
      runFlow({
        name: 'f',
        steps: steps(over.n ?? 4),
        fromStep: over.fromStep ?? 1,
        totalTimeoutMs: over.total ?? 60_000,
        now: () => clock.t,
        mask: (t) => (over.secret ? t.split(over.secret).join('***') : t),
        exec: async (step) => {
          ran.push(step.index)
          clock.t += stepMs
          const o = outcomes[step.index]
          return typeof o === 'function' ? o() : (o ?? { ok: true })
        }
      })
  }
}

describe('runFlow', () => {
  it('runs every step in order and counts them', async () => {
    const h = harness()
    const r = await h.run()
    expect(h.ran).toEqual([1, 2, 3, 4])
    expect(r).toMatchObject({ total: 4, passed: 4, failed: null, elapsedMs: 4000 })
    expect(renderRunSummary(r)).toMatch(/passed 4\/4 in 4\.0 s$/)
    expect(renderRunSummary(r)).toMatch(/1\. ok +1\.0 s +tap "S1"/)
  })

  it('stops at the first failure and runs nothing after it', async () => {
    const h = harness({ 2: { ok: false, kind: 'ambiguous', reason: '2 elements match' } })
    const r = await h.run()
    expect(h.ran).toEqual([1, 2])
    expect(r.passed).toBe(1)
    expect(r.failed).toMatchObject({ index: 2, status: 'failed', kind: 'ambiguous', reason: '2 elements match' })
    expect(renderRunSummary(r)).toMatch(/2\. FAIL .*tap "S2"\nFAILED 1\/4 in 2\.0 s/)
  })

  it('--from-step skips earlier steps without running them', async () => {
    const h = harness()
    const r = await h.run({ fromStep: 3 })
    expect(h.ran).toEqual([3, 4])
    expect(r.steps.map((s) => s.status)).toEqual(['skipped', 'skipped', 'ok', 'ok'])
    expect(renderRunSummary(r)).toMatch(/passed 4\/4 .*\(resumed from step 3; 2 run\)/)
  })

  it('fails the step that cannot start once the total budget is spent', async () => {
    const h = harness({}, 2000)
    const r = await h.run({ total: 3000 })
    expect(h.ran).toEqual([1, 2])
    expect(r.failed).toMatchObject({ index: 3, kind: 'timeout', reason: expect.stringMatching(/ran out of time \(3 s total/) })
  })

  it('a throwing step is a failure, not a crash', async () => {
    const h = harness({
      1: () => {
        throw new Error('boom')
      }
    })
    const r = await h.run()
    expect(r.failed).toMatchObject({ index: 1, reason: 'the step threw: boom' })
  })

  it('masks secrets in notes and reasons', async () => {
    const h = harness({ 1: { ok: false, kind: 'other', reason: 'saw hunter2 on screen' } })
    const r = await h.run({ secret: 'hunter2' })
    expect(r.failed?.reason).toBe('saw *** on screen')
  })
})

describe('classifyFailure', () => {
  it('reads the verb\'s own codes', () => {
    expect(classifyFailure('sim-tap-label-ambiguous: 2 elements match')).toBe('ambiguous')
    expect(classifyFailure('sim-tap-label-none: no element has the label "x"')).toBe('no-match')
    expect(classifyFailure('sim-wait-for-none: "x" did not appear')).toBe('no-match')
    expect(classifyFailure('sim-timeout: x')).toBe('timeout')
    expect(classifyFailure('sim-not-running: gone')).toBe('device')
    expect(classifyFailure('whatever')).toBe('other')
  })
})
