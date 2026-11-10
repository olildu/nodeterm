import { useEffect, useMemo, useState } from 'react'
import type { Project } from '@shared/types'
import { effectiveShareId, hostShareOptions, type HostShareOption } from './relayHostShare'

/**
 * The host's "Project to share" choice, for both invite surfaces (Settings → Remote access and the
 * Remote access dialog): the open projects, which of them the host refuses to share and why
 * (`relayHost.scopeProblems` — the folder is the disk root, the home directory or an ancestor of
 * either), and the selected one. The host refuses those invites itself as well; this is so the
 * person sees the reason before pressing the button, not after.
 */
export function useHostShareChoice(
  projects: Project[],
  activeProjectId: string
): {
  options: HostShareOption[]
  shareId: string
  setShareId: (id: string) => void
  sharedName: string
  /** Why the selected project cannot be shared, or null. The invite button is disabled while set. */
  refusal: string | null
} {
  const [refusals, setRefusals] = useState<Record<string, string>>({})
  const [picked, setShareId] = useState('')
  const openIds = projects
    .filter((p) => !p.closed)
    .map((p) => p.id)
    .join('\n')
  useEffect(() => {
    let live = true
    const ids = openIds ? openIds.split('\n') : []
    void window.nodeTerminal.relayHost
      .scopeProblems(ids)
      .then((r) => {
        if (live) setRefusals(r && typeof r === 'object' ? r : {})
      })
      .catch(() => {
        // The host still refuses at invite time; without an answer nothing is pre-disabled.
        if (live) setRefusals({})
      })
    return () => {
      live = false
    }
  }, [openIds])
  const options = useMemo(() => hostShareOptions(projects, activeProjectId, refusals), [projects, activeProjectId, refusals])
  const shareId = effectiveShareId(options, picked)
  const selected = options.find((o) => o.id === shareId)
  return { options, shareId, setShareId, sharedName: selected?.name ?? '', refusal: selected?.refusal ?? null }
}
