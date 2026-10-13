/**
 * The flow step engine: run a list of already-validated steps in order, stop at the first failure,
 * time each one, and shape the report. It knows nothing about devices — `exec` is injected (control.ts
 * runs a step on the leased device; the tests run it against a fake) — so the rules that matter live
 * here, testable without one:
 *
 *   - steps before `--from-step` are SKIPPED, not run (the agent fixed step N and resumes at N);
 *   - the TOTAL time budget is checked before each step, and an overrun is a failure of the step that
 *     could not start, not a silent truncation;
 *   - the first failing step ends the run: later steps assume the failed one worked;
 *   - every line that leaves this module goes through `mask`, so a secret variable's value never
 *     appears in a summary, a failure or the JSON.
 */
import type { FlowStep } from './flow'

export type StepOutcome =
  | { ok: true; note?: string }
  | { ok: false; reason: string; kind: 'no-match' | 'ambiguous' | 'timeout' | 'assert' | 'device' | 'other' }

export interface StepResult {
  index: number
  display: string
  origin: string
  status: 'ok' | 'failed' | 'skipped'
  ms: number
  note?: string
  reason?: string
  kind?: string
}

export interface FlowRunResult {
  name: string
  total: number
  passed: number
  elapsedMs: number
  steps: StepResult[]
  failed: StepResult | null
  /** Where `--from-step` started this run (1 = from the top). */
  fromStep: number
}

export interface RunFlowInput {
  name: string
  steps: FlowStep[]
  fromStep: number
  totalTimeoutMs: number
  /** Run one step; `remainingMs` is what is left of the total budget. Must not throw for an ordinary failure. */
  exec(step: FlowStep, remainingMs: number): Promise<StepOutcome>
  now(): number
  mask(text: string): string
  /** Called after each step (the drive highlight, the log). */
  onStep?(result: StepResult): void
}

/** Failures worth a reply a model can act on, classified from the verb's own error codes. */
export function classifyFailure(error: string): Extract<StepOutcome, { ok: false }>['kind'] {
  if (/-ambiguous\b/.test(error) || /elements match the/.test(error)) return 'ambiguous'
  if (/-none\b|-unreachable\b|no element has the|not visible/.test(error)) return 'no-match'
  if (/timeout|timed out|still changing/i.test(error)) return 'timeout'
  if (/^sim-(device|not-running|helper|bad-request)/.test(error)) return 'device'
  return 'other'
}

export async function runFlow(input: RunFlowInput): Promise<FlowRunResult> {
  const t0 = input.now()
  const results: StepResult[] = []
  const total = input.steps.length
  let passed = 0
  let failed: StepResult | null = null
  for (const step of input.steps) {
    if (step.index < input.fromStep) {
      const r: StepResult = { index: step.index, display: step.display, origin: step.origin, status: 'skipped', ms: 0 }
      results.push(r)
      passed++ // a skipped step counts as passed: the agent says it already holds (resume contract)
      input.onStep?.(r)
      continue
    }
    const remaining = input.totalTimeoutMs - (input.now() - t0)
    const s0 = input.now()
    let out: StepOutcome
    if (remaining <= 0) {
      out = { ok: false, kind: 'timeout', reason: `the flow ran out of time (${Math.round(input.totalTimeoutMs / 1000)} s total; --timeout-ms raises it, up to the maximum)` }
    } else {
      try {
        out = await input.exec(step, remaining)
      } catch (e) {
        out = { ok: false, kind: 'other', reason: `the step threw: ${e instanceof Error ? e.message : String(e)}` }
      }
    }
    const ms = Math.max(0, input.now() - s0)
    if (out.ok) {
      const r: StepResult = { index: step.index, display: step.display, origin: step.origin, status: 'ok', ms, ...(out.note ? { note: input.mask(out.note) } : {}) }
      results.push(r)
      passed++
      input.onStep?.(r)
      continue
    }
    const r: StepResult = {
      index: step.index,
      display: step.display,
      origin: step.origin,
      status: 'failed',
      ms,
      reason: input.mask(out.reason),
      kind: out.kind
    }
    results.push(r)
    failed = r
    input.onStep?.(r)
    break
  }
  return { name: input.name, total, passed, elapsedMs: Math.max(0, input.now() - t0), steps: results, failed, fromStep: input.fromStep }
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

/** `  3. ok    1.2 s  wait-for "Home"` — one line per step. */
export function renderStepLine(r: StepResult, total: number): string {
  const w = String(total).length
  const n = String(r.index).padStart(w)
  if (r.status === 'skipped') return `  ${n}. skip         ${r.display}`
  return `  ${n}. ${r.status === 'ok' ? 'ok  ' : 'FAIL'}  ${secs(r.ms).padStart(7)}  ${r.display}`
}

export function renderRunSummary(run: FlowRunResult): string {
  const lines = run.steps.map((s) => renderStepLine(s, run.total))
  const ran = run.steps.filter((s) => s.status !== 'skipped').length
  lines.push(`${run.failed ? 'FAILED' : 'passed'} ${run.passed}/${run.total} in ${secs(run.elapsedMs)}${run.fromStep > 1 ? ` (resumed from step ${run.fromStep}; ${ran} run)` : ''}`)
  return lines.join('\n')
}
