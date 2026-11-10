import type { Project } from '@shared/types'

/** One shareable project as shown in the host's project chooser. */
export interface HostShareOption {
  id: string
  name: string
  /** Why this project may NOT be shared (the host's answer, `relayHost.scopeProblems`): its folder is
   *  the disk root, the home directory or an ancestor of either, so every file under it — `~/.ssh`
   *  included — would be readable. The chooser shows it disabled, with this sentence. */
  refusal?: string
}

/**
 * The list of projects a relay host may share, as `{id, name}[]`. Only OPEN (non-`closed`)
 * projects are shareable — a closed project isn't in the tab bar and has nothing to show a
 * joiner. The `activeProjectId` (when itself open) is hoisted to the front so it can be the
 * default selection. `refusals` (project id → reason, from the host) marks the ones that may not be
 * shared. Pure; empty input yields an empty list.
 */
export function hostShareOptions(
  projects: Project[],
  activeProjectId: string,
  refusals: Readonly<Record<string, string>> = {}
): HostShareOption[] {
  const open = projects
    .filter((p) => !p.closed)
    .map((p) => (Object.hasOwn(refusals, p.id) ? { id: p.id, name: p.name, refusal: refusals[p.id] } : { id: p.id, name: p.name }))
  const activeIdx = open.findIndex((p) => p.id === activeProjectId)
  if (activeIdx <= 0) return open
  return [open[activeIdx], ...open.slice(0, activeIdx), ...open.slice(activeIdx + 1)]
}

/**
 * The project an invite shares: the user's pick when it is still an option, else the first option
 * that may be shared, else the first option at all. NEVER '' while there are options: '' means an
 * UNSCOPED invite (full access to this machine), so a list whose every project is refused must keep a
 * (refused) selection whose reason blocks the invite, rather than fall back to granting everything.
 */
export function effectiveShareId(options: HostShareOption[], picked: string): string {
  if (options.some((o) => o.id === picked)) return picked
  return (options.find((o) => !o.refusal) ?? options[0])?.id ?? ''
}

/**
 * What a relay invite actually grants, in words — ONE sentence for both host surfaces (Settings →
 * Remote access and the Remote access dialog), so the two cannot drift apart.
 *
 * A SCOPED invite (a project is selected) is enforced host-side by core/relay/scoped-guest-policy.ts:
 * the joiner reaches that project's terminals, files, git and board, and none of the host's other
 * projects, settings or saved credentials. It is still consent to run commands: a terminal the joiner
 * opens is a shell on this machine as the host's user, and the sentence says so rather than implying
 * an OS sandbox. An UNSCOPED invite (nothing to scope to) is full access, and says that plainly.
 */
export function relayShareGrantCopy(sharedName: string | null, machine: string): string {
  if (!sharedName) {
    return `No project is selected, so the joiner gets full access to ${machine} as you — every project, and commands in any folder.`
  }
  return (
    `The joiner can open terminals and agents in ${sharedName}, and read and edit its files — ` +
    `running commands on ${machine} as you. The app keeps them out of your other projects, ` +
    `your settings and your saved credentials, but a terminal they open is still a shell on ${machine}.`
  )
}
