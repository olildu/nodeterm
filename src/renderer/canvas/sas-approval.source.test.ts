import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the SAS approval glue in Canvas.tsx (no render harness for a 20,000-line
 * component). The behaviour is proven elsewhere: the admission rule in
 * `lib/pendingPeerAdmission.test.ts`, the dialog copy in `shared/remote/approval.test.ts`. What only
 * a source read can pin is that Canvas USES them:
 *   - both sources of a host approval (the relay tunnel and the legacy phone host) go through
 *     `offerPendingPeer`, so a second device can never swap the digits under the human comparing
 *     the first device's code;
 *   - the joiner's own prompt carries SAS_COMPARE_HINT under the code, on both branches.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function between(start: string, end: string): string {
  const a = src.indexOf(start)
  expect(a, start).toBeGreaterThan(-1)
  const b = src.indexOf(end, a + start.length)
  expect(b, end).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('SAS approval glue in Canvas', () => {
  it('every pending-peer subscription offers through the admission rule, never straight into the slot', () => {
    for (const sub of ['relayHost.onPeerPending((info) =>', 'remoteHost.onPeerPending((info) =>']) {
      const body = between(sub, ')\n')
      expect(body, sub).toContain('offerPendingPeer(')
      expect(body, sub).not.toContain('setPendingPeer(')
    }
    const offer = between('const offerPendingPeer = useCallback(', '[setPendingPeer]')
    expect(offer).toContain('admitPendingPeer(pendingPeerRef.current, next)')
    expect(offer).toMatch(/verdict === 'refuse'[\s\S]*remoteHost\.reject\(next\.id/)
  })

  it('the ref the rule reads is written by the one setter', () => {
    const setter = between('const setPendingPeer = useCallback(', '}, [])')
    expect(setter).toContain('pendingPeerRef.current = v')
    expect(src.match(/pendingPeerRef\.current = /g)).toHaveLength(1)
  })

  it('the joiner prompt shows the comparison rule under the code on both branches', () => {
    const body = between('const question = hosted', 'if (sas && window.confirm(question))')
    expect(body.match(/\$\{sas\}\\n\\n\$\{SAS_COMPARE_HINT\}/g)).toHaveLength(2)
  })
})
