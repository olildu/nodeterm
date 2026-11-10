import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for two agent-node funnels in an SSH project — the same class of test as
 * `control-cold-open.source.test.ts`: both live inside Canvas.tsx callbacks with no unit seam, and
 * what they must be pinned on is which `ssh` argument they hand `createAgentNode`. The behavioural
 * half (a `nodeSshFor` binding yields a remote-tmux node rooted at the given cwd) is proven against
 * the real factory in `state/workspace.test.ts` → `nodeSshFor`.
 *
 * THE BUGS (both the shapes `nodeSshFor`'s doc warns about):
 *  - Source Control → commit → "Explain changes with AI" passed NO binding, so in an SSH project the
 *    agent opened on this machine in the host's path: the pty fell back to $HOME and `git show` ran
 *    outside any checkout.
 *  - Transfer to agent passed the project's binding UNCHANGED, so a source running in a subfolder
 *    (canvas-control `--cwd`) handed off to an agent rooted at the project's `remoteCwd`.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** One `useCallback` body: from `const <name> = useCallback(` to the next top-level callback. */
function callbackBody(name: string): string {
  const start = src.indexOf(`const ${name} = useCallback(`)
  expect(start, name).toBeGreaterThan(-1)
  const end = src.indexOf('\n  const ', start + 1)
  expect(end, `the declaration after ${name}`).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('agent nodes opened from an SSH project run on its host (source pins)', () => {
  it('Explain changes with AI binds the node to the project host', () => {
    const body = callbackBody('explainCommit')
    expect(body).toContain('createAgentNode(')
    expect(body).toContain('nodeSshFor(project?.ssh)')
  })

  it("Transfer to agent keeps the source's remote cwd", () => {
    const body = callbackBody('transferConversation')
    expect(body).toContain('nodeSshFor(projectSsh, source.data.cwd)')
    expect(body).not.toMatch(/sshRemoteTmux \? projectSsh :/)
  })
})
