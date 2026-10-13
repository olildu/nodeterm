/**
 * The few flow constants and the `--var` reader the verb's flag parser needs. A leaf on purpose:
 * `flow.ts` imports the verb parser (to validate every step with it), so the parser cannot import
 * `flow.ts` back without a cycle.
 */
export const FLOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const FLOW_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const FLOW_VAR_VALUE_MAX = 4_000
export const FLOW_VARS_MAX = 40
export const FLOW_TOTAL_MS_DEFAULT = 300_000
export const FLOW_TOTAL_MS_MIN = 1_000
export const FLOW_TOTAL_MS_MAX = 900_000
export const FLOW_STEP_NUMBER_MAX = 1_000

/** `--var` text: `A=1`, several separated by newlines. Returns the pairs or a named error. */
export function parseVarAssignments(raw: string): Array<[string, string]> | { error: string } {
  const out: Array<[string, string]> = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const eq = line.indexOf('=')
    const name = (eq < 0 ? line : line.slice(0, eq)).trim()
    if (eq < 0 || !FLOW_VAR_NAME_RE.test(name)) {
      return { error: `sim: --var takes NAME=value (a name of letters, digits and _), got ${JSON.stringify(line.slice(0, 40).replace(/=.*/, '=…'))}` }
    }
    const value = line.slice(eq + 1)
    if (value.length > FLOW_VAR_VALUE_MAX) return { error: `sim: variable ${name} is longer than ${FLOW_VAR_VALUE_MAX} characters` }
    out.push([name, value])
  }
  return out
}
