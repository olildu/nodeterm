/**
 * True for a plain JSON-style object: not null, not an array. The guard every reader of untrusted
 * JSON (hook payloads, transcripts, git-shared project files, CDP messages) runs before it touches
 * a field.
 *
 * One definition, imported everywhere. It used to be re-typed per file under two names
 * (`isRecord` / `isObj`), with the null check spelled two different ways.
 *
 * Arrays are rejected on purpose. `session-host/windows-conpty.ts` keeps its own guard because it
 * accepts arrays, and folding it in here would change what that reader accepts.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
