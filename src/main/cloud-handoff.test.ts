import { describe, expect, it } from 'vitest'
import { cloudHandoffArgs, progressLine } from './cloud-handoff'

describe('cloudHandoffArgs', () => {
  const tab = 'project-mwdlnn80-ae7fa466'
  it('maps each verb to the script argv', () => {
    expect(cloudHandoffArgs({ verb: 'where', tabId: tab })).toEqual(['where', tab])
    expect(cloudHandoffArgs({ verb: 'plan', tabId: tab })).toEqual(['plan', tab, '--json'])
    expect(cloudHandoffArgs({ verb: 'out', tabId: tab })).toEqual(['out', tab])
    expect(cloudHandoffArgs({ verb: 'back', tabId: tab })).toEqual(['back', tab])
    expect(cloudHandoffArgs({ verb: 'warm-on', tabId: tab })).toEqual(['warm', 'on', tab])
    expect(cloudHandoffArgs({ verb: 'warm-off', tabId: tab })).toEqual(['warm', 'off', tab])
  })
  it('puts the task text after -- as one line', () => {
    expect(cloudHandoffArgs({ verb: 'queue', tabId: tab, node: 'term-a1', text: '--force\nrun tests' })).toEqual([
      'queue',
      tab,
      'term-a1',
      '--',
      '--force run tests'
    ])
  })
  it.each([
    [{ verb: 'out', tabId: '../x' }],
    [{ verb: 'out', tabId: 'a b' }],
    [{ verb: 'out', tabId: '-rf' + ';' }],
    [{ verb: 'queue', tabId: tab, node: '$(id)', text: 'x' }],
    [{ verb: 'queue', tabId: tab, node: 'term-a1', text: '   ' }],
    [{ verb: 'queue', tabId: tab, node: 'term-a1', text: 'x'.repeat(4001) }],
    [{ verb: 'rm', tabId: tab }]
  ])('refuses %j', (req) => {
    expect(typeof cloudHandoffArgs(req as never)).toBe('string')
  })
})

describe('progressLine', () => {
  it('reads the JSON message or error, else the raw line', () => {
    expect(progressLine('{"t":"10:00:00","msg":"final copy"}')).toBe('final copy')
    expect(progressLine('{"error":"no tab named x"}')).toBe('no tab named x')
    expect(progressLine('handoff: refusing to hand off')).toBe('refusing to hand off')
    expect(progressLine('   ')).toBeNull()
  })
})

