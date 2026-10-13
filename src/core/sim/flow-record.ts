/**
 * `sim --record <name>` / `--record-stop`: turn what an agent just worked out into a flow file.
 *
 * A recording is a bounded list of the label-based actions that SUCCEEDED on one device, in order.
 * Pure: `recordStep` takes the parsed action, `renderRecording` writes the YAML that `loadFlow`
 * reads back (the round trip is a test). What it deliberately does not do:
 *
 *   - record reads (describe, screenshot, point, wait-idle) — a replay needs inputs and waits;
 *   - record a failed action — the flow should hold what worked;
 *   - invent assertions — it records what the agent DID; the agent adds `assert-visible` by hand.
 *
 * Typed text is the sharp edge: a flow file is committed. A `--type-label` into a field whose name
 * looks like a secret (password, pin, token…) is written as `${PASSWORD}` and the header says to pass
 * `--var PASSWORD=…`, never the value; any other typed text is written literally, and the header
 * tells the author to read it before committing.
 */
import { FLOW_NAME_RE, FLOW_VAR_NAME_RE } from './flow'
import type { SimAction } from './verb'
import { SIM_WAIT_FOR_DEFAULT_MS } from './verb'
import { FLOW_WAIT_FOR_MS_DEFAULT } from './flow'

export const RECORD_STEPS_MAX = 200
export const RECORD_MAX_AGE_MS = 2 * 60 * 60 * 1000

const SENSITIVE_FIELD_RE = /pass(word|code|phrase)?|\bpin\b|secret|token|\botp\b|cvv|card number|api key|ssn/i

export interface RecStep {
  /** The YAML after `- `, without the leading dash. */
  yaml: string
  /** A trailing `# …` comment (coordinate taps get a TODO). */
  note?: string
}

export interface Recording {
  name: string
  udid: string
  startedAt: number
  steps: RecStep[]
  /** Variables the recorded steps refer to. */
  vars: Set<string>
  /** Steps past the cap that were not kept. */
  dropped: number
}

export function validRecordingName(name: string): boolean {
  return FLOW_NAME_RE.test(name)
}

export function startRecording(name: string, udid: string, now: number): Recording {
  return { name, udid, startedAt: now, steps: [], vars: new Set(), dropped: 0 }
}

/** `"…"` for YAML, with `${` doubled so literal text can never read back as a variable. */
const ys = (s: string): string => JSON.stringify(s.replace(/\$\{/g, () => '$${'))

function varNameFor(label: string): string | null {
  const v = label.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().replace(/^(\d)/, '_$1')
  return FLOW_VAR_NAME_RE.test(v) ? v : null
}

function stepFor(action: SimAction, rec: Recording): RecStep | null {
  switch (action.kind) {
    case 'tap-label':
    case 'tap-id': {
      const isId = action.kind === 'tap-id'
      const text = isId ? action.id : action.label
      const extra: string[] = []
      if (action.index !== null) extra.push(`index: ${action.index}`)
      if (action.waitForMs !== SIM_WAIT_FOR_DEFAULT_MS) extra.push(`timeout: ${action.waitForMs}`)
      if (!isId && extra.length === 0) return { yaml: `tap: ${ys(text)}` }
      return { yaml: `tap: { ${isId ? 'id' : 'label'}: ${ys(text)}${extra.length ? `, ${extra.join(', ')}` : ''} }` }
    }
    case 'tap':
      return { yaml: `tap: { at: [${Math.round(action.x)}, ${Math.round(action.y)}] }`, note: 'TODO: use a label' }
    case 'type-label': {
      let text = ys(action.text)
      let note: string | undefined
      if (SENSITIVE_FIELD_RE.test(action.label)) {
        const name = varNameFor(action.label)
        if (name) {
          rec.vars.add(name)
          text = '"${' + name + '}"'
          note = `value not recorded — run with --var ${name}=<value>`
        }
      }
      const extra: string[] = []
      if (action.index !== null) extra.push(`index: ${action.index}`)
      if (action.waitForMs !== SIM_WAIT_FOR_DEFAULT_MS) extra.push(`timeout: ${action.waitForMs}`)
      return { yaml: `type: { into: ${ys(action.label)}, text: ${text}${extra.length ? `, ${extra.join(', ')}` : ''} }`, ...(note ? { note } : {}) }
    }
    case 'type':
      return { yaml: `type: ${ys(action.text)}`, note: 'typed into whatever had focus; prefer type: { into: "<field label>", text: … }' }
    case 'swipe':
      return {
        yaml: `swipe: { from: [${Math.round(action.x1)}, ${Math.round(action.y1)}], to: [${Math.round(action.x2)}, ${Math.round(action.y2)}]${action.ms !== 300 ? `, ms: ${action.ms}` : ''} }`
      }
    case 'press':
      return { yaml: `press: ${action.button}` }
    case 'key':
      return { yaml: action.mods.length ? `key: { key: ${ys(action.name)}, mods: [${action.mods.join(', ')}] }` : `key: ${ys(action.name)}` }
    case 'wait-for':
      return action.waitForMs === FLOW_WAIT_FOR_MS_DEFAULT
        ? { yaml: `wait-for: ${ys(action.label)}` }
        : { yaml: `wait-for: { label: ${ys(action.label)}, timeout: ${action.waitForMs} }` }
    default:
      return null
  }
}

/** Add the action to the recording if it is one a flow replays. Returns whether it was kept. */
export function recordStep(rec: Recording, action: SimAction): boolean {
  const s = stepFor(action, rec)
  if (!s) return false
  if (rec.steps.length >= RECORD_STEPS_MAX) {
    rec.dropped++
    return false
  }
  rec.steps.push(s)
  return true
}

export function renderRecording(rec: Recording): string {
  const lines = [
    `# Recorded by nodeterm \`sim --record\`. Replay: sim --run <this file>${rec.vars.size ? ' ' + [...rec.vars].map((v) => `--var ${v}=<value>`).join(' ') : ''}`,
    '# Review typed text before committing — it is written as typed. Add assert-visible steps for what must hold.',
    `name: ${rec.name}`,
    `device: ${rec.udid}`,
    'steps:'
  ]
  for (const s of rec.steps) lines.push(`  - ${s.yaml}${s.note ? `   # ${s.note}` : ''}`)
  if (rec.dropped > 0) lines.push(`  # … ${rec.dropped} more step${rec.dropped === 1 ? '' : 's'} not recorded (limit ${RECORD_STEPS_MAX})`)
  return lines.join('\n') + '\n'
}
