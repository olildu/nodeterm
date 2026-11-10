import { useMemo } from 'react'
import type { ProjectKanban } from '@shared/types'
import { pullStatusFreshness } from '@shared/github-pull-status'
import {
  readPullLinks,
  relinkPull,
  sanitizeKanbanPullAutoMove,
  setNoAutoMove,
  unlinkPull
} from '@shared/kanban-pull-links'
import { useProjects } from '../../state/projects'
import { useOwningProjectId } from '../../session/owning-project'
import { useGitHubIssues } from '../../state/githubIssues'
import { useSettings } from '../../state/settings'
import { pullsForCard } from '../../lib/pullLinks'
import { PullRefChip } from './PullStatusBadges'
import type { KanbanSession } from './KanbanView'

/** Same reason the worktree affordances give on an SSH project: a branch link needs a worktree
 *  group, and worktree groups are local-only in v1. */
export const PULL_LINK_SSH_REASON =
  'Linking pull requests needs a worktree group, and worktrees are not supported on SSH projects yet.'

/**
 * The card modal's "Pull requests" section: the PRs whose head is this card's worktree branch, and
 * the PRs that close the issue the session was started on, each removable (the removal is a
 * git-shared tombstone, so the auto-link does not come back), plus this card's auto-move opt-out.
 * Renders nothing for a board without GitHub, or a card with neither a worktree group nor an issue.
 */
export function CardPullRequests({
  session,
  board,
  onChangeBoard
}: {
  session: KanbanSession
  board: ProjectKanban
  onChangeBoard: (next: ProjectKanban) => void
}): React.JSX.Element | null {
  // The project that owns `board` — the card's project under the modal's ProjectSessionScope (an
  // Omni lane is not the active project), else the active one. Its pull board, SSH flag and
  // auto-move target must all describe that same project.
  const owningProjectId = useOwningProjectId()
  const activeProjectId = useProjects((state) => state.activeProjectId)
  const projectId = owningProjectId ?? activeProjectId
  const ssh = useProjects((state) => !!state.projects.find((item) => item.id === projectId)?.ssh)
  const pullBoard = useGitHubIssues((state) => state.projects[projectId]?.pullBoard)
  const autoMoveRaw = useSettings((state) => state.settings.kanbanPullAutoMove)
  const target = useMemo(() => {
    const entry = sanitizeKanbanPullAutoMove(autoMoveRaw).projects[projectId]
    return entry ? board.columns.find((column) => column.id === entry.columnId) : undefined
  }, [autoMoveRaw, projectId, board.columns])
  if (!board.github) return null
  // On SSH only the branch half is unavailable: an issue-bound session still links through its issue.
  if (ssh && !session.issueRef) {
    return (
      <section className="card-pulls" aria-label="Pull requests">
        <p className="card-pulls__note">{PULL_LINK_SSH_REASON}</p>
      </section>
    )
  }
  if (!session.worktreeBranch && !session.issueRef) return null
  const links = pullsForCard(session, pullBoard, board)
  const freshness = pullBoard ? pullStatusFreshness(pullBoard, Date.now()) : 'fresh'
  const optedOut = readPullLinks(board).noAutoMove.includes(session.id)
  const abandoned = links.linked.filter((pull) => pull.lifecycle === 'closed')
  return (
    <section className="card-pulls" aria-label="Pull requests">
      <div className="card-pulls__head">
        <span className="card-pulls__title">Pull requests</span>
        {session.worktreeBranch && (
          <span className="card-pulls__branch" title="The branch of this card's worktree group">
            {session.worktreeBranch}
          </span>
        )}
        {session.issueRef && (
          <span className="card-pulls__branch" title="Pull requests that close the issue this session was started on">
            closes #{session.issueRef.number}
          </span>
        )}
      </div>
      {links.linked.length === 0 && links.unlinked.length === 0 && (
        <p className="card-pulls__note">
          {!pullBoard
            ? 'Pull request status is not available.'
            : session.worktreeBranch
              ? 'No pull request from this branch yet.'
              : 'No open pull request closes this issue yet.'}
        </p>
      )}
      {links.linked.map((pull) => (
        <div key={pull.number} className="card-pulls__row">
          <PullRefChip status={pull} freshness={freshness} />
          <button
            className="card-pulls__action"
            onClick={() => onChangeBoard(unlinkPull(board, session.id, pull.number))}
            title="This card is not about this pull request. The link will not come back."
          >
            Unlink
          </button>
        </div>
      ))}
      {links.unlinked.map((pull) => (
        <div key={pull.number} className="card-pulls__row card-pulls__row--unlinked">
          <span className="pull-ref">PR #{pull.number} (unlinked)</span>
          <button className="card-pulls__action" onClick={() => onChangeBoard(relinkPull(board, session.id, pull.number))}>
            Link again
          </button>
        </div>
      ))}
      {target && links.linked.length > 0 && (
        <>
          {abandoned.length > 0 && !optedOut && (
            <p className="card-pulls__note card-pulls__note--warn">
              {abandoned.map((pull) => `PR #${pull.number}`).join(', ')} closed without merging, so this card will not move. Unlink it to let the card move when the rest merge.
            </p>
          )}
          <label className="card-pulls__optout">
            <input
              type="checkbox"
              checked={!optedOut}
              onChange={(event) => onChangeBoard(setNoAutoMove(board, session.id, !event.target.checked))}
            />
            Move this card to “{target.title}” when its pull requests merge
          </label>
        </>
      )}
    </section>
  )
}
