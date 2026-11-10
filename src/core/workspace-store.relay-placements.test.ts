// `relayNodePlacements` is what the relay host's attach decides WHERE a phone-opened session runs
// from (core/relay-attach-plan.ts). It must answer EVERY project holding the id — the same committed
// canvas opened in two folders shares node ids — with the node as THAT project recorded it and a
// local ref's portable cwd resolved, because the attach spawns in that cwd.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { testTmpDir } from './test-tmp'
import { WorkspaceStore } from './workspace-store'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'

const node = (id: string, extra: Partial<CanvasNodeState> = {}): CanvasNodeState =>
  ({ id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: id, color: '#fff', group: null, ...extra }) as CanvasNodeState
const project = (id: string, cwd: string | undefined, nodes: CanvasNodeState[]): Project => ({
  id,
  name: id,
  color: '#7aa2f7',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes,
  ...(cwd ? { cwd } : {})
})
const ws = (projects: Project[]): Workspace => ({ version: 2, activeProjectId: projects[0]?.id ?? '', projects })

beforeEach(() => {
  initPlatform(fakePlatform({ userDataDir: testTmpDir('nt-rp-ws-') }))
})
afterEach(() => resetPlatformForTests())

describe('WorkspaceStore.relayNodePlacements', () => {
  it('answers every project holding the id, with that project’s record and a resolved cwd', async () => {
    const [a, b] = [testTmpDir('nt-rp-a-'), testTmpDir('nt-rp-b-')]
    const store = new WorkspaceStore()
    await store.save(
      ws([
        project('pa', a, [node('shared', { cwd: path.join(a, 'sub'), agentId: 'claude' })]),
        project('pb', b, [node('shared', { agentId: 'codex' }), node('only-b')]),
        project('inline', undefined, [node('only-inline')])
      ])
    )
    const shared = store.relayNodePlacements('shared')
    expect(shared.map((p) => p.projectId)).toEqual(['pa', 'pb'])
    // The shared file stores `./sub`; the attach must spawn in the absolute folder.
    expect(shared[0].node.cwd).toBe(path.join(a, 'sub'))
    expect(shared[0].node.agentId).toBe('claude')
    expect(shared[1].node.agentId).toBe('codex')
    expect(shared.every((p) => p.projectServer === undefined)).toBe(true)
    expect(store.relayNodePlacements('only-inline').map((p) => p.projectId)).toEqual(['inline'])
    expect(store.relayNodePlacements('nope')).toEqual([])
  })
})

// Issue #1186: an SSH project's cache holds the shared file's NEUTRAL form (no routing fields — the
// host's own desktop wrote some of those nodes). Every reader that decides where a node runs must see
// it routed to the project's host, with its cwd resolved against the remote folder.
describe('SSH project nodes read back routed (issue #1186)', () => {
  it('relayNodePlacements and getNodeResolved route a host-created node', async () => {
    const server = { id: 'mini', label: 'Mini', host: 'mini.local', user: 'host', port: 22 }
    const store = new WorkspaceStore()
    await store.save(
      ws([
        {
          ...project('ssh-p', undefined, [node('host-made', { cwd: '.', agentId: 'codex' })]),
          ssh: { server, remoteCwd: '/Users/host/project' }
        }
      ])
    )
    // What landed in the machine-local cache is the neutral form…
    expect(store.getNode('host-made')?.sshRemoteTmux).toBeUndefined()
    // …and what the routing readers see is the host.
    const resolved = store.getNodeResolved('host-made')
    expect(resolved).toMatchObject({ sshRemoteTmux: true, cwd: '/Users/host/project' })
    expect(resolved?.ssh?.host).toBe('mini.local')
    const [placement] = store.relayNodePlacements('host-made')
    expect(placement.projectServer?.host).toBe('mini.local')
    expect(placement.node).toMatchObject({ sshRemoteTmux: true, cwd: '/Users/host/project' })
  })
})
