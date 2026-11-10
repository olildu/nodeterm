// "Share with team" for an SSH project: the dialog around `runShare` (lib/shareSshTeam). The
// orchestrator owns the order and every undo; this component only shows where it is, asks the one
// question (the confirm), streams the installer's output, and shows the result.
//
// It cannot be dismissed while a step runs: the steps change the host and the project, and a closed
// dialog would hide a failure (or an invite code) the user has to see. The confirm and the result
// close on Escape or the scrim; at the confirm that is a Cancel, which changes nothing.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'
import type { ShareConfirmSummary, ShareNode, ShareOutcome, SharePhase } from '../lib/shareSshTeam'
import { errorText } from '../../shared/error-text'

export type ShareDialogState =
  | { phase: 'running'; step: SharePhase; log: string }
  | { phase: 'confirm'; summary: ShareConfirmSummary }
  | {
      phase: 'done'
      outcome: Exclude<ShareOutcome, { kind: 'cancelled' }>
      copied?: boolean
      /** The confirm's security sentence, repeated beside the invite code: whoever hands the code
       *  out decides who gets a shell, so it is said again where that decision is made. */
      security?: string
    }

export const SHARE_STEP_TEXT: Readonly<Record<SharePhase, string>> = Object.freeze({
  probing: 'Checking the host…',
  installing: 'Installing nodeterm-server on the host. This can take several minutes…',
  'checking-install': 'Checking the install…',
  releasing: 'Saving the canvas to the host…',
  bootstrapping: 'Setting up the team…',
  'handing-over': 'Moving the terminals to the server…',
  joining: 'Joining the team…'
})

const INSTALL_TEXT: Readonly<Record<NonNullable<ShareConfirmSummary['install']>, string>> = Object.freeze({
  missing:
    'nodeterm-server will be installed on the host: about 600 MB, built from source, as a systemd --user service that updates itself daily.',
  outdated: 'nodeterm-server on the host is too old for this and will be updated (the same installer).',
  'not-running': 'nodeterm-server on the host is not answering and will be reinstalled and restarted.'
})
const RESTART_TEXT = 'Updating restarts the server; teammates connected to it are briefly disconnected.'
const RESTORED_TEXT = 'The SSH project was reopened; nothing was changed.'
const RESTORE_FAILED_TEXT = 'The SSH project could not be restored automatically. Reopen it from Recently closed.'

/** The installer's output is shown (and kept) only this far back: a build prints far more than
 *  anyone reads, and the tail is where a failure is. */
export const SHARE_LOG_TAIL = 4000

function TitleList({ heading, items }: { heading?: string; items: string[] }): React.JSX.Element | null {
  if (!items.length) return null
  return (
    <>
      {heading && <p className="share-team__heading">{heading}</p>}
      <ul className="share-team__list">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </>
  )
}

const titles = (nodes: ShareNode[]): string[] => nodes.map((n) => n.title)
const withReasons = (rows: Array<{ node: ShareNode; reason: string }>): string[] =>
  rows.map((r) => `${r.node.title} — ${r.reason}`)

const Log = ({ text }: { text: string }): React.JSX.Element => (
  <pre role="log" className="share-team__log">
    {text.slice(-SHARE_LOG_TAIL)}
  </pre>
)

export function ShareTeamDialogBody(p: {
  projectName: string
  state: ShareDialogState
  onConfirm(): void
  onCancel(): void
  onClose(): void
  onCopy(): void
  onCancelInstall(): void
}): React.JSX.Element {
  const s = p.state
  let title = `Share ${p.projectName} with a team`
  let content: ReactNode
  let actions: ReactNode = (
    <button className="confirm__btn" data-autofocus="" onClick={p.onClose}>
      Close
    </button>
  )

  if (s.phase === 'running') {
    content = (
      <>
        <p>{SHARE_STEP_TEXT[s.step]}</p>
        {s.step === 'installing' && <Log text={s.log} />}
      </>
    )
    // Only the install can be stopped: every later step is short, and stopping one half-way would
    // leave the very state the orchestrator's own undo exists to avoid. The panel keeps the focus,
    // not this button: a stray Enter must not stop a long install.
    actions =
      s.step === 'installing' ? (
        <button className="confirm__btn" onClick={p.onCancelInstall}>
          Cancel
        </button>
      ) : null
  } else if (s.phase === 'confirm') {
    const m = s.summary
    content = (
      <>
        <p>{`Host: ${m.user}@${m.host}`}</p>
        {m.install && <p>{INSTALL_TEXT[m.install]}</p>}
        {m.restartsService && <p>{RESTART_TEXT}</p>}
        <p className="share-team__warning">{m.security}</p>
        <TitleList heading="These agents continue on the server:" items={titles(m.resumable)} />
        <TitleList
          heading="These terminals are running something that will stop:"
          items={m.stopping.map((x) => `${x.node.title} — ${x.command}`)}
        />
        <TitleList heading="These agents will not be resumed — resume them by hand:" items={withReasons(m.manual)} />
      </>
    )
    // Focus lands on Cancel: an Enter pressed out of habit must never start an install on a host.
    actions = (
      <>
        <button className="confirm__btn" data-autofocus="" onClick={p.onCancel}>
          Cancel
        </button>
        <button className="confirm__btn primary" onClick={p.onConfirm}>
          Share
        </button>
      </>
    )
  } else {
    const o = s.outcome
    if (o.kind === 'shared') {
      title = `Shared with ${o.teamLabel}`
      content = (
        <>
          <p className="share-team__heading">Invite code</p>
          <div className="share-team__code">
            <input
              className="confirm__input"
              readOnly
              aria-label="Invite code"
              value={o.joinCode}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button className="confirm__btn primary" data-autofocus="" onClick={p.onCopy}>
              {s.copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p>Give this code to teammates. An owner approves each new device.</p>
          {s.security && <p className="share-team__warning">{s.security}</p>}
          {o.hosting === 'starting' && <p>Hosting is starting — the code works in a moment.</p>}
          <p>This computer is joining the team; its tab opens when it connects.</p>
          <TitleList heading="Resumed on the server:" items={titles(o.resumed)} />
          <TitleList heading="Not resumed:" items={withReasons(o.notResumed)} />
          <TitleList heading="Still running on SSH (not moved):" items={titles(o.stillOnSsh)} />
        </>
      )
      actions = (
        <button className="confirm__btn" onClick={p.onClose}>
          Close
        </button>
      )
    } else if (o.kind === 'refused') {
      content = (
        <>
          <p>{o.reason}</p>
          <TitleList items={titles(o.busy ?? [])} />
        </>
      )
    } else {
      content = (
        <>
          <p className="share-team__error" role="alert">{`Could not share: ${o.error}`}</p>
          {/* "Nothing was changed" only when the undo is known to have worked. */}
          {o.restoreFailed ? <p>{RESTORE_FAILED_TEXT}</p> : o.reopened && <p>{RESTORED_TEXT}</p>}
          {o.log && <Log text={o.log} />}
        </>
      )
    }
  }

  return (
    <div className="confirm share-team" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
      <p className="share-team__title">{title}</p>
      <div className="share-team__body">{content}</div>
      {actions && <div className="confirm__actions">{actions}</div>}
    </div>
  )
}

export function ShareTeamDialog({
  projectId,
  projectName,
  start,
  onClose
}: {
  projectId: string
  projectName: string
  /** Runs the share (once, on mount) and reports its steps and its one question through `ui`. */
  start(ui: { phase(p: SharePhase): void; confirm(s: ShareConfirmSummary): Promise<boolean> }): Promise<ShareOutcome>
  onClose(): void
}): React.JSX.Element | null {
  const [state, setState] = useState<ShareDialogState>({ phase: 'running', step: 'probing', log: '' })
  // The latest state for the key and click handlers (a closure would see the render that made it).
  const stateRef = useRef(state)
  stateRef.current = state
  const isTop = useDialogStack()
  // The caller passes a fresh `start` on every render; the share runs once, with the first.
  const startRef = useRef(start)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const logRef = useRef('')
  const stepRef = useRef<SharePhase>('probing')
  const securityRef = useRef<string | undefined>(undefined)
  const answerRef = useRef<((ok: boolean) => void) | null>(null)
  const liveRef = useRef(true)

  const answer = useCallback((ok: boolean) => {
    const resolve = answerRef.current
    answerRef.current = null
    resolve?.(ok)
  }, [])

  useEffect(() => {
    liveRef.current = true
    const ui = {
      phase(p: SharePhase): void {
        stepRef.current = p
        if (liveRef.current) setState({ phase: 'running', step: p, log: logRef.current })
      },
      confirm(summary: ShareConfirmSummary): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
          answerRef.current?.(false)
          if (!liveRef.current) return resolve(false)
          securityRef.current = summary.security
          answerRef.current = resolve
          setState({ phase: 'confirm', summary })
        })
      }
    }
    let run: Promise<ShareOutcome>
    try {
      run = Promise.resolve(startRef.current(ui))
    } catch (e) {
      run = Promise.reject(e)
    }
    run.then(
      (outcome) => {
        if (!liveRef.current) return
        if (outcome.kind === 'cancelled') {
          onCloseRef.current()
          return
        }
        // An install that failed keeps the output it streamed: the tail is usually the reason.
        const keepLog =
          outcome.kind === 'failed' &&
          !outcome.log &&
          logRef.current &&
          (outcome.step === 'installing' || outcome.step === 'checking-install')
        setState({
          phase: 'done',
          outcome: keepLog ? { ...outcome, log: logRef.current } : outcome,
          ...(securityRef.current ? { security: securityRef.current } : {})
        })
      },
      // The orchestrator answers instead of rejecting and owns every undo, so a rejection is shown
      // as it is: nothing here may try to put the project back.
      (e) => {
        if (!liveRef.current) return
        setState({ phase: 'done', outcome: { kind: 'failed', step: stepRef.current, error: errorText(e), reopened: false } })
      }
    )
    return () => {
      liveRef.current = false
      // A question nobody can answer any more is a no: the run ends as cancelled.
      answer(false)
    }
  }, [answer])

  useEffect(
    () =>
      window.nodeTerminal.shareTeam.onInstallOutput(projectId, (text) => {
        logRef.current = (logRef.current + text).slice(-SHARE_LOG_TAIL)
        setState((s) => (s.phase === 'running' ? { ...s, log: logRef.current } : s))
      }),
    [projectId]
  )

  // Focus lands in the dialog, so keys stay inside it instead of reaching the canvas behind.
  const panelRef = useRef<HTMLDivElement>(null)
  const focusKey = state.phase === 'running' ? `running:${state.step}` : state.phase
  useEffect(() => {
    const panel = panelRef.current
    const target = panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel?.querySelector<HTMLElement>('.share-team')
    target?.focus({ preventScroll: true })
  }, [focusKey])

  const dismiss = useCallback(() => {
    const s = stateRef.current
    if (s.phase === 'confirm') answer(false)
    else if (s.phase === 'done') onCloseRef.current()
  }, [answer])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isTop()) dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop, dismiss])

  const copy = (): void => {
    const s = stateRef.current
    if (s.phase !== 'done' || s.outcome.kind !== 'shared') return
    window.nodeTerminal.clipboard.writeText(s.outcome.joinCode)
    setState({ ...s, copied: true })
  }

  // The install then answers E_CANCELLED, and the orchestrator ends the share with that failure.
  const cancelInstall = (): void => {
    try {
      window.nodeTerminal.shareTeam.cancelInstall(projectId).catch(() => {})
    } catch {
      // No bridge to ask: the install runs to its end, and its result renders as usual.
    }
  }

  return createPortal(
    <div className="confirm-overlay" ref={panelRef} onClick={dismiss}>
      <ShareTeamDialogBody
        projectName={projectName}
        state={state}
        onConfirm={() => answer(true)}
        onCancel={() => answer(false)}
        onClose={dismiss}
        onCopy={copy}
        onCancelInstall={cancelInstall}
      />
    </div>,
    document.body
  )
}
