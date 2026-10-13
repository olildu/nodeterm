import { describe, expect, it } from 'vitest'
import { FlowYamlError, FLOW_YAML_MAX_BYTES, parseFlowYaml } from './flow-yaml'

describe('parseFlowYaml', () => {
  it('reads the documented flow shape', () => {
    const doc = parseFlowYaml(`
# a comment
name: login
device: android:nt_smoke_30        # trailing comment
steps:
  - tap: "Log in"
  - type: { into: "Email", text: "\${EMAIL}" }
  - wait-for: "Home"
  - swipe: { from: [200,600], to: [200,150] }
  - press: back
  - wait-idle: {}
  - run: other-flow.yaml
`)
    expect(doc).toEqual({
      name: 'login',
      device: 'android:nt_smoke_30',
      steps: [
        { tap: 'Log in' },
        { type: { into: 'Email', text: '${EMAIL}' } },
        { 'wait-for': 'Home' },
        { swipe: { from: [200, 600], to: [200, 150] } },
        { press: 'back' },
        { 'wait-idle': {} },
        { run: 'other-flow.yaml' }
      ]
    })
  })

  it('reads multi-key list items and nested blocks, list at the key indent included', () => {
    expect(parseFlowYaml('steps:\n- tap:\n    label: Done\n    index: 2\n- press: home\n')).toEqual({
      steps: [{ tap: { label: 'Done', index: 2 } }, { press: 'home' }]
    })
    expect(parseFlowYaml('a:\n  - x: 1\n    y: two\n  - z\n')).toEqual({ a: [{ x: 1, y: 'two' }, 'z'] })
  })

  it('handles quotes: commas, # and colons inside strings, escapes, single-quote doubling', () => {
    expect(parseFlowYaml('t: "a, b # c: d"\n')).toEqual({ t: 'a, b # c: d' })
    expect(parseFlowYaml('t: "line\\nbreak \\u00e9 \\"q\\""\n')).toEqual({ t: 'line\nbreak é "q"' })
    expect(parseFlowYaml("t: 'it''s'\n")).toEqual({ t: "it's" })
    expect(parseFlowYaml('t: [ "a,b", \'c\', d e ]\n')).toEqual({ t: ['a,b', 'c', 'd e'] })
  })

  it('treats ${VAR} as atomic, even unquoted inside a flow map', () => {
    expect(parseFlowYaml('x: { text: ${A}, n: 3 }\ny: ${B}\n')).toEqual({ x: { text: '${A}', n: 3 }, y: '${B}' })
  })

  it('types scalars: numbers, booleans, null; a plain value keeps its commas and colons', () => {
    expect(parseFlowYaml('a: 12\nb: -3.5\nc: true\nd: ~\ne:\nf: Log in, now\n')).toEqual({ a: 12, b: -3.5, c: true, d: null, e: null, f: 'Log in, now' })
  })

  it('refuses what it does not support, by name and line', () => {
    const bad = (src: string): string => {
      try {
        parseFlowYaml(src)
      } catch (e) {
        expect(e).toBeInstanceOf(FlowYamlError)
        return (e as Error).message
      }
      return ''
    }
    expect(bad('a: |\n  text\n')).toMatch(/line 1: block scalars/)
    expect(bad('a: &x 1\n')).toMatch(/anchors/)
    expect(bad('a: 1\na: 2\n')).toMatch(/line 2: .*appears twice/)
    expect(bad('a:\n\tb: 1\n')).toMatch(/tab indentation/)
    expect(bad('a: [1, 2\n')).toMatch(/never closed/)
    expect(bad('a: "x\n')).toMatch(/never closed/)
    expect(bad('---\na: 1\n---\nb: 2\n')).toMatch(/multiple documents/)
    expect(bad('')).toMatch(/empty/)
    expect(bad('a: 1\n  b: 2\n')).toMatch(/unexpected indentation/)
  })

  it('is bounded: size, depth', () => {
    expect(() => parseFlowYaml('a: ' + 'x'.repeat(FLOW_YAML_MAX_BYTES))).toThrow(/larger than/)
    expect(() => parseFlowYaml('a: ' + '['.repeat(40) + ']'.repeat(40))).toThrow(/too deeply/)
  })
})
