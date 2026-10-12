import { describe, expect, it } from 'vitest'
import type { SimAgentEvent, SimStatus } from '../../shared/sim'
import { createSimControl } from './control'
import { createSimLinkLedger, SIM_DRIVE_LINGER_MS, SIM_DRIVE_MAX_MS } from './links'
import type { AgentDevice } from './service'

const UDID = 'AE342EEF-B624-4060-B9E6-AE6E9EAAC24A'
const OTHER = '11111111-2222-3333-4444-555555555555'
const live: SimStatus = {
  phase: 'live',
  device: { udid: UDID, name: 'iPhone 15', pixelWidth: 1179, pixelHeight: 2556, pointWidth: 393, pointHeight: 852, scale: 3, ready: true }
}

interface Opts {
  nodes?: Array<{ id: string; title: string; udid?: string }>
  bridges?: Array<{ source: string; target: string }>
  canAutoLink?: boolean
}

function rig(o: Opts = {}) {
  const events: SimAgentEvent[] = []
  const ledger = createSimLinkLedger()
  let t = 1_000_000
  const device: AgentDevice = {
    status: () => live,
    command: async () => ({ ok: true }),
    screenshot: async () => ({ ok: true, format: 'png', width: 10, height: 10, data: new Uint8Array(4) }),
    waitIdle: async () => ({ idle: true, waitedMs: 10, changed: true })
  }
  const nodes = o.nodes ?? [
    { id: 'sim1', title: 'Phone', udid: UDID },
    { id: 'sim2', title: 'Second', udid: OTHER }
  ]
  const control = createSimControl({
    service: {
      availability: () => ({ ok: true }),
      devices: async () => ({
        devices: [
          { udid: UDID, name: 'iPhone 15', runtime: 'iOS 26.5', booted: true },
          { udid: OTHER, name: 'iPhone SE', runtime: 'iOS 26.5', booted: true }
        ]
      }),
      boot: async () => ({ ok: true }),
      agentRun: (async (_u: unknown, _o: unknown, fn: (d: AgentDevice) => Promise<unknown>) => ({
        ok: true,
        value: await fn(device)
      })) as never
    },
    // `agent` and `other` live in p1; `stranger` lives in p2, which has its own device node.
    projectIdOfNode: (id) => (id === 'stranger' ? 'p2' : 'agent' === id || id === 'other' ? 'p1' : undefined),
    simulatorNodes: (pid) => (pid === 'p1' ? nodes : pid === 'p2' ? [{ id: 'simX', title: 'Elsewhere', udid: UDID }] : []),
    projectCwd: () => undefined,
    resolvePath: async (_c, raw) => ({ ok: true, abs: raw }),
    tempDir: () => '/tmp',
    writeFile: async () => undefined,
    bridges: (pid) => (pid === 'p1' ? (o.bridges ?? []) : []),
    canAutoLink: () => o.canAutoLink ?? true,
    emit: (e) => void events.push(e),
    ledger,
    now: () => t
  })
  return {
    run: (args: Record<string, string>, nodeId = 'agent') => control({ nodeId, args, verified: true }),
    events,
    ledger,
    advance: (ms: number) => void (t += ms)
  }
}

const autoLinks = (e: SimAgentEvent[]) => e.filter((x) => x.kind === 'auto-link')
const drives = (e: SimAgentEvent[]) => e.filter((x) => x.kind === 'drive')

describe('the default target: the Simulator node you are linked to', () => {
  it('exactly one linked → no --node/--udid needed', async () => {
    const r = rig({ bridges: [{ source: 'sim1', target: 'agent' }] })
    const reply = await r.run({ describe: '' })
    expect(reply.ok).toBe(true)
  })

  it('reads the link in either direction (a hand-edited file may store agent → device)', async () => {
    const r = rig({ bridges: [{ source: 'agent', target: 'sim1' }] })
    expect((await r.run({ describe: '' })).ok).toBe(true)
  })

  it('none linked and no target → refused with how to get one', async () => {
    const reply = await rig().run({ describe: '' })
    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/sim-no-target/)
    expect(reply.error).toMatch(/--node/)
  })

  it('several linked → refused, listing them', async () => {
    const r = rig({
      bridges: [
        { source: 'sim1', target: 'agent' },
        { source: 'sim2', target: 'agent' }
      ]
    })
    const reply = await r.run({ describe: '' })
    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/sim-ambiguous-target: you are linked to 2/)
    expect(reply.error).toContain('sim1 "Phone"')
    expect(reply.error).toContain('sim2 "Second"')
  })

  it('an explicit --node wins over the link', async () => {
    const r = rig({ bridges: [{ source: 'sim1', target: 'agent' }] })
    const reply = await r.run({ describe: '', node: 'sim2' })
    expect(reply.ok).toBe(true)
  })

  it('only the caller\'s own links count (another agent\'s link is not mine)', async () => {
    const r = rig({ bridges: [{ source: 'sim1', target: 'other' }] })
    expect((await r.run({ describe: '' })).error).toMatch(/sim-no-target/)
  })

  it('--list marks the nodes you are linked to, and says what that means', async () => {
    const r = rig({ bridges: [{ source: 'sim1', target: 'agent' }] })
    const reply = await r.run({ list: '' })
    expect(reply.message).toContain('sim1 "Phone" (linked to you)')
    expect(reply.message).toMatch(/Linked to you \(your default target/)
    expect(reply.result).toMatchObject({ linked: ['sim1'] })
    const none = await rig().run({ list: '' })
    expect(none.message).not.toMatch(/linked to you/i)
  })
})

describe('auto-link on use', () => {
  it('--node on an unlinked device links it once and says so', async () => {
    const r = rig()
    const first = await r.run({ describe: '', node: 'sim1' })
    expect(first.message).toMatch(/Linked: Simulator node sim1 "Phone" is now linked to you/)
    expect(autoLinks(r.events)).toEqual([{ kind: 'auto-link', projectId: 'p1', ownerNodeId: 'agent', simNodeId: 'sim1' }])
    // The autosave has not persisted it yet, yet the second call neither re-requests nor re-announces.
    const second = await r.run({ describe: '', node: 'sim1' })
    expect(second.message).not.toMatch(/Linked:/)
    expect(autoLinks(r.events)).toHaveLength(1)
    // …and the new link already makes it the default target.
    expect((await r.run({ describe: '' })).ok).toBe(true)
  })

  it('reads and boot link too, not only input actions', async () => {
    const calls: Array<Record<string, string>> = [{ screenshot: '' }, { point: '1,1' }, { 'wait-idle': '' }, { boot: '' }]
    for (const args of calls) {
      const r = rig()
      await r.run({ ...args, node: 'sim1' })
      expect(autoLinks(r.events), JSON.stringify(args)).toHaveLength(1)
    }
  })

  it('--udid links when exactly ONE node of the project shows the device', async () => {
    const r = rig()
    await r.run({ describe: '', udid: UDID })
    expect(autoLinks(r.events)).toMatchObject([{ simNodeId: 'sim1' }])
  })

  it('--udid shown by two nodes is a choice the agent has not made: no link', async () => {
    const r = rig({
      nodes: [
        { id: 'sim1', title: 'A', udid: UDID },
        { id: 'sim3', title: 'B', udid: UDID }
      ]
    })
    await r.run({ describe: '', udid: UDID })
    expect(autoLinks(r.events)).toHaveLength(0)
  })

  it('--udid no node shows: no link, and the reply hints the user can add a node to watch', async () => {
    const r = rig({ nodes: [] })
    const reply = await r.run({ describe: '', udid: UDID })
    expect(autoLinks(r.events)).toHaveLength(0)
    expect(reply.message).toMatch(/Ask them to add one/)
  })

  it('already linked → nothing to request or announce', async () => {
    const r = rig({ bridges: [{ source: 'sim1', target: 'agent' }] })
    const reply = await r.run({ describe: '', node: 'sim1' })
    expect(autoLinks(r.events)).toHaveLength(0)
    expect(reply.message).not.toMatch(/Linked:/)
  })

  it('a link the user removed is not re-created this run; the call still works', async () => {
    const r = rig()
    await r.run({ describe: '', node: 'sim1' })
    r.ledger.noteRemoved('agent', 'sim1') // the renderer reported the deletion
    const again = await r.run({ describe: '', node: 'sim1' })
    expect(again.ok).toBe(true)
    expect(autoLinks(r.events)).toHaveLength(1)
    // …and the removed link no longer makes it the default target.
    expect((await r.run({ describe: '' })).error).toMatch(/sim-no-target/)
    // It is per agent+node: another agent is still linked on first use.
    await r.run({ describe: '', node: 'sim1' }, 'other')
    expect(autoLinks(r.events)).toHaveLength(2)
  })

  it('never across projects: a node of another project is not a Simulator node here', async () => {
    const r = rig()
    const reply = await r.run({ describe: '', node: 'simX' })
    expect(reply.error).toMatch(/sim-bad-node/)
    expect(autoLinks(r.events)).toHaveLength(0)
    // A caller in p2 links within p2 only.
    await r.run({ describe: '', node: 'simX' }, 'stranger')
    expect(autoLinks(r.events)).toEqual([{ kind: 'auto-link', projectId: 'p2', ownerNodeId: 'stranger', simNodeId: 'simX' }])
  })

  it('an agent that cannot be linked (not context-capable) still drives, silently unlinked', async () => {
    const r = rig({ canAutoLink: false })
    const reply = await r.run({ describe: '', node: 'sim1' })
    expect(reply.ok).toBe(true)
    expect(reply.message).not.toMatch(/Linked:/)
    expect(autoLinks(r.events)).toHaveLength(0)
  })
})

describe('the driving highlight', () => {
  it('input actions announce a bounded window, then a short linger', async () => {
    const r = rig()
    await r.run({ tap: '10,10', node: 'sim1' })
    const d = drives(r.events) as Array<Extract<SimAgentEvent, { kind: 'drive' }>>
    // start, the tap point, the settle wait, then the linger
    expect(d.length).toBeGreaterThanOrEqual(2)
    expect(d[0]).toMatchObject({ ownerNodeId: 'agent', simNodeIds: ['sim1'], until: 1_000_000 + SIM_DRIVE_MAX_MS })
    expect(d[d.length - 1].until).toBe(1_000_000 + SIM_DRIVE_LINGER_MS)
    expect(SIM_DRIVE_LINGER_MS).toBeLessThanOrEqual(5_000)
  })

  it('publishes the action text and the real tap point for the node to draw', async () => {
    const r = rig()
    await r.run({ tap: '10,20', node: 'sim1' })
    const d = drives(r.events) as Array<Extract<SimAgentEvent, { kind: 'drive' }>>
    expect(d[0].action).toBe('sim --tap 10,20')
    expect(d.some((e) => e.tap && e.tap.x === 10 && e.tap.y === 20)).toBe(true)
    expect(d.some((e) => e.action === 'waiting for the screen to settle')).toBe(true)
  })

  it('never publishes the text of --type (it can be a password)', async () => {
    const r = rig()
    await r.run({ type: 'hunter2-secret', node: 'sim1' })
    const d = drives(r.events) as Array<Extract<SimAgentEvent, { kind: 'drive' }>>
    expect(JSON.stringify(d)).not.toContain('hunter2')
    expect(d[0].action).toBe('typing 14 characters')
  })

  it('reads (describe, screenshot) link but do not animate', async () => {
    const r = rig()
    await r.run({ describe: '', node: 'sim1' })
    await r.run({ screenshot: '', node: 'sim1' })
    expect(drives(r.events)).toHaveLength(0)
  })

  it('addresses every node showing a --udid device, so an unlinked-but-shown device still gets the chip', async () => {
    const r = rig({
      nodes: [
        { id: 'sim1', title: 'A', udid: UDID },
        { id: 'sim3', title: 'B', udid: UDID }
      ]
    })
    await r.run({ press: 'home', udid: UDID })
    expect(drives(r.events)[0]).toMatchObject({ simNodeIds: ['sim1', 'sim3'] })
  })

  it('a device no node shows has nothing to highlight', async () => {
    const r = rig({ nodes: [] })
    await r.run({ press: 'home', udid: UDID })
    expect(drives(r.events)).toHaveLength(0)
  })
})
