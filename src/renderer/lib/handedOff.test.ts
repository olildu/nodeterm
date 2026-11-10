import { describe, it, expect } from 'vitest'
import { handedOffWarning } from './handedOff'

const P = { name: 'proj', ssh: { server: { host: 'box', user: 'alice' }, remoteCwd: '~/proj' } } as never
describe('handedOffWarning', () => {
  it('null for a project that was never handed off', () => expect(handedOffWarning(P, null)).toBeNull())
  it('names the team and the host, and says the server keeps the project after an unshare', () => {
    const w = handedOffWarning({ ...(P as object), handedOffTo: { hostId: 'H', projectId: 'project-9', at: 1 } } as never, 'Box team')
    expect(w).toBe(
      'proj was handed to team Box team on box. The server keeps its canvas and keeps running its agents, even after it is unshared. ' +
        'Opening it here gives one canvas two editors that can overwrite each other, and its agents would start the same conversations the server is running.\n\n' +
        'Open it here anyway? Its agents are not resumed here automatically.'
    )
  })
  it('points at no way out that does not exist after an unshare (no team tab, no unshare command)', () => {
    const w = handedOffWarning({ ...(P as object), handedOffTo: { hostId: 'H', projectId: 'project-9', at: 1 } } as never, 'Box team')
    expect(w).not.toMatch(/team tab/)
    expect(w).not.toMatch(/team unshare/)
  })
  it('an unfinished handover says so', () => {
    expect(handedOffWarning({ ...(P as object), handedOffTo: { at: 1 } } as never, null)).toMatch(/^Sharing proj with a team did not finish\./)
  })
  it('the unfinished copy is the whole sentence pair, and ignores any team label', () => {
    expect(handedOffWarning({ ...(P as object), handedOffTo: { at: 1 } } as never, 'Box team')).toBe(
      'Sharing proj with a team did not finish. If the server already took it over, opening it here gives one canvas two editors that can overwrite each other, and its agents would start the same conversations the server is running.\n\n' +
        'Open it here anyway? Its agents are not resumed here automatically.'
    )
  })
  it('an unknown or blank team label falls back to the generic name', () => {
    const p = { ...(P as object), handedOffTo: { hostId: 'H', projectId: 'project-9', at: 1 } } as never
    expect(handedOffWarning(p, null)).toMatch(/^proj was handed to team the hosted team on box\./)
    expect(handedOffWarning(p, '  ')).toMatch(/^proj was handed to team the hosted team on box\./)
  })
  it('a finished handover with no server project id reads the same', () => {
    const withId = handedOffWarning({ ...(P as object), handedOffTo: { hostId: 'H', projectId: 'project-9', at: 1 } } as never, 'Box team')
    const without = handedOffWarning({ ...(P as object), handedOffTo: { hostId: 'H', at: 1 } } as never, 'Box team')
    expect(without).toBe(withId)
  })
})
