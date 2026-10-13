import { describe, expect, it } from 'vitest'
import { loadFlow, type FlowIO } from './flow'
import { RECORD_STEPS_MAX, recordStep, renderRecording, startRecording } from './flow-record'
import { parseSimArgs, type SimAction } from './verb'

const act = (args: Record<string, string>): SimAction => {
  const c = parseSimArgs(args)
  if ('error' in c) throw new Error(c.error)
  return c.action
}

describe('recording', () => {
  it('records what a replay needs and nothing else', () => {
    const rec = startRecording('demo', 'android:Pixel_8', 0)
    const kept = [
      act({ 'tap-label': 'Log in' }),
      act({ describe: '' }),
      act({ 'wait-idle': '' }),
      act({ screenshot: '' }),
      act({ tap: '120,340' }),
      act({ 'tap-id': 'login_button', index: '2' }),
      act({ swipe: '200,600,200,150' }),
      act({ press: 'back' }),
      act({ 'wait-for': 'Home' }),
      act({ key: 'Enter' })
    ].map((a) => recordStep(rec, a))
    expect(kept).toEqual([true, false, false, false, true, true, true, true, true, true])
    const yaml = renderRecording(rec)
    expect(yaml).toContain('name: demo')
    expect(yaml).toContain('device: android:Pixel_8')
    expect(yaml).toContain('  - tap: "Log in"')
    expect(yaml).toContain('  - tap: { at: [120, 340] }   # TODO: use a label')
    expect(yaml).toContain('  - tap: { id: "login_button", index: 2 }')
    expect(yaml).toContain('  - swipe: { from: [200, 600], to: [200, 150] }')
    expect(yaml).toContain('  - press: back')
    expect(yaml).toContain('  - wait-for: "Home"')
  })

  it('writes a secret-looking field as a variable, never its value; other text is literal and ${ is escaped', () => {
    const rec = startRecording('t', 'android:x', 0)
    recordStep(rec, act({ 'type-label': 'Password', text: 'hunter2' }))
    recordStep(rec, act({ 'type-label': 'Email', text: 'a@b.c $' + '{X}' }))
    const yaml = renderRecording(rec)
    expect(yaml).not.toContain('hunter2')
    expect(yaml).toContain('text: "${PASSWORD}"')
    expect(yaml).toContain('--var PASSWORD=<value>')
    expect(yaml).toContain('text: "a@b.c $${X}"')
    expect([...rec.vars]).toEqual(['PASSWORD'])
  })

  it('is bounded', () => {
    const rec = startRecording('t', 'android:x', 0)
    for (let i = 0; i < RECORD_STEPS_MAX + 5; i++) recordStep(rec, act({ press: 'home' }))
    expect(rec.steps).toHaveLength(RECORD_STEPS_MAX)
    expect(rec.dropped).toBe(5)
    expect(renderRecording(rec)).toContain('5 more steps not recorded')
  })

  it('round-trips into a flow that loads, step for step', async () => {
    const rec = startRecording('rt', 'android:Pixel_8', 0)
    const actions = [
      act({ 'tap-label': 'Log in', 'wait-for-ms': '5000' }),
      act({ 'type-label': 'Email', text: 'me@x.io' }),
      act({ 'type-label': 'Password', text: 'pw' }),
      act({ type: 'free text' }),
      act({ tap: '10,20' }),
      act({ swipe: '1,2,3,4', ms: '500' }),
      act({ press: 'back' }),
      act({ key: 'a', mods: 'shift' }),
      act({ 'wait-for': 'Home', 'wait-for-ms': '4000' })
    ]
    for (const a of actions) recordStep(rec, a)
    const text = renderRecording(rec)
    const io: FlowIO = { resolve: async (_b, rel) => ({ ok: true, abs: `/p/${rel}` }), read: async () => text }
    const flow = await loadFlow('/p/rt.yaml', { vars: new Map([['PASSWORD', 'pw']]), io })
    expect(flow.name).toBe('rt')
    expect(flow.device).toBe('android:Pixel_8')
    expect(flow.steps).toHaveLength(actions.length)
    expect(flow.steps[0].args).toEqual({ 'tap-label': 'Log in', 'wait-for-ms': '5000' })
    expect(flow.steps[1].args).toEqual({ 'type-label': 'Email', text: 'me@x.io' })
    expect(flow.steps[2].args).toEqual({ 'type-label': 'Password', text: 'pw' })
    expect(flow.steps[5].args).toEqual({ swipe: '1,2,3,4', ms: '500' })
    expect(flow.steps[7].args).toEqual({ key: 'a', mods: 'shift' })
    expect(flow.steps[8].check).toMatchObject({ timeoutMs: 4000 })
    // and the missing variable is named when the replay omits it
    await expect(loadFlow('/p/rt.yaml', { vars: new Map(), io })).rejects.toThrow(/variable PASSWORD/)
  })
})
