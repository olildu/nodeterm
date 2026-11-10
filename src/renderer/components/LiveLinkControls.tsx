// A live link's owner controls, shared by the LIVE chip's popover (LiveLinkPopover) and the Live chat
// drawer (LiveChatDrawer): one implementation, so the two surfaces cannot disagree about what a
// Control link's switch, password change or unlock does. Every string someone else wrote is rendered
// as React TEXT; a new password lives only in `ControlSection`'s state and goes with it.
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import type { NodeTerminalApi } from '@shared/types'
import type { ControlChangeResult, WatchLinkControlView, WatchLinkRole } from '@shared/watch-link-types'
import { newControlPassword, PasswordField, useCopied } from './LiveLinkPassword'
import { Switch } from '../ui/Switch'
import {
  CONTROL_CHANGE_FAILED_MESSAGE,
  CONTROL_CHANGE_UNSAVED_MESSAGE,
  controlLockedText,
  KICK_FAILED_MESSAGE,
  KICK_NOT_DONE_MESSAGE,
  PASSWORD_CHANGE_FAILED_MESSAGE,
  PASSWORD_CHANGE_NOTE,
  PASSWORD_SAVE_TIMEOUT_MS,
  PASSWORD_SEPARATE_NOTE,
  PASSWORD_SHOWN_ONCE,
  PASSWORD_UNCONFIRMED_MESSAGE,
  passwordProblemText,
  STOP_FAILED_MESSAGE
} from '../lib/liveLink'

/**
 * What a section holds its surface for:
 *  - `save`: a new Control password's save is in flight. Once core takes it, its plaintext exists
 *    nowhere else, so a surface closed under it would lose a password that was changed: the surface
 *    must not close on the owner's close gestures, nor switch away from this link.
 *  - `shown`: the new password is on screen until Done. Closing is the owner's own gesture (they have
 *    it in front of them), but a surface that switches LINKS by itself (the drawer, on an Open chat
 *    for another link) must not take it away first.
 */
export type ControlHoldKind = 'save' | 'shown'

/**
 * `hold(kind)` holds the surface until the returned release runs (see `ControlHoldKind`). The link
 * going away still closes the popover (nothing is owed for a link that no longer exists). Absent:
 * nothing to hold.
 */
export const ControlHold = createContext<((kind?: ControlHoldKind) => () => void) | null>(null)

/** The roles whose viewers can chat: a Control link is a Commenter link plus typing (spec §2.1). */
export function hasChat(role: WatchLinkRole): boolean {
  return role === 'commenter' || role === 'controller'
}

/**
 * Kick one viewer, reporting what did not happen: `false` from core (they may already have left) and
 * a rejection (the Server Edition's socket was down) say different things. `onError(null)` first
 * clears an earlier message.
 */
export function kickViewer(
  api: Pick<NodeTerminalApi['watchLink'], 'kick'>,
  linkId: string,
  viewerId: string,
  onError: (text: string | null) => void
): void {
  onError(null)
  api.kick(linkId, viewerId).then(
    (ok) => {
      if (!ok) onError(KICK_NOT_DONE_MESSAGE)
    },
    () => onError(KICK_FAILED_MESSAGE)
  )
}

/**
 * A Control link's owner controls (spec §2.6): the Typing switch, Change password (a new one is shown
 * ONCE, then only its hash exists — core keeps no plaintext), and Allow control again while the link
 * is locked by wrong passwords. Shared by the chip's popover and the Live chat drawer.
 *
 * The switch shows core's state (the next push), never an optimistic one: a change core refused must
 * not look applied. A typed or new password lives only in this component's state and goes with it.
 *
 * A NARROWING change (typing off, a new password) that core answered 'unsaved' is in force but would be
 * undone by a restart: the section says so, with Stop sharing right there — the one thing that ends it
 * for good — in the popover and the drawer alike (the drawer has no Stop of its own). The notice stays
 * until a later change is saved (every write carries the whole list, so that one saved this one too).
 */
export function ControlSection({ linkId, control }: { linkId: string; control: WatchLinkControlView }): React.JSX.Element {
  const api = window.nodeTerminal.watchLink
  const hold = useContext(ControlHold)
  const invalidId = useId()
  const [busy, setBusy] = useState(false)
  /** A password save is in flight: the surface holds open, Save reads "Saving…". */
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** A narrowing change is in force but unsaved (`ControlChangeResult` 'unsaved'). */
  const [unsaved, setUnsaved] = useState(false)
  /** The unsaved notice's Stop did not reach nodeterm. */
  const [stopFailed, setStopFailed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [shown, setShown] = useState<string | null>(null)
  const [copied, copy] = useCopied()
  // Keyboard focus follows the flow: the new field on entering it, Copy password once a new one is
  // shown, "Change password…" again on Cancel or Done (whose button would otherwise take the focus
  // with it as it unmounts). Applied after the render that mounts the target.
  const [focusTo, setFocusTo] = useState<'field' | 'copy' | 'change' | null>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  const copyRef = useRef<HTMLButtonElement>(null)
  const changeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!focusTo) return
    const el = focusTo === 'field' ? fieldRef.current : focusTo === 'copy' ? copyRef.current : changeRef.current
    el?.focus({ preventScroll: true })
    setFocusTo(null)
  }, [focusTo])
  // A hold and a deadline this section took and has not given back — both go on unmount too (the
  // link went away: nothing is owed for it).
  const releaseRef = useRef<(() => void) | null>(null)
  /** The `shown` hold while a new password is on screen (released by Done, or on unmount). */
  const shownReleaseRef = useRef<(() => void) | null>(null)
  const deadlineRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(
    () => () => {
      releaseRef.current?.()
      shownReleaseRef.current?.()
      clearTimeout(deadlineRef.current)
    },
    []
  )
  /** Which save is current: a late answer to an older one is not shown. */
  const saveGen = useRef(0)
  /** Core's answer to a change: saved clears an earlier unsaved notice (that write carried it too),
   *  'unsaved' raises it, anything else is a change that did not take. */
  const settled = (r: ControlChangeResult, failed: string): void => {
    if (r === 'unsaved') setUnsaved(true)
    else if (r === true) setUnsaved(false)
    else setError(failed)
  }
  const run = (call: () => Promise<ControlChangeResult>, failed: string): void => {
    setBusy(true)
    setError(null)
    void Promise.resolve()
      .then(call)
      .then(
        (r) => settled(r, failed),
        () => setError(failed)
      )
      .finally(() => setBusy(false))
  }
  /** The notice's Stop: what the popover's Stop sharing does (the desktop's stop is immediate, and the
   *  state push removes the link); the Server Edition rejects when its socket is down — say so. */
  const stopLink = (): void => {
    setStopFailed(false)
    api.revoke(linkId).catch(() => setStopFailed(true))
  }
  /**
   * Save a new password, holding the surface (popover or drawer) open until the answer is in and, on
   * success, shown — its plaintext exists nowhere else. Bounded: with no answer after
   * `PASSWORD_SAVE_TIMEOUT_MS` the hold is released and the owner is told the outcome is unknown. An
   * answer that lands later still counts: a new password that did take is shown, one refused says so.
   */
  const save = (): void => {
    const next = draft
    const gen = ++saveGen.current
    const release = hold?.() ?? null
    releaseRef.current = release
    let open = true
    const settle = (): void => {
      if (!open) return
      open = false
      clearTimeout(deadlineRef.current)
      setSaving(false)
      setBusy(false)
      release?.()
      if (releaseRef.current === release) releaseRef.current = null
    }
    setSaving(true)
    setBusy(true)
    setError(null)
    deadlineRef.current = setTimeout(() => {
      if (!open) return
      settle()
      setError(PASSWORD_UNCONFIRMED_MESSAGE)
    }, PASSWORD_SAVE_TIMEOUT_MS)
    void Promise.resolve()
      .then(() => api.setPassword(linkId, next))
      .then(
        (ok) => {
          const current = gen === saveGen.current
          // A password that took is held on screen until Done — taken BEFORE the save's hold goes, so
          // there is no moment in which the drawer may switch to another link and drop it.
          if (ok && current) {
            shownReleaseRef.current?.()
            shownReleaseRef.current = hold?.('shown') ?? null
          }
          settle()
          if (!current) return
          if (ok) {
            // In force either way: shown once. 'unsaved' adds that a restart would undo it.
            setUnsaved(ok === 'unsaved')
            setError(null)
            setShown(next)
            setDraft('')
            setEditing(false)
            setFocusTo('copy')
          } else setError(PASSWORD_CHANGE_FAILED_MESSAGE)
        },
        () => {
          settle()
          if (gen === saveGen.current) setError(PASSWORD_CHANGE_FAILED_MESSAGE)
        }
      )
  }
  const problem = passwordProblemText(draft)
  const showProblem = draft !== '' && problem !== null
  return (
    <div className="live-pop__control">
      {control.locked && (
        <div className="live-pop__locked">
          <p className="live-pop__status" role="status">
            {controlLockedText(control.lockedUntil)}
          </p>
          <button
            type="button"
            className="confirm__btn live-pop__btn"
            disabled={busy}
            onClick={() => run(() => api.allowControl(linkId), CONTROL_CHANGE_FAILED_MESSAGE)}
          >
            Allow control again
          </button>
        </div>
      )}
      <div className="live-pop__toggle">
        <span>
          <span className="live-pop__who">Typing</span>{' '}
          <span className="live-pop__muted">
            {control.enabled ? 'Anyone with the password can type.' : 'Off: viewers can watch and chat.'}
          </span>
        </span>
        {/* `pending`, not `disabled`: a switch the owner just toggled from the keyboard keeps the focus. */}
        <Switch
          checked={control.enabled}
          ariaLabel="Typing"
          pending={busy}
          onChange={(on) => run(() => api.setControl(linkId, on), CONTROL_CHANGE_FAILED_MESSAGE)}
        />
      </div>
      {shown !== null ? (
        <>
          <div className="live-pop__password">
            <PasswordField value={shown} readOnly label="New password" />
            <button type="button" ref={copyRef} className="confirm__btn live-pop__btn" onClick={() => copy(shown)}>
              {copied ? 'Copied!' : 'Copy password'}
            </button>
          </div>
          <p className="live-pop__muted live-pop__note">{PASSWORD_SHOWN_ONCE}</p>
          <p className="live-pop__muted live-pop__note">{PASSWORD_SEPARATE_NOTE}</p>
          <div className="live-pop__actions">
            <button
              type="button"
              className="confirm__btn live-pop__btn"
              onClick={() => {
                shownReleaseRef.current?.()
                shownReleaseRef.current = null
                setShown(null)
                setFocusTo('change')
              }}
            >
              Done
            </button>
          </div>
        </>
      ) : editing ? (
        <>
          <div className="live-pop__password">
            <PasswordField
              inputRef={fieldRef}
              value={draft}
              disabled={busy}
              onChange={setDraft}
              label="New password"
              describedBy={showProblem ? invalidId : undefined}
            />
            <button type="button" className="confirm__btn live-pop__btn" disabled={busy} onClick={() => setDraft(newControlPassword())}>
              Generate
            </button>
          </div>
          {showProblem && (
            <p className="live-pop__invalid" id={invalidId}>
              {problem}
            </p>
          )}
          <p className="live-pop__muted live-pop__note">{PASSWORD_CHANGE_NOTE}</p>
          <div className="live-pop__actions">
            <button
              type="button"
              className="confirm__btn live-pop__btn"
              disabled={busy}
              onClick={() => {
                setEditing(false)
                setDraft('')
                setError(null)
                setFocusTo('change')
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="confirm__btn primary live-pop__btn"
              disabled={busy || problem !== null}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      ) : (
        <div className="live-pop__actions">
          <button
            type="button"
            ref={changeRef}
            className="confirm__btn live-pop__btn"
            onClick={() => {
              setEditing(true)
              setFocusTo('field')
            }}
          >
            Change password…
          </button>
        </div>
      )}
      {unsaved && (
        <div className="live-pop__unsaved" role="alert">
          <p className="live-pop__error">{CONTROL_CHANGE_UNSAVED_MESSAGE}</p>
          <div className="live-pop__actions">
            <button type="button" className="confirm__btn danger live-pop__btn" onClick={stopLink}>
              Stop sharing
            </button>
          </div>
          {stopFailed && <p className="live-pop__error">{STOP_FAILED_MESSAGE}</p>}
        </div>
      )}
      {error && (
        <p className="live-pop__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
