import type { Project } from '@shared/types'

/**
 * The question asked before this desktop opens an SSH project it handed to a hosted team.
 *
 * After "Share with team" the server's own core writes that project's canvas. Opening it here as
 * well makes this desktop a second writer of the same canvas, and the two overwrite each other —
 * so every path that would open it asks first, with this text. `null` = never handed off, nothing
 * to ask.
 *
 * A mark with no `hostId` is a handover that never finished: the server may or may not hold the
 * project, so the copy says exactly that rather than naming a team that may not exist. Both copies
 * say what opening it here would do to its agents: the server resumed their conversations, so
 * resuming them here too would put two processes on one transcript, and "Open here anyway" skips
 * that automatic resume once.
 *
 * The finished copy names no way out ("open it from the team tab", "run team unshare first"),
 * because neither gives the project back: after `team unshare` there is no team tab, and the
 * server still holds the project and keeps its agents running (unshare only stops sharing it).
 * So the copy says what is true in every state, shared or unshared.
 *
 * `teamLabel` is the team's name from this device's bookmark of it, when one is known; anything
 * else (no bookmark, a blank label) reads as "the hosted team".
 */
/** "Open here anyway" skips each agent's automatic resume once (terminal/handed-off-resume.ts). */
const AGENTS_NOT_RESUMED = 'Its agents are not resumed here automatically.'

export function handedOffWarning(
  p: Pick<Project, 'name' | 'handedOffTo' | 'ssh'>,
  teamLabel: string | null
): string | null {
  const to = p.handedOffTo
  if (!to) return null
  if (!to.hostId) {
    return (
      `Sharing ${p.name} with a team did not finish. If the server already took it over, opening it ` +
      'here gives one canvas two editors that can overwrite each other, and its agents would start ' +
      'the same conversations the server is running.\n\nOpen it here anyway? ' +
      AGENTS_NOT_RESUMED
    )
  }
  const team = teamLabel?.trim() || 'the hosted team'
  const host = p.ssh?.server.host || 'its host'
  return (
    `${p.name} was handed to team ${team} on ${host}. The server keeps its canvas and keeps ` +
    'running its agents, even after it is unshared. Opening it here gives one canvas two editors ' +
    'that can overwrite each other, and its agents would start the same conversations the server ' +
    'is running.\n\nOpen it here anyway? ' +
    AGENTS_NOT_RESUMED
  )
}
