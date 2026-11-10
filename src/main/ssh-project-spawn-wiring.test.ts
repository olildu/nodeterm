// Issue #1186: the core refusal "a node owned by an SSH project is never spawned locally" only exists
// when a shell WIRES the index predicate into PtyManager — an unwired setter compiles and does
// nothing. Pinned at source level, like the other wire tests in this directory.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (rel: string): string =>
  readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

describe('SSH-project spawn refusal wiring (issue #1186)', () => {
  it('both shells wire setSshProjectCheck to the index', () => {
    for (const file of ['main/index.ts', 'server/index.ts']) {
      expect(read(file)).toMatch(
        /ptyManager\.setSshProjectCheck\(\(projectId\) => workspaceStore\.sshProjectIds\(\)\.includes\(projectId\)\)/
      )
    }
  })

  it('both spawn sites forward the in-memory local-login mark, and only Canvas sets it', () => {
    expect(read('renderer/nodes/TerminalNode.tsx')).toMatch(/isLocalOnSshCanvas\(id\) \? \{ localOnSshCanvas: true \}/)
    expect(read('renderer/components/kanban/ModalTerminal.tsx')).toMatch(
      /isLocalOnSshCanvas\(nodeId\) \? \{ localOnSshCanvas: true \}/
    )
    const canvas = read('renderer/canvas/Canvas.tsx')
    expect(canvas.match(/markLocalOnSshCanvas\(login\.id\)/g)?.length).toBe(2)
  })
})
