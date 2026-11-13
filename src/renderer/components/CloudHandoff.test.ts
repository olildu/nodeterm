import { describe, expect, it } from 'vitest'
import { canCancel, runPhase, runProgress } from './CloudHandoff'

describe('runPhase', () => {
  const run = (verb: 'out' | 'back', last: string) => ({ verb, lines: [last], done: false })
  it('names what the move is doing from its latest line', () => {
    expect(runPhase(run('out', 'waiting for 1 agent(s) on the Mac to finish their reply: A'))).toBe('Waiting for 1 agent')
    expect(runPhase(run('out', 'waiting for 2 agent(s) on oci-arm'))).toBe('Waiting for 2 agents')
    expect(runPhase(run('out', 'final copy'))).toBe('Copying')
    expect(runPhase(run('out', 'all idle; stopping them here'))).toBe('Stopping on the Mac')
    expect(runPhase(run('back', 'all idle; stopping them on oci-arm'))).toBe('Stopping on the box')
    expect(runPhase(run('back', '  A continues on the Mac'))).toBe('Resuming on the Mac')
    expect(runPhase(run('out', 'moving tab x to oci-arm'))).toBe('Moving')
  })
})

describe('runProgress', () => {
  it('reads the step, the file count and the current item', () => {
    const lines = [
      'moving tab x to oci-arm: 2 agent(s), 3 repo(s), 35 tree(s)',
      'step 1 of 4: copying while the agents work (history comes from GitHub on the box)',
      '  [11/36] files: device_app-adapters-image',
      '  [12/36] files: device_app-adapters-pins'
    ]
    expect(runProgress({ lines })).toMatchObject({ stepNo: 1, steps: 4, done: 12, total: 36, item: 'device_app-adapters-pins' })
    expect(runPhase({ verb: 'out', lines })).toBe('Copying 12/36')
  })
  it('a new step resets the count', () => {
    const lines = ['step 1 of 4: copying', '  [36/36] files: x', 'step 2 of 4: waiting for every agent to finish its reply',
      'waiting for 1 agent(s) on the Mac to finish their reply: A']
    expect(runProgress({ lines })).toMatchObject({ stepNo: 2, total: undefined, item: '1 agent still finishing' })
    expect(runPhase({ verb: 'out', lines })).toBe('Waiting for 1 agent')
  })
})

describe('canCancel', () => {
  it('only before anything has been stopped', () => {
    expect(canCancel({ done: false, lines: ['step 2 of 4: waiting for every agent to finish its reply'] })).toBe(true)
    expect(canCancel({ done: false, lines: ['all idle; stopping them here'] })).toBe(false)
    expect(canCancel({ done: true, lines: [] })).toBe(false)
  })
})
