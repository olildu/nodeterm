import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { Switch } from '@renderer/ui/Switch'
import { useProjects } from '@renderer/state/projects'
import type {
  CloudHandoffAgent,
  CloudHandoffPlan,
  CloudHandoffProgress,
  CloudHandoffVerb,
  CloudHandoffWhere,
  CloudReopenSpec
} from '@shared/types'

/**
 * Fork-only: the top-right Cloud button and its popover — move this tab's Claude agents to the
 * cloud box (oci-arm) and back, by running the user's `cloud-handoff` script through main
 * (main/cloud-handoff.ts). Desktop, local folder tabs only: an SSH or relay tab already runs
 * elsewhere, and a canvas without a folder has nothing to copy.
 */

/* ---------- running hand-offs, per tab (outlive the popover and tab switches) ---------- */

interface Run {
  verb: CloudHandoffVerb
  lines: string[]
  done: boolean
  ok?: boolean
  /** When the last progress line arrived (ms) — the "last update Ns ago" heartbeat. */
  lastAt: number
  startedAt: number
}

interface RunState {
  runs: Record<string, Run>
  start: (tabId: string, verb: CloudHandoffVerb) => void
  push: (p: CloudHandoffProgress) => void
  clear: (tabId: string) => void
}

const useRuns = create<RunState>((set) => ({
  runs: {},
  start: (tabId, verb) =>
    set((s) => ({ runs: { ...s.runs, [tabId]: { verb, lines: [], done: false, lastAt: Date.now(), startedAt: Date.now() } } })),
  push: (p) =>
    set((s) => {
      const now = Date.now()
      const cur = s.runs[p.tabId] ?? { verb: p.verb, lines: [], done: false, lastAt: now, startedAt: now }
      const lines = p.line ? [...cur.lines, p.line].slice(-80) : cur.lines
      return {
        runs: {
          ...s.runs,
          [p.tabId]: { ...cur, lines, lastAt: now, done: !!p.done || cur.done, ok: p.done ? p.ok : cur.ok }
        }
      }
    }),
  clear: (tabId) =>
    set((s) => {
      const { [tabId]: _gone, ...rest } = s.runs
      return { runs: rest }
    })
}))

let progressWired = false
function wireProgress(): void {
  const api = window.nodeTerminal.cloudHandoff
  if (progressWired || !api) return
  progressWired = true
  api.onProgress((p) => useRuns.getState().push(p))
}

/** The button's short label for a running hand-off, from its latest log line. Pure; tested. */
export function runPhase(run: Pick<Run, 'lines' | 'verb'>): string {
  const p = runProgress(run)
  if (p.total && p.stepNo && (p.stepNo === 1 || p.stepNo === 3 || (run.verb !== 'out' && p.stepNo === 2)))
    return `Copying ${p.done ?? 0}/${p.total}`
  return runPhaseText(run)
}

function runPhaseText(run: Pick<Run, 'lines' | 'verb'>): string {
  const last = run.lines[run.lines.length - 1] ?? ''
  const wait = /waiting for (\d+) agent/i.exec(last)
  if (wait) return `Waiting for ${wait[1]} agent${wait[1] === '1' ? '' : 's'}`
  if (/stopping them/i.test(last)) return run.verb !== 'out' ? 'Stopping on the box' : 'Stopping on the Mac'
  if (/final copy|copying|^\s*(up|down) /i.test(last)) return 'Copying'
  if (/continues on/i.test(last)) return run.verb !== 'out' ? 'Resuming on the Mac' : 'Starting on the box'
  return run.verb !== 'out' ? 'Bringing back' : 'Moving'
}

/** Step, file-copy count and current item of a run, from its log. Pure; tested. */
export function runProgress(run: Pick<Run, 'lines'>): {
  step?: string
  stepNo?: number
  steps?: number
  done?: number
  total?: number
  item?: string
} {
  const out: ReturnType<typeof runProgress> = {}
  for (const l of run.lines) {
    const st = /^step (\d+) of (\d+): (.*)$/i.exec(l.trim())
    if (st) {
      out.stepNo = Number(st[1])
      out.steps = Number(st[2])
      out.step = st[3]
      out.done = undefined
      out.total = undefined
      out.item = undefined
    }
    const fc = /\[(\d+)\/(\d+)\] files: (.*)$/.exec(l)
    if (fc) {
      out.done = Number(fc[1])
      out.total = Number(fc[2])
      out.item = fc[3]
    }
    const wait = /waiting for (\d+) agent/i.exec(l)
    if (wait) out.item = `${wait[1]} agent${wait[1] === '1' ? '' : 's'} still finishing`
  }
  return out
}

function secs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

/** No progress line for this long reads as possibly stuck (a big first copy can legitimately be slow). */
const QUIET_WARN_MS = 3 * 60 * 1000

/** Cancel is offered only while nothing has been stopped: copying and waiting are safe to abandon. */
export function canCancel(run: Pick<Run, 'lines' | 'done'>): boolean {
  return !run.done && !run.lines.some((l) => /stopping them|cancel asked|cancelled/i.test(l))
}

function RunProgress({ run, onCancel }: { run: Run; onCancel: () => void }): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (run.done) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [run.done])
  const p = runProgress(run)
  const quiet = now - run.lastAt
  const pct = p.total ? Math.round(((p.done ?? 0) / p.total) * 100) : null
  return (
    <div className={`cloud-pop__progress${run.done && run.ok === false ? ' cloud-pop__progress--bad' : ''}`}>
      <div className="cloud-pop__progress-head">
        <span className="cloud-pop__progress-step">
          {run.done
            ? run.ok
              ? 'Done'
              : 'Stopped with an error'
            : p.stepNo
              ? `Step ${p.stepNo} of ${p.steps} · ${p.step}`
              : 'Starting…'}
        </span>
        <span className="cloud-pop__progress-time">{secs((run.done ? run.lastAt : now) - run.startedAt)}</span>
      </div>
      {!run.done && pct !== null && (
        <div className="cloud-pop__bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
      {!run.done && (p.item || p.total) ? (
        <div className="cloud-pop__progress-item">
          {p.total ? `${p.done} of ${p.total} · ` : ''}
          {p.item}
        </div>
      ) : null}
      {!run.done && (
        <div className={`cloud-pop__progress-beat${quiet > QUIET_WARN_MS ? ' cloud-pop__progress-beat--warn' : ''}`}>
          {quiet > QUIET_WARN_MS
            ? `No update for ${secs(quiet)}. A big first copy can be this slow; if it stays like this, it may be stuck.`
            : `Last update ${secs(quiet)} ago`}
        </div>
      )}
      {canCancel(run) && (
        <button className="cloud-pop__link cloud-pop__cancel" onClick={onCancel}>
          Cancel (nothing has been stopped yet)
        </button>
      )}
      <details className="cloud-pop__details">
        <summary>Log</summary>
        <div className="cloud-pop__log-lines">
          {run.lines.slice(-30).map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      </details>
    </div>
  )
}

const STATUS_WORDS: Record<string, string> = {
  held: 'waiting to start',
  closed: 'closed',
  idle: 'idle',
  done: 'idle',
  busy: 'working · moves when done',
  stopped: 'not running',
  working: 'working',
  starting: 'starting',
  'needs-you': 'needs you',
  limited: 'waiting for the usage limit',
  stuck: 'no progress for a while'
}

function statusTone(status: string): 'ok' | 'busy' | 'bad' | 'off' {
  if (status === 'idle' || status === 'done') return 'ok'
  if (status === 'busy' || status === 'working' || status === 'starting' || status === 'limited') return 'busy'
  if (status === 'needs-you' || status === 'stuck') return 'bad'
  return 'off'
}

function ago(iso?: string | null): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`
}

export const IconCloud = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.2 9.1 4.5 4.5 0 0 0 7 18z" />
    <path d="M12 15v-5M9.8 12.2 12 10l2.2 2.2" />
  </svg>
)

const IconSpin = (): React.JSX.Element => (
  <svg className="cloud-btn__spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 3.75a8.25 8.25 0 1 0 8.25 8.25" />
  </svg>
)

/* ---------- the button ---------- */

export function CloudHandoffButton({
  projectId,
  hasNode,
  onReopen
}: {
  projectId: string
  /** Is this node id on the canvas right now? */
  hasNode: (id: string) => boolean
  /** Put a closed agent node back, showing its box session; returns the new node's id. */
  onReopen: (spec: CloudReopenSpec) => string
}): React.JSX.Element | null {
  const api = window.nodeTerminal.cloudHandoff
  const eligible = useProjects((s) => {
    const p = s.projects.find((x) => x.id === projectId)
    return !!(p && p.cwd && !p.ssh && !p.remote)
  })
  const run = useRuns((s) => s.runs[projectId])
  const [where, setWhere] = useState<CloudHandoffWhere | null>(null)
  const [missing, setMissing] = useState(false)
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null)

  const refreshWhere = useCallback(async () => {
    if (!api || !eligible) return
    const r = await api.run({ verb: 'where', tabId: projectId })
    if (r.notInstalled) setMissing(true)
    setWhere(r.ok ? (r.data as CloudHandoffWhere) : null)
  }, [api, eligible, projectId])

  useEffect(() => {
    wireProgress()
    setWhere(null)
    void refreshWhere()
    const t = setInterval(() => void refreshWhere(), 15000)
    return () => clearInterval(t)
  }, [refreshWhere])

  // A run that just finished changes where the tab is.
  useEffect(() => {
    if (run?.done) void refreshWhere()
  }, [run?.done, refreshWhere])

  if (!api || !eligible || missing) return null
  const moving = !!run && !run.done
  const onBox = where?.where && where.where !== 'mac'
  const cls = moving ? 'cloud-btn cloud-btn--moving' : onBox ? 'cloud-btn cloud-btn--box' : 'cloud-btn'
  const label = moving ? runPhase(run) : onBox ? `On ${where?.where} · ${where?.agents ?? 0}` : 'Cloud'

  return (
    <>
      <button
        className={cls}
        title={onBox ? `This tab runs on ${where?.where}` : 'Move this tab’s agents to the cloud box'}
        aria-label={label}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAnchor((cur) => (cur ? null : { right: r.right, bottom: r.bottom }))
        }}
      >
        {moving ? <IconSpin /> : <IconCloud />}
        <span className="cloud-btn__label">{label}</span>
      </button>
      {anchor && (
        <CloudHandoffPopover
          projectId={projectId}
          anchor={anchor}
          onClose={() => setAnchor(null)}
          onChanged={refreshWhere}
          hasNode={hasNode}
          onReopen={onReopen}
        />
      )}
    </>
  )
}

function AgentList({
  agents,
  onBox,
  hasNode,
  onReopen,
  onReconnect
}: {
  agents: CloudHandoffAgent[]
  onBox: boolean
  hasNode: (id: string) => boolean
  onReopen: (agentNode: string, spec: CloudReopenSpec) => void
  onReconnect: (node: string) => void
}): React.JSX.Element {
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  const [reconnecting, setReconnecting] = useState<Set<string>>(() => new Set())
  return (
    <ul className="cloud-pop__agents">
      {agents.map((a) => (
        <li key={a.node} className="cloud-pop__agent">
          <span className={`cloud-pop__dot cloud-pop__dot--${statusTone(a.status)}`} />
          <div className="cloud-pop__agent-main">
            <div className="cloud-pop__agent-row">
              <span className="cloud-pop__agent-name">{a.title}</span>
              {onBox && a.reopen && !a.closed && (!hasNode(a.canvas || a.node) || opened.has(a.node)) ? (
                <button
                  className="cloud-pop__open"
                  title="Its node was closed. Put it back on the canvas, showing the agent on the box."
                  disabled={opened.has(a.node)}
                  onClick={() => {
                    if (a.reopen) onReopen(a.node, a.reopen)
                    setOpened((cur) => new Set(cur).add(a.node))
                  }}
                >
                  {opened.has(a.node) ? 'Opened' : 'Open'}
                </button>
              ) : onBox && !a.closed && a.attached === false && hasNode(a.canvas || a.node) ? (
                <button
                  className="cloud-pop__open"
                  title="Its node is not showing the agent on the box (after a Mac restart, or a stopped connection)."
                  disabled={reconnecting.has(a.node)}
                  onClick={() => {
                    onReconnect(a.node)
                    setReconnecting((cur) => new Set(cur).add(a.node))
                  }}
                >
                  {reconnecting.has(a.node) ? 'Reconnecting' : 'Reconnect'}
                </button>
              ) : (
                <span className="cloud-pop__agent-state">{STATUS_WORDS[a.status] ?? a.status}</span>
              )}
            </div>
            {onBox && (a.summary || a.commits) ? (
              <div className="cloud-pop__agent-sub">
                {a.commits ? `${a.commits} commit${a.commits === 1 ? '' : 's'} · ` : ''}
                {a.summary ?? ''}
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}

/* ---------- the popover ---------- */

function CloudHandoffPopover({
  projectId,
  anchor,
  onClose,
  onChanged,
  hasNode,
  onReopen
}: {
  projectId: string
  anchor: { right: number; bottom: number }
  onClose: () => void
  onChanged: () => void
  hasNode: (id: string) => boolean
  onReopen: (spec: CloudReopenSpec) => string
}): React.JSX.Element {
  const api = window.nodeTerminal.cloudHandoff!
  const run = useRuns((s) => s.runs[projectId])
  const [plan, setPlan] = useState<CloudHandoffPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const [queueNode, setQueueNode] = useState('')
  const [queueText, setQueueText] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const alive = useRef(true)

  const load = useCallback(async () => {
    const r = await api.run({ verb: 'plan', tabId: projectId })
    if (!alive.current) return
    if (r.ok) {
      setPlan(r.data as CloudHandoffPlan)
      setError(null)
    } else setError(r.error || 'Could not read the tab’s state.')
  }, [api, projectId])

  useEffect(() => {
    alive.current = true
    void load()
    const t = setInterval(() => void load(), 10000)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      alive.current = false
      clearInterval(t)
      window.removeEventListener('keydown', onKey)
    }
  }, [load, onClose])

  useEffect(() => {
    if (run?.done) {
      void load()
      onChanged()
    }
  }, [run?.done, load, onChanged])

  const moving = !!run && !run.done
  const onBox = !!plan && plan.where !== 'mac'
  const host = plan?.host ?? 'oci-arm'
  const name = plan?.tab.name ?? ''
  const all: CloudHandoffAgent[] = plan?.agents ?? []
  const agents = all.filter((a) => !a.station)
  const stations = all.filter((a) => a.station && !a.closed)
  const closedStations = all.filter((a) => a.station && a.closed).length
  const trees = (plan?.repos ?? []).reduce((n, r) => n + r.trees, 0)
  const blocked = !plan || plan.problems.length > 0 || agents.length === 0

  const reopen = (agentNode: string, spec: CloudReopenSpec): void => {
    const canvasNode = onReopen(spec)
    void api.run({ verb: 'bind', tabId: projectId, node: agentNode, canvasNode }).then((r) => {
      if (!r.ok) setNote(r.error || 'Could not link the reopened node to its agent.')
    })
  }
  const reconnect = (node: string): void => {
    void api.run({ verb: 'reconnect', tabId: projectId, node }).then((r) => {
      if (!r.ok) setNote(r.error || 'Could not reconnect.')
      else setTimeout(() => void load(), 3000)
    })
  }
  const cancelRun = (): void => {
    void api.run({ verb: 'cancel', tabId: projectId })
  }
  const macChanged = !!run?.done && run.ok === false && run.lines.some((l) => /changed on the Mac since the hand-off/i.test(l))

  const startRun = (verb: 'out' | 'back' | 'back-force'): void => {
    useRuns.getState().start(projectId, verb)
    void api.run({ verb, tabId: projectId }).then((r) => {
      if (!r.ok && r.error) useRuns.getState().push({ tabId: projectId, verb, line: r.error })
    })
  }

  const sendQueue = async (): Promise<void> => {
    const node = queueNode || agents[0]?.node
    if (!node || !queueText.trim()) return
    const r = await api.run({ verb: 'queue', tabId: projectId, node, text: queueText })
    if (r.ok) {
      setNote(`Queued for ${agents.find((a) => a.node === node)?.title ?? 'the agent'}.`)
      setQueueText('')
      setQueueOpen(false)
      void load()
    } else setNote(r.error || 'Could not queue the task.')
  }

  const toggleWarm = async (on: boolean): Promise<void> => {
    const r = await api.run({ verb: on ? 'warm-on' : 'warm-off', tabId: projectId })
    if (!r.ok) setNote(r.error || 'Could not change background sync.')
    void load()
  }

  return createPortal(
    <>
      <div className="phone-pair__backdrop" onClick={onClose} />
      <div
        className="cloud-pop"
        role="dialog"
        aria-label="Cloud hand-off"
        style={{ top: anchor.bottom + 8, right: Math.max(8, window.innerWidth - anchor.right) }}
      >
        <div className="cloud-pop__head">
          <div className="cloud-pop__title">
            {!plan ? 'Cloud' : onBox ? `${name} is on ${host}` : `Move ${name} to ${host}`}
          </div>
          <div className="cloud-pop__sub">
            {!plan
              ? error ?? 'Reading the tab…'
              : onBox
                ? `Since ${plan.at ?? '—'}. Bringing it back waits for each agent to finish, then continues here.`
                : 'Each agent finishes its reply, then continues on the box. The Mac can sleep after the copy.'}
          </div>
        </div>

        {agents.length > 0 && <AgentList agents={agents} onBox={onBox} hasNode={hasNode} onReopen={reopen} onReconnect={reconnect} />}
        {stations.length > 0 && (
          <div className="cloud-pop__group">
            <div className="cloud-pop__group-title">
              Stations opened on {host}
              {closedStations ? <span className="cloud-pop__group-sub"> · {closedStations} closed</span> : null}
            </div>
            <AgentList agents={stations} onBox={onBox} hasNode={hasNode} onReopen={reopen} onReconnect={reconnect} />
          </div>
        )}

        {plan && (
          <div className="cloud-pop__facts">
            <span>
              {plan.repos && plan.repos.length ? (
                <>
                  Repos:{' '}
                  <b title={plan.repos.map((r) => `${r.name} (${r.trees})`).join(', ')}>
                    {plan.repos.length} · {trees} tree{trees === 1 ? '' : 's'}
                  </b>
                </>
              ) : (
                <>
                  Folders: <b>{plan.folders.length}</b>
                </>
              )}
            </span>
            {plan.free_mb != null && (
              <span>
                {host}: <b>{(plan.free_mb / 1024).toFixed(1)} GB free</b>
              </span>
            )}
            <span>
              Queued next: <b>{plan.queued ? `${plan.queued} task${plan.queued === 1 ? '' : 's'}` : 'none'}</b>
            </span>
            {!onBox && (
              <span>
                Last warm sync: <b>{ago(plan.last_sync)}</b>
              </span>
            )}
          </div>
        )}

        {plan && plan.problems.length > 0 && !onBox && (
          <ul className="cloud-pop__problems">
            {plan.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}

        {run && <RunProgress run={run} onCancel={cancelRun} />}
        {macChanged && (
          <div className="cloud-pop__note cloud-pop__note--warn">
            Files changed on the Mac while the tab was on the box. Bringing it back overwrites them; the Mac
            version is saved first (as a git ref and a backup file), so nothing is lost.
            <div>
              <button className="cloud-pop__btn" onClick={() => startRun('back-force')}>
                Bring back anyway
              </button>
            </div>
          </div>
        )}

        {queueOpen && (
          <div className="cloud-pop__queue">
            {agents.length > 1 && (
              <select value={queueNode || agents[0]?.node} onChange={(e) => setQueueNode(e.target.value)} aria-label="Agent">
                {agents.map((a) => (
                  <option key={a.node} value={a.node}>
                    {a.title}
                  </option>
                ))}
              </select>
            )}
            <input
              autoFocus
              value={queueText}
              placeholder="Next task, given when the agent goes idle"
              aria-label="Next task"
              onChange={(e) => setQueueText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void sendQueue()
              }}
            />
          </div>
        )}
        {note && <div className="cloud-pop__note">{note}</div>}

        {plan && !onBox && (
          <div className="cloud-pop__row">
            <div>
              <div className="cloud-pop__row-title">Keep {host} warm</div>
              <div className="cloud-pop__row-sub">Copies this tab every 20 min, so a move only sends the last few changes.</div>
            </div>
            <Switch checked={plan.warm} onChange={(v) => void toggleWarm(v)} />
          </div>
        )}

        <div className="cloud-pop__actions">
          {onBox && plan && (
            <button className="cloud-pop__link" onClick={() => window.nodeTerminal.shell.openExternal(plan.site)}>
              Status page
            </button>
          )}
          <span className="cloud-pop__spacer" />
          {queueOpen ? (
            <>
              <button className="cloud-pop__btn" onClick={() => setQueueOpen(false)}>
                Cancel
              </button>
              <button className="cloud-pop__btn" disabled={!queueText.trim()} onClick={() => void sendQueue()}>
                Queue
              </button>
            </>
          ) : (
            <button className="cloud-pop__btn" disabled={!plan || agents.length === 0} onClick={() => setQueueOpen(true)}>
              Queue a task…
            </button>
          )}
          {!queueOpen &&
            (onBox ? (
              <button className="cloud-pop__btn cloud-pop__btn--primary" disabled={moving} onClick={() => startRun('back')}>
                Bring back to Mac
              </button>
            ) : (
              <button className="cloud-pop__btn cloud-pop__btn--primary" disabled={moving || blocked} onClick={() => startRun('out')}>
                Move to {host}
              </button>
            ))}
        </div>
      </div>
    </>,
    document.body
  )
}
