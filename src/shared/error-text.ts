/**
 * The message of a caught value: an `Error`'s `message`, else the value stringified.
 *
 * Several modules declare a local helper with this NAME that does something else (zellij's joins
 * stdout and stderr, opencode's formats an SDK error object, the simulator's strips an Xcode
 * prefix). Those are separate functions, not copies of this one, and stay where they are.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
