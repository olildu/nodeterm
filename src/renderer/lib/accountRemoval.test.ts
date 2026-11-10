import { describe, expect, it } from 'vitest'
import { otherProjectSessions, removalBlockedText, type RemovalNode } from './accountRemoval'

const claude = (id: string, accountId?: string, extra: Partial<RemovalNode> = {}): RemovalNode => ({
  id,
  agentId: 'claude',
  accountId,
  login: false,
  ...extra
})

describe('otherProjectSessions', () => {
  const base = {
    accountId: 'acc',
    activeProjectId: 'active',
    stateOf: (): string | undefined => undefined,
    sessionIdOf: (id: string): string | undefined => `sid-${id}`
  }

  it('collects the account’s Claude sessions outside the active project', () => {
    const r = otherProjectSessions({
      ...base,
      projects: [
        { id: 'active', nodes: [claude('a1', 'acc')] },
        { id: 'p2', nodes: [claude('b1', 'acc'), claude('b2', 'other'), claude('b3')] }
      ]
    })
    expect(r).toEqual({ ready: [{ projectId: 'p2', nodeId: 'b1', sessionId: 'sid-b1' }], busy: [] })
  })

  it('skips login nodes, plain terminals and other agents', () => {
    const r = otherProjectSessions({
      ...base,
      projects: [
        {
          id: 'p2',
          nodes: [
            claude('login', 'acc', { login: true }),
            { id: 'shell', accountId: 'acc', login: false },
            claude('cx', 'acc', { agentId: 'codex' })
          ]
        }
      ]
    })
    expect(r.ready).toEqual([])
  })

  it('only looks at projects on the account’s own machine', () => {
    const r = otherProjectSessions({
      ...base,
      accountHost: 'root@box',
      projects: [
        { id: 'local', nodes: [claude('l1', 'acc')] },
        { id: 'other-host', hostKey: 'root@elsewhere', nodes: [claude('o1', 'acc')] },
        { id: 'host', hostKey: 'root@box', nodes: [claude('h1', 'acc')] }
      ]
    })
    expect(r.ready.map((s) => s.nodeId)).toEqual(['h1'])
  })

  it('reports working and blocked sessions as busy', () => {
    const states: Record<string, string> = { b1: 'working', b2: 'blocked', b3: 'waiting' }
    const r = otherProjectSessions({
      ...base,
      stateOf: (id) => states[id],
      projects: [{ id: 'p2', nodes: [claude('b1', 'acc'), claude('b2', 'acc'), claude('b3', 'acc')] }]
    })
    expect(r.busy).toEqual(['b1', 'b2'])
    expect(r.ready.map((s) => s.nodeId)).toEqual(['b3'])
  })
})

describe('removalBlockedText', () => {
  it('is null when nothing blocks the removal', () => {
    expect(removalBlockedText('Work', 0, 0)).toBeNull()
  })
  it('names busy sessions before stuck ones', () => {
    expect(removalBlockedText('Work', 2, 1)).toMatch(/^2 sessions on "Work" are working/)
    expect(removalBlockedText('Work', 0, 1)).toMatch(/^1 session on "Work" could not be moved/)
  })
})
