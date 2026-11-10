// Issue #1186: an SSH project's nodes run on the project's host, whatever the shared file says.
import { describe, it, expect } from 'vitest'
import type { CanvasNodeState, Project } from '../shared/types'
import { fileToProject, projectToFile, type ProjectFileV1 } from './workspace-files'

const server = { id: 'mini', label: 'Mini', host: 'mini.local', user: 'host', port: 22 }
const ssh = { server, remoteCwd: '/Users/host/project' }

function file(nodes: CanvasNodeState[]): ProjectFileV1 {
  return {
    version: 1,
    rev: 1,
    savedAt: '2026-10-12T00:00:00.000Z',
    id: 'shared-project',
    name: 'example',
    color: '#10a37f',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes
  } as ProjectFileV1
}

const base = { position: { x: 0, y: 0 }, size: { width: 700, height: 700 }, color: '#10a37f', group: null }

describe('SSH project node routing (issue #1186)', () => {
  it('routes a host-created Codex node (portable cwd, no ssh fields) to the project host', () => {
    // The issue's reproduction, verbatim in shape.
    const p = fileToProject(
      file([{ id: 'term-example', kind: 'terminal', title: 'Codex', cwd: '.', agentId: 'codex', ...base } as CanvasNodeState]),
      { id: 'ssh-viewer', ssh }
    )
    const n = p.nodes[0]
    expect(n.cwd).toBe('/Users/host/project')
    expect(n.sshRemoteTmux).toBe(true)
    expect(n.ssh?.host).toBe('mini.local')
  })

  it('routes a node with no kind (read as terminal) and resolves ./sub and a missing cwd', () => {
    const p = fileToProject(
      file([
        { id: 'a', title: 'A', cwd: './sub/dir', ...base } as CanvasNodeState,
        { id: 'b', kind: 'terminal', title: 'B', ...base } as CanvasNodeState,
        { id: 'c', kind: 'terminal', title: 'C', cwd: 'C:\\Users\\x', ...base } as CanvasNodeState
      ]),
      { id: 'ssh-viewer', ssh }
    )
    expect(p.nodes.map((n) => [n.cwd, n.sshRemoteTmux])).toEqual([
      ['/Users/host/project/sub/dir', true],
      ['/Users/host/project', true],
      ['/Users/host/project', true]
    ])
  })

  it('a forged "local" node cannot opt out: sshRemoteTmux:false is overridden', () => {
    const p = fileToProject(
      file([{ id: 'x', kind: 'terminal', title: 'X', cwd: '/tmp', sshRemoteTmux: false, ...base } as CanvasNodeState]),
      { id: 'ssh-viewer', ssh }
    )
    expect(p.nodes[0].sshRemoteTmux).toBe(true)
    expect(p.nodes[0].ssh?.host).toBe('mini.local')
    expect(p.nodes[0].cwd).toBe('/tmp')
  })

  it('keeps a plain ssh terminal and a foreign host attachment as they are', () => {
    const plain = { id: 'p', kind: 'terminal', title: 'P', ssh: { host: 'other', user: 'u' }, ...base } as CanvasNodeState
    const attached = {
      id: 'q', kind: 'terminal', title: 'Q', cwd: '/srv', sshRemoteTmux: true,
      ssh: { host: 'other', user: 'u' }, ...base
    } as CanvasNodeState
    const p = fileToProject(file([plain, attached]), { id: 'ssh-viewer', ssh })
    expect(p.nodes[0].sshRemoteTmux).toBeUndefined()
    expect(p.nodes[0].ssh?.host).toBe('other')
    expect(p.nodes[1].ssh?.host).toBe('other')
    expect(p.nodes[1].cwd).toBe('/srv')
  })

  it('marks editor/video/files nodes as remote-fs', () => {
    const p = fileToProject(
      file([
        { id: 'e', kind: 'editor', title: 'E', filePath: '/Users/host/project/a.ts', ...base } as CanvasNodeState,
        { id: 'f', kind: 'files', title: 'F', cwd: './src', ...base } as CanvasNodeState,
        { id: 's', kind: 'sticky', title: 'S', ...base } as CanvasNodeState
      ]),
      { id: 'ssh-viewer', ssh }
    )
    expect(p.nodes[0].sshFs).toBe(true)
    expect(p.nodes[1].sshFs).toBe(true)
    expect(p.nodes[1].cwd).toBe('/Users/host/project/src')
    expect(p.nodes[2].sshFs).toBeUndefined()
  })

  it('a LOCAL project is untouched', () => {
    const p = fileToProject(
      file([{ id: 'l', kind: 'terminal', title: 'L', cwd: '.', ...base } as CanvasNodeState]),
      { id: 'local', cwd: '/home/me/proj' }
    )
    expect(p.nodes[0].cwd).toBe('/home/me/proj')
    expect(p.nodes[0].sshRemoteTmux).toBeUndefined()
    expect(p.nodes[0].ssh).toBeUndefined()
  })

  it('the file written to the host carries layout, not this machine routing — and round-trips', () => {
    const project: Project = {
      id: 'ssh-viewer',
      name: 'example',
      color: '#10a37f',
      viewport: { x: 0, y: 0, zoom: 1 },
      ssh,
      nodes: [
        { id: 'own', kind: 'terminal', title: 'Own', cwd: '/Users/host/project/sub', ssh: { ...server }, sshRemoteTmux: true, ...base } as CanvasNodeState,
        { id: 'ed', kind: 'editor', title: 'Ed', filePath: '/Users/host/project/a.ts', sshFs: true, ...base } as CanvasNodeState,
        { id: 'att', kind: 'terminal', title: 'Att', cwd: '/srv', ssh: { host: 'other', user: 'u' }, sshRemoteTmux: true, ...base } as CanvasNodeState
      ]
    }
    const f = projectToFile(project, 3, '2026-10-16T00:00:00.000Z', project.id)
    const own = f.nodes.find((n) => n.id === 'own')!
    expect(own.ssh).toBeUndefined()
    expect(own.sshRemoteTmux).toBeUndefined()
    expect(own.cwd).toBe('./sub')
    expect(f.nodes.find((n) => n.id === 'ed')!.sshFs).toBeUndefined()
    // A foreign attachment keeps its routing: the project cannot tell where it runs.
    expect(f.nodes.find((n) => n.id === 'att')!.sshRemoteTmux).toBe(true)
    // ...and the next load puts it all back.
    const back = fileToProject(f, { id: 'ssh-viewer', ssh })
    expect(back.nodes.find((n) => n.id === 'own')).toMatchObject({ cwd: '/Users/host/project/sub', sshRemoteTmux: true })
    expect(back.nodes.find((n) => n.id === 'ed')!.sshFs).toBe(true)
  })
})
