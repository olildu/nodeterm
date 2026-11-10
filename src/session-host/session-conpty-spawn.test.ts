import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The session host's real spawn (no `proc` override) must spread the Windows ConPTY option the
 * shared helper decides. node-pty and the helper are mocked: this pins the WIRING, the helper's
 * own decision is windows-conpty-dll.test.ts.
 */
const spawned: Array<Record<string, unknown>> = []
let helperAnswer: { useConptyDll?: true } = {}

vi.mock('node-pty', () => ({
  spawn: (_file: string, _args: string[], options: Record<string, unknown>) => {
    spawned.push(options)
    return { pid: 7, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {} }
  }
}))
vi.mock('../core/windows-conpty-dll', () => ({
  windowsConptySpawnOptions: () => helperAnswer
}))

const term = { write: async () => {}, serialize: () => '', resize: () => {}, dispose: () => {} }
const SPAWN = { shell: 'pwsh.exe', args: [], cwd: '.', env: {}, cols: 80, rows: 24 }

describe('HostSession spawn: ConPTY option', () => {
  beforeEach(() => {
    spawned.length = 0
  })

  it('passes useConptyDll when the helper asks for the bundled ConPTY', async () => {
    helperAnswer = { useConptyDll: true }
    const { HostSession } = await import('./session')
    new HostSession('s1', SPAWN, 100, { term: term as never })
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({ name: 'xterm-256color', useConptyDll: true })
  })

  it('adds nothing when the helper answers {} (non-Windows / inbox fallback)', async () => {
    helperAnswer = {}
    const { HostSession } = await import('./session')
    new HostSession('s2', SPAWN, 100, { term: term as never })
    expect(spawned).toHaveLength(1)
    expect('useConptyDll' in spawned[0]).toBe(false)
    expect(Object.keys(spawned[0]).sort()).toEqual(['cols', 'cwd', 'env', 'name', 'rows'])
  })
})
