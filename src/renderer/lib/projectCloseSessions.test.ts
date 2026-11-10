import { describe, it, expect } from 'vitest'
import {
  closeConfirmCopy,
  closedSessionCounts,
  deleteConfirmCopy,
  planProjectClose,
  terminalNodeIds
} from './projectCloseSessions'

const project = (opts: {
  name?: string
  nodes?: { id: string; kind?: string }[]
  remote?: boolean
  ssh?: { label?: string; user?: string; host?: string }
}): any => ({
  name: opts.name ?? 'Web',
  remote: opts.remote,
  ssh: opts.ssh ? { server: { user: 'u', host: 'h', ...opts.ssh }, remoteCwd: '/srv' } : undefined,
  nodes: (opts.nodes ?? []).map((n) => ({
    id: n.id,
    kind: n.kind,
    title: n.id,
    position: { x: 0, y: 0 }
  }))
})

describe('terminalNodeIds / planProjectClose', () => {
  it('counts terminal-kind nodes only — the exact set the end action addresses', () => {
    const p = project({
      nodes: [
        { id: 't1', kind: 'terminal' },
        { id: 't2', kind: 'terminal' },
        { id: 's1', kind: 'sticky' },
        { id: 'g1', kind: 'group' }
      ]
    })
    expect(terminalNodeIds(p)).toEqual(['t1', 't2'])
    expect(planProjectClose(p)).toEqual({ kind: 'confirm', sessionCount: 2 })
  })

  it('a missing kind defaults to terminal — the serializer backward-compat rule', () => {
    expect(terminalNodeIds(project({ nodes: [{ id: 'legacy' }] }))).toEqual(['legacy'])
  })

  it('closes silently when there is nothing to tell the user about', () => {
    expect(planProjectClose(undefined)).toEqual({ kind: 'silent' })
    expect(planProjectClose(project({ nodes: [] }))).toEqual({ kind: 'silent' })
    expect(planProjectClose(project({ nodes: [{ id: 's', kind: 'sticky' }] }))).toEqual({
      kind: 'silent'
    })
  })

  it('a relay tab closes silently — its sessions belong to the host machine', () => {
    expect(
      planProjectClose(project({ remote: true, nodes: [{ id: 't1', kind: 'terminal' }] }))
    ).toEqual({ kind: 'silent' })
  })
})

describe('closeConfirmCopy', () => {
  it('names the count in the message, the option and the destructive confirm label', () => {
    const c = closeConfirmCopy('Web', 3)
    expect(c.message).toContain('Close “Web”?')
    expect(c.message).toContain('3 terminal sessions will keep running')
    expect(c.message).toContain('Recently closed')
    expect(c.optionLabel).toContain('End its 3 sessions too')
    expect(c.confirmKeep).toBe('Close')
    expect(c.confirmEnd).toBe('Close & end 3 sessions')
  })

  it('reads naturally in the singular', () => {
    const c = closeConfirmCopy('Web', 1)
    expect(c.message).toContain('1 terminal session will keep')
    expect(c.optionLabel).toContain('End its session too')
    expect(c.confirmEnd).toBe('Close & end 1 session')
  })
})

describe('deleteConfirmCopy', () => {
  it('local delete: names the sessions it ends and what stays on disk', () => {
    const c = deleteConfirmCopy(project({ nodes: [{ id: 't1' }, { id: 't2' }] }))
    expect(c.message).toContain('Delete “Web”?')
    expect(c.message).toContain('ends its 2 terminal sessions and removes the project')
    expect(c.message).toContain('.nodeterm/project.json) is not deleted')
    expect(c.danger).toBe(true)
    expect(c.confirmLabel).toBe('Delete')
  })

  it('a project stored in app data: says the canvas goes with it (#1145)', () => {
    const c = deleteConfirmCopy({ ...project({ nodes: [{ id: 't1' }] }), storeInAppData: true })
    expect(c.message).toContain('not deleted, but the canvas, project settings, board log and whiteboards it kept in app data are.')
    expect(c.message).not.toContain('.nodeterm/project.json')
  })

  it('ssh delete: names the host the sessions end on (label preferred)', () => {
    const c = deleteConfirmCopy(project({ nodes: [{ id: 't1' }], ssh: { label: 'prod' } }))
    expect(c.message).toContain('ends its 1 terminal session on prod')
    expect(c.message).toContain('The folder on the server')
    const bare = deleteConfirmCopy(project({ nodes: [{ id: 't1' }], ssh: {} }))
    expect(bare.message).toContain('on u@h')
  })

  it('no sessions: drops the session clause instead of claiming "0 sessions"', () => {
    const c = deleteConfirmCopy(project({ nodes: [{ id: 's', kind: 'sticky' }] }))
    expect(c.message).toContain('Delete “Web”? This removes the project from nodeterm.')
    expect(c.message).not.toContain('session')
  })

  it('relay tab: says it removes only the local view and nothing is destroyed', () => {
    // The #442 follow-up: "Delete" on a host-backed tab drops the reconnect lever, so the next
    // connect re-adopts the host's project. The copy must carry that, and the dialog must not
    // wear danger styling for an action that destroys nothing.
    const c = deleteConfirmCopy(project({ remote: true, nodes: [{ id: 't1' }] }))
    expect(c.message).toContain('removing it only closes the view here')
    expect(c.message).toContain('reconnecting will bring the project back')
    expect(c.confirmLabel).toBe('Remove view')
    expect(c.danger).toBe(false)
  })
})

describe('closedSessionCounts', () => {
  const rows = (...ids: string[]): { nodeId: string }[] => ids.map((nodeId) => ({ nodeId }))

  it('counts live rows per closed project and omits projects with none', () => {
    const closed = [
      { id: 'p1', nodes: [{ id: 'a' }, { id: 'b' }] },
      { id: 'p2', nodes: [{ id: 'c' }] }
    ] as any
    expect(closedSessionCounts(rows('a', 'b', 'x'), closed)).toEqual({ p1: 2 })
  })

  it('first project owning a node id wins — same rule as resolveSessionRows', () => {
    const closed = [
      { id: 'p1', nodes: [{ id: 'a' }] },
      { id: 'p2', nodes: [{ id: 'a' }] }
    ] as any
    expect(closedSessionCounts(rows('a'), closed)).toEqual({ p1: 1 })
  })

  it('no rows → empty map (the caller renders no badge, never "0")', () => {
    expect(closedSessionCounts([], [{ id: 'p1', nodes: [{ id: 'a' }] }] as any)).toEqual({})
  })
})
