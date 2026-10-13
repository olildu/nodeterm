/**
 * Flows: a device test an agent worked out ONCE, saved as YAML, and replays with no model.
 *
 * This file is the PURE half — format, validation, variables, includes, masking. It reads no file
 * itself (the caller injects {@link FlowIO}), touches no device and runs nothing; `flow-run.ts` is
 * the step engine and `control.ts` wires both to a device lease.
 *
 * The format (Maestro-flavoured, one step per list item, the key names the step):
 *
 *   name: login
 *   device: android:nt_smoke_30          # optional; --udid on the command line wins
 *   steps:
 *     - tap: "Log in"                    # label; or { label, id, index, at: [x,y], timeout }
 *     - type: { into: "Email", text: "${EMAIL}" }     # or: type: "text for the focused field"
 *     - wait-for: "Home"                 # or { label|id, timeout }
 *     - assert-visible: "Welcome"
 *     - assert-not-visible: "Error"
 *     - swipe: { from: [200,600], to: [200,150] }     # optional ms
 *     - press: back                      # whatever `sim --press` supports
 *     - key: Enter
 *     - screenshot: after-login          # saved in the run folder
 *     - wait-idle: {}
 *     - run: other-flow.yaml             # include, relative to THIS file, cycle-guarded
 *
 * Every sim step is turned into the SAME `--flag` map the `sim` verb takes and validated by the
 * verb's own parser (`parseSimArgs`), so a flow cannot say anything the command line cannot, and
 * every limit (text length, coordinates, key names…) is enforced in one place. Everything is checked
 * BEFORE the first step runs: a flow that fails on step 14 for a typo is a flow that already
 * did thirteen things to a device someone is watching.
 *
 * Variables: `${NAME}` in any string, from `--var NAME=value` (or `--var-NAME value`), else the
 * environment variable `FLOW_NAME` of the app. A variable nobody supplied is an error before anything
 * runs. A variable whose name contains PASSWORD / TOKEN / SECRET / KEY is a SECRET: its value is
 * masked in every line this module or the runner produces, and steps are always shown with the
 * `${NAME}` spelling, never the value.
 */
import { parseSimArgs, SIM_PRESS_BUTTONS, SIM_LABEL_MAX, SIM_TIMEOUT_MAX_MS } from './verb'
import { FLOW_NAME_RE, FLOW_VAR_NAME_RE, FLOW_VAR_VALUE_MAX } from './flow-vars'
export {
  FLOW_NAME_RE,
  FLOW_VAR_NAME_RE,
  FLOW_VAR_VALUE_MAX,
  FLOW_VARS_MAX,
  FLOW_TOTAL_MS_DEFAULT,
  FLOW_TOTAL_MS_MAX,
  parseVarAssignments
} from './flow-vars'
import { FlowYamlError, parseFlowYaml, type YamlValue } from './flow-yaml'

// ─── Limits (the agent-facing text is rendered from these) ───────────────────────────────────

export const FLOW_MAX_STEPS = 200
export const FLOW_INCLUDE_DEPTH_MAX = 4
export const FLOW_FILES_MAX = 20
/** How long a `wait-for` / `assert-visible` polls by default. */
export const FLOW_WAIT_FOR_MS_DEFAULT = 10_000
export const FLOW_ASSERT_MS_DEFAULT = 3_000
/** Where recorded flows go, relative to the project folder. */
export const FLOW_DIR = '.nodeterm/flows'
/** Environment fallback: variable `NAME` is read from `FLOW_NAME` — never a bare host variable. */
export const FLOW_ENV_PREFIX = 'FLOW_'

const SECRET_NAME_RE = /PASSWORD|TOKEN|SECRET|KEY/i
export const isSecretVarName = (name: string): boolean => SECRET_NAME_RE.test(name)

// ─── Model ───────────────────────────────────────────────────────────────────────────────────

export type ElementRef = { by: 'label'; text: string } | { by: 'id'; text: string }

export interface FlowStep {
  /** 1-based over the FLATTENED list (includes expanded) — what `--from-step` counts. */
  index: number
  op: 'sim' | 'wait-for' | 'assert-visible' | 'assert-not-visible' | 'screenshot'
  /** The step as written, with `${NAME}` unexpanded. Safe to show anywhere. */
  display: string
  /** `login.yaml:7` — where the step lives. */
  origin: string
  /** `sim` ops: the verb's own flag map, variables already substituted (never print this). */
  args?: Record<string, string>
  /** `wait-for` / `assert-*` ops. */
  check?: { ref: ElementRef; index: number | null; timeoutMs: number }
  /** `screenshot` op: the (validated) base name. */
  shot?: string
}

export interface LoadedFlow {
  name: string
  device: string | null
  steps: FlowStep[]
  /** The files read, root first (for the summary line). */
  files: string[]
  /** Variable names the flow uses, and which of them are secret. */
  varNames: string[]
  secretValues: string[]
}

export interface FlowIO {
  /** Resolve `rel` against the directory of `baseAbs` (or the project folder when baseAbs is null). Jail applied. */
  resolve(baseAbs: string | null, rel: string): Promise<{ ok: true; abs: string } | { ok: false; message: string }>
  read(abs: string): Promise<string>
}

export class FlowError extends Error {}

const fe = (origin: string, message: string): FlowError => new FlowError(`${origin}: ${message}`)

// ─── Variables ───────────────────────────────────────────────────────────────────────────────

const VAR_RE = /\$\$\{|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Names used by `${NAME}` in a string (the `$${` escape is not a use). */
export function varsIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(VAR_RE)) if (m[1]) out.push(m[1])
  return out
}

export function substitute(text: string, vars: ReadonlyMap<string, string>): string {
  return text.replace(VAR_RE, (m, name: string | undefined) => (name ? (vars.get(name) ?? m) : '${'))
}

/** A masker for every secret value: `mask(text)` replaces each occurrence with `***`. */
export function createMasker(secretValues: readonly string[]): (text: string) => string {
  const vals = [...new Set(secretValues.filter((v) => v.length > 0))].sort((a, b) => b.length - a.length)
  if (vals.length === 0) return (t) => t
  return (t) => vals.reduce((acc, v) => (acc.includes(v) ? acc.split(v).join('***') : acc), t)
}

/** The same, over every string inside a JSON-able value. */
export function maskDeep<T>(value: T, mask: (s: string) => string): T {
  if (typeof value === 'string') return mask(value) as T
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, mask)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskDeep(v, mask)])) as T
  }
  return value
}

// ─── Reading steps ───────────────────────────────────────────────────────────────────────────

type Obj = { [k: string]: YamlValue }
const isObj = (v: YamlValue | undefined): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

const STEP_KEYS = ['tap', 'type', 'wait-for', 'assert-visible', 'assert-not-visible', 'swipe', 'press', 'key', 'screenshot', 'wait-idle', 'run'] as const

const str = (v: YamlValue | undefined): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null)

function pickRef(o: Obj, origin: string, what: string): ElementRef {
  const label = str(o.label)
  const id = str(o.id)
  if (label !== null && id !== null) throw fe(origin, `${what}: give label OR id, not both`)
  if (label !== null) return { by: 'label', text: label }
  if (id !== null) return { by: 'id', text: id }
  throw fe(origin, `${what}: name the element with a label (a string) or { label: … } / { id: … }`)
}

function int(v: YamlValue | undefined, origin: string, what: string, lo: number, hi: number): number | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw fe(origin, `${what} must be a whole number from ${lo} to ${hi}`)
  return v
}

function point(v: YamlValue | undefined, origin: string, what: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw fe(origin, `${what} must be [x, y] in device points`)
  }
  return [v[0] as number, v[1] as number]
}

function onlyKeys(o: Obj, allowed: string[], origin: string, what: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw fe(origin, `${what}: unknown key "${k}" (allowed: ${allowed.join(', ')})`)
}

/** What a typed text looks like in a summary: the `${NAME}` spelling when it has one, else only its length (a literal may be a password). */
function typedText(text: string): string {
  return text.includes('${') ? q(text) : `${Array.from(text).length} chars`
}

function q(s: string): string {
  return JSON.stringify(s.length > 60 ? `${s.slice(0, 59)}…` : s)
}

/** Compact, variable-preserving text of a step for the summary lines. */
function describeRef(r: ElementRef): string {
  return r.by === 'id' ? `id ${q(r.text)}` : q(r.text)
}

interface RawStep {
  op: FlowStep['op']
  /** Flag map with `${NAME}` still in it. */
  args?: Record<string, string>
  check?: { ref: ElementRef; index: number | null; timeoutMs: number }
  shot?: string
  display: string
}

/** One YAML step → its raw (unsubstituted) form, or an include request. */
function readStep(raw: YamlValue, origin: string): RawStep | { include: string } {
  if (!isObj(raw)) throw fe(origin, 'a step is a one-key map like `- tap: "Log in"`')
  const keys = Object.keys(raw)
  if (keys.length !== 1) {
    throw fe(origin, keys.length === 0 ? 'an empty step' : `a step has ONE key (got ${keys.join(', ')}) — put options inside it: \`tap: { label: "x", timeout: 5000 }\``)
  }
  const key = keys[0]
  const v = raw[key]
  switch (key) {
    case 'tap': {
      if (typeof v === 'string') return { op: 'sim', args: { 'tap-label': v }, display: `tap ${q(v)}` }
      if (!isObj(v)) throw fe(origin, 'tap: give a label, or { label | id | at, index, timeout }')
      onlyKeys(v, ['label', 'id', 'at', 'index', 'timeout'], origin, 'tap')
      if (v.at !== undefined) {
        if (v.label !== undefined || v.id !== undefined) throw fe(origin, 'tap: `at` cannot combine with a label or id')
        const [x, y] = point(v.at, origin, 'tap.at')
        return { op: 'sim', args: { tap: `${x},${y}` }, display: `tap at ${x},${y}` }
      }
      const ref = pickRef(v, origin, 'tap')
      const args: Record<string, string> = ref.by === 'id' ? { 'tap-id': ref.text } : { 'tap-label': ref.text }
      const idx = int(v.index, origin, 'tap.index', 1, 99)
      if (idx !== null) args.index = String(idx)
      const t = int(v.timeout, origin, 'tap.timeout', 0, SIM_TIMEOUT_MAX_MS)
      if (t !== null) args['wait-for-ms'] = String(t)
      return { op: 'sim', args, display: `tap ${describeRef(ref)}${idx !== null ? ` #${idx}` : ''}` }
    }
    case 'type': {
      if (typeof v === 'string') return { op: 'sim', args: { type: v }, display: `type ${typedText(v)}` }
      if (!isObj(v)) throw fe(origin, 'type: give the text, or { into: "<field label>", text: "…" }')
      onlyKeys(v, ['into', 'id', 'text', 'index', 'timeout'], origin, 'type')
      const text = str(v.text)
      if (text === null || text === '') throw fe(origin, 'type: `text` is required')
      if (v.id !== undefined) throw fe(origin, 'type: fields are named by their label — use `into:`')
      if (v.into === undefined) return { op: 'sim', args: { type: text }, display: `type ${typedText(text)}` }
      const into = str(v.into)
      if (into === null || into === '') throw fe(origin, 'type.into must be the field label')
      const args: Record<string, string> = { 'type-label': into, text }
      const idx = int(v.index, origin, 'type.index', 1, 99)
      if (idx !== null) args.index = String(idx)
      const t = int(v.timeout, origin, 'type.timeout', 0, SIM_TIMEOUT_MAX_MS)
      if (t !== null) args['wait-for-ms'] = String(t)
      return { op: 'sim', args, display: `type into ${q(into)}: ${typedText(text)}` }
    }
    case 'wait-for':
    case 'assert-visible':
    case 'assert-not-visible': {
      const dflt = key === 'wait-for' ? FLOW_WAIT_FOR_MS_DEFAULT : FLOW_ASSERT_MS_DEFAULT
      let ref: ElementRef
      let idx: number | null = null
      let timeoutMs = dflt
      if (typeof v === 'string') ref = { by: 'label', text: v }
      else if (isObj(v)) {
        onlyKeys(v, ['label', 'id', 'index', 'timeout'], origin, key)
        ref = pickRef(v, origin, key)
        idx = int(v.index, origin, `${key}.index`, 1, 99)
        timeoutMs = int(v.timeout, origin, `${key}.timeout`, 0, SIM_TIMEOUT_MAX_MS) ?? dflt
      } else throw fe(origin, `${key}: give a label, or { label | id, index, timeout }`)
      return { op: key, check: { ref, index: idx, timeoutMs }, display: `${key} ${describeRef(ref)}` }
    }
    case 'swipe': {
      if (!isObj(v)) throw fe(origin, 'swipe: give { from: [x, y], to: [x, y] }')
      onlyKeys(v, ['from', 'to', 'ms'], origin, 'swipe')
      const [x1, y1] = point(v.from, origin, 'swipe.from')
      const [x2, y2] = point(v.to, origin, 'swipe.to')
      const args: Record<string, string> = { swipe: `${x1},${y1},${x2},${y2}` }
      const ms = int(v.ms, origin, 'swipe.ms', 50, 5000)
      if (ms !== null) args.ms = String(ms)
      return { op: 'sim', args, display: `swipe ${x1},${y1} → ${x2},${y2}` }
    }
    case 'press': {
      const b = str(v)
      if (b === null) throw fe(origin, `press: one of ${SIM_PRESS_BUTTONS.join(', ')}`)
      return { op: 'sim', args: { press: b }, display: `press ${b}` }
    }
    case 'key': {
      if (typeof v === 'string' || typeof v === 'number') return { op: 'sim', args: { key: String(v) }, display: `key ${v}` }
      if (!isObj(v)) throw fe(origin, 'key: a key name, or { key, mods: [shift] }')
      onlyKeys(v, ['key', 'mods'], origin, 'key')
      const k = str(v.key)
      if (k === null) throw fe(origin, 'key.key is required')
      const args: Record<string, string> = { key: k }
      if (v.mods !== undefined) {
        const mods = Array.isArray(v.mods) ? v.mods : [v.mods]
        if (mods.some((m) => typeof m !== 'string')) throw fe(origin, 'key.mods is a list of names')
        args.mods = (mods as string[]).join(',')
      }
      return { op: 'sim', args, display: `key ${k}${args.mods ? ` (${args.mods})` : ''}` }
    }
    case 'wait-idle': {
      if (v !== null && !isObj(v)) throw fe(origin, 'wait-idle: use `wait-idle: {}` or { quiet, timeout }')
      const args: Record<string, string> = { 'wait-idle': '' }
      if (isObj(v)) {
        onlyKeys(v, ['quiet', 'timeout'], origin, 'wait-idle')
        const quiet = int(v.quiet, origin, 'wait-idle.quiet', 100, 5000)
        if (quiet !== null) args.quiet = String(quiet)
        const t = int(v.timeout, origin, 'wait-idle.timeout', 1, SIM_TIMEOUT_MAX_MS)
        if (t !== null) args.timeout = String(t)
      }
      return { op: 'sim', args, display: 'wait-idle' }
    }
    case 'screenshot': {
      const name = str(v)
      if (name === null || !FLOW_NAME_RE.test(name)) throw fe(origin, 'screenshot: a short name of letters, digits, . _ - (the file lands in the run folder)')
      return { op: 'screenshot', shot: name, display: `screenshot ${name}` }
    }
    case 'run': {
      const p = str(v)
      if (p === null || p === '') throw fe(origin, 'run: the path of another flow file, relative to this one')
      return { include: p }
    }
    default:
      throw fe(origin, `unknown step "${key}". Steps: ${STEP_KEYS.join(', ')}`)
  }
}

// ─── Loading (includes, variables, validation) ───────────────────────────────────────────────

export interface LoadOptions {
  /** NAME → value, `--var` already applied over the environment. */
  vars: ReadonlyMap<string, string>
  /** Names that came from the command line or environment as secret-looking (by name). */
  io: FlowIO
  maxSteps?: number
}

/**
 * Read a flow and everything it includes, substitute variables, validate every step against the
 * verb's own parser. Throws {@link FlowError} with `file:line` context; never reaches a device.
 */
export async function loadFlow(rootAbs: string, opts: LoadOptions): Promise<LoadedFlow> {
  const maxSteps = opts.maxSteps ?? FLOW_MAX_STEPS
  const files: string[] = []
  const used = new Set<string>()
  const steps: FlowStep[] = []
  let rootName = ''
  let rootDevice: string | null = null

  async function visit(abs: string, stack: string[]): Promise<void> {
    if (stack.length > FLOW_INCLUDE_DEPTH_MAX) {
      throw new FlowError(`${abs}: includes are nested more than ${FLOW_INCLUDE_DEPTH_MAX} deep (${[...stack, abs].map(base).join(' → ')})`)
    }
    if (stack.includes(abs)) throw new FlowError(`${base(abs)}: include cycle ${[...stack, abs].map(base).join(' → ')}`)
    if (files.length >= FLOW_FILES_MAX) throw new FlowError(`a flow may read at most ${FLOW_FILES_MAX} files`)
    files.push(abs)
    let text: string
    try {
      text = await opts.io.read(abs)
    } catch {
      throw new FlowError(`${base(abs)}: could not read the flow file`)
    }
    let doc: YamlValue
    try {
      doc = parseFlowYaml(text)
    } catch (e) {
      if (e instanceof FlowYamlError) throw new FlowError(`${base(abs)}: ${e.message}`)
      throw e
    }
    if (!isObj(doc)) throw new FlowError(`${base(abs)}: a flow is a map with \`steps:\``)
    const root = stack.length === 0
    onlyKeys(doc, ['name', 'device', 'steps'], base(abs), 'flow')
    if (root) {
      const nm = str(doc.name) ?? base(abs).replace(/\.ya?ml$/i, '')
      if (!FLOW_NAME_RE.test(nm)) throw new FlowError(`${base(abs)}: name must be letters, digits, . _ - (up to 64)`)
      rootName = nm
      if (doc.device !== undefined) {
        const d = str(doc.device)
        if (d === null) throw new FlowError(`${base(abs)}: device must be a device id`)
        rootDevice = d
      }
    }
    if (!Array.isArray(doc.steps) || doc.steps.length === 0) throw new FlowError(`${base(abs)}: \`steps:\` must be a non-empty list`)
    for (let i = 0; i < doc.steps.length; i++) {
      const origin = `${base(abs)} step ${i + 1}`
      const raw = readStep(doc.steps[i], origin)
      if ('include' in raw) {
        const inc = substitute(raw.include, opts.vars)
        for (const n of varsIn(raw.include)) used.add(n)
        const r = await opts.io.resolve(abs, inc)
        if (!r.ok) throw fe(origin, `run: ${r.message}`)
        await visit(r.abs, [...stack, abs])
        continue
      }
      if (steps.length >= maxSteps) throw new FlowError(`the flow has more than ${maxSteps} steps (includes expanded)`)
      const index = steps.length + 1
      const step: FlowStep = { index, op: raw.op, display: raw.display, origin }
      if (raw.args) {
        for (const v of Object.values(raw.args)) for (const n of varsIn(v)) used.add(n)
        step.args = Object.fromEntries(Object.entries(raw.args).map(([k, v]) => [k, substitute(v, opts.vars)]))
      }
      if (raw.check) {
        for (const n of varsIn(raw.check.ref.text)) used.add(n)
        step.check = { ...raw.check, ref: { ...raw.check.ref, text: substitute(raw.check.ref.text, opts.vars) } }
        if (step.check.ref.text.length === 0 || step.check.ref.text.length > SIM_LABEL_MAX) throw fe(origin, 'the element label is empty or too long')
      }
      if (raw.shot) step.shot = raw.shot
      steps.push(step)
    }
  }

  await visit(rootAbs, [])

  const missing = [...used].filter((n) => !opts.vars.has(n))
  if (missing.length > 0) {
    throw new FlowError(
      `the flow needs variable${missing.length === 1 ? '' : 's'} ${missing.join(', ')} — pass ${missing.map((n) => `--var ${n}=<value>`).join(' ')}` +
        ` (or set ${missing.map((n) => FLOW_ENV_PREFIX + n).join(', ')} in the app's environment). Nothing was run.`
    )
  }

  // Validate every sim step now, with the verb's own parser — a typo on step 14 must not cost 13 steps.
  for (const s of steps) {
    if (s.op !== 'sim' || !s.args) continue
    const parsed = parseSimArgs(s.args)
    if ('error' in parsed) throw fe(s.origin, `${s.display}: ${redactArgsError(parsed.error, s.args)}`)
  }

  const varNames = [...used]
  return {
    name: rootName,
    device: rootDevice,
    steps,
    files,
    varNames,
    secretValues: varNames.filter(isSecretVarName).map((n) => opts.vars.get(n) as string)
  }
}

/** A parser error never needs the typed text; it may quote a value, so cut any that appears. */
function redactArgsError(message: string, args: Record<string, string>): string {
  let out = message
  for (const k of ['text', 'type']) {
    const v = args[k]
    if (v && v.length > 3) out = out.split(v).join('<text>')
  }
  return out
}

function base(abs: string): string {
  return abs.slice(Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\')) + 1)
}

/** Build the variable map: environment fallback `FLOW_<NAME>` for the names the flow uses, `--var` over it. */
export function buildVarMap(
  given: ReadonlyArray<[string, string]>,
  env: Readonly<Record<string, string | undefined>>
): Map<string, string> {
  const m = new Map<string, string>()
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith(FLOW_ENV_PREFIX) && v !== undefined) {
      const name = k.slice(FLOW_ENV_PREFIX.length)
      if (FLOW_VAR_NAME_RE.test(name) && v.length <= FLOW_VAR_VALUE_MAX) m.set(name, v)
    }
  }
  for (const [k, v] of given) m.set(k, v)
  return m
}
