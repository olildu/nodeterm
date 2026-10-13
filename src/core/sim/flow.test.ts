import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildVarMap, createMasker, FlowError, loadFlow, maskDeep, parseVarAssignments, substitute, varsIn, type FlowIO } from './flow'

function io(files: Record<string, string>): FlowIO {
  return {
    resolve: async (base, rel) => {
      const dir = base ? base.slice(0, base.lastIndexOf('/')) : '/p'
      const abs = posix.normalize(rel.startsWith('/') ? rel : `${dir}/${rel}`)
      return abs.startsWith('/p/') ? { ok: true, abs } : { ok: false, message: 'outside the project' }
    },
    read: async (abs) => {
      if (!(abs in files)) throw new Error('ENOENT')
      return files[abs]
    }
  }
}
const vars = (o: Record<string, string> = {}): Map<string, string> => new Map(Object.entries(o))
const load = (files: Record<string, string>, v = vars(), root = '/p/main.yaml') => loadFlow(root, { vars: v, io: io(files) })

const LOGIN = `
name: login
steps:
  - tap: "Log in"
  - type: { into: "Email", text: "\${EMAIL}" }
  - type: { into: "Password", text: "\${PASSWORD}" }
  - wait-for: { label: "Home", timeout: 8000 }
  - assert-visible: "Welcome"
  - assert-not-visible: "Error"
  - swipe: { from: [200,600], to: [200,150] }
  - press: back
  - screenshot: after-login
  - wait-idle: {}
`

describe('variables', () => {
  it('finds and substitutes ${NAME}; $${ is a literal', () => {
    expect(varsIn('a ${X} b ${Y_1} $${Z}')).toEqual(['X', 'Y_1'])
    expect(substitute('a ${X} $${Z}', vars({ X: '1' }))).toBe('a 1 ${Z}')
  })

  it('parses --var lists and refuses a malformed one without echoing the value', () => {
    expect(parseVarAssignments('A=1\nB=x=y')).toEqual([['A', '1'], ['B', 'x=y']])
    const bad = parseVarAssignments('NOEQUALS')
    expect(bad).toMatchObject({ error: expect.stringContaining('NAME=value') })
    const bad2 = parseVarAssignments('1bad=hunter2')
    expect(JSON.stringify(bad2)).not.toContain('hunter2')
  })

  it('--var wins over FLOW_<NAME> in the environment, and only FLOW_ names are read', () => {
    const m = buildVarMap([['A', 'cli']], { FLOW_A: 'env', FLOW_B: 'envb', HOME: '/root', AWS_SECRET_ACCESS_KEY: 'x' })
    expect(Object.fromEntries(m)).toEqual({ A: 'cli', B: 'envb' })
  })

  it('masks secret values everywhere, longest first, deeply', () => {
    const mask = createMasker(['hunter2', 'hunter2-long', ''])
    expect(mask('pw hunter2-long and hunter2')).toBe('pw *** and ***')
    expect(maskDeep({ a: ['x hunter2'], n: 3 }, mask)).toEqual({ a: ['x ***'], n: 3 })
  })
})

describe('loadFlow', () => {
  it('flattens, numbers, substitutes and keeps displays variable-spelled', async () => {
    const f = await load({ '/p/main.yaml': LOGIN }, vars({ EMAIL: 'a@b.c', PASSWORD: 'hunter2' }))
    expect(f.name).toBe('login')
    expect(f.steps.map((s) => s.op)).toEqual(['sim', 'sim', 'sim', 'wait-for', 'assert-visible', 'assert-not-visible', 'sim', 'sim', 'screenshot', 'sim'])
    expect(f.steps[1].args).toEqual({ 'type-label': 'Email', text: 'a@b.c' })
    expect(f.steps[2].args?.text).toBe('hunter2')
    // displays never carry a value
    const shown = f.steps.map((s) => s.display).join('\n')
    expect(shown).toContain('${PASSWORD}')
    expect(shown).not.toContain('hunter2')
    expect(shown).not.toContain('a@b.c')
    expect(f.steps[3].check).toMatchObject({ timeoutMs: 8000, ref: { by: 'label', text: 'Home' } })
    expect(f.secretValues).toEqual(['hunter2'])
    expect(f.steps.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('an unresolved variable is an error before anything runs, naming every missing one', async () => {
    await expect(load({ '/p/main.yaml': LOGIN }, vars({ EMAIL: 'x' }))).rejects.toThrow(/needs variable PASSWORD.*--var PASSWORD=<value>.*FLOW_PASSWORD.*Nothing was run/)
    await expect(load({ '/p/main.yaml': LOGIN })).rejects.toThrow(/variables EMAIL, PASSWORD/)
  })

  it('validates every sim step with the verb parser, naming the step; never echoing typed text', async () => {
    const e = await load({ '/p/main.yaml': 'steps:\n  - tap: "ok"\n  - press: sideways\n' }).catch((x: Error) => x)
    expect(e).toBeInstanceOf(FlowError)
    expect((e as Error).message).toMatch(/main\.yaml step 2.*press sideways.*--press takes/)
    const e2 = await load({ '/p/main.yaml': 'steps:\n  - type: { into: "F", text: "a\\u0001b" }\n' }).catch((x: Error) => x)
    expect((e2 as Error).message).toMatch(/control character/)
  })

  it('refuses malformed steps with a pointer', async () => {
    const msg = async (steps: string): Promise<string> => ((await load({ '/p/main.yaml': `steps:\n${steps}` }).catch((x: Error) => x)) as Error).message
    expect(await msg('  - tap: "a"\n    press: back\n')).toMatch(/ONE key/)
    expect(await msg('  - flurb: x\n')).toMatch(/unknown step "flurb"/)
    expect(await msg('  - tap: { label: a, id: b }\n')).toMatch(/label OR id/)
    expect(await msg('  - tap: { at: [1] }\n')).toMatch(/\[x, y\]/)
    expect(await msg('  - screenshot: "../x"\n')).toMatch(/short name/)
    expect(await msg('  - wait-for: { label: a, timeout: -1 }\n')).toMatch(/timeout must be a whole number/)
    expect((await load({ '/p/main.yaml': 'name: x\nsteps: []\n' }).catch((x: Error) => x) as Error).message).toMatch(/non-empty list/)
    expect((await load({ '/p/main.yaml': 'name: x\nstep: []\n' }).catch((x: Error) => x) as Error).message).toMatch(/unknown key "step"/)
  })

  it('includes are expanded in place, share variables, and numbering is continuous', async () => {
    const files = {
      '/p/main.yaml': 'name: main\nsteps:\n  - tap: "A"\n  - run: sub/inner.yaml\n  - tap: "C"\n',
      '/p/sub/inner.yaml': 'steps:\n  - tap: "${W}"\n  - run: ../leaf.yaml\n',
      '/p/leaf.yaml': 'steps:\n  - press: home\n'
    }
    const f = await load(files, vars({ W: 'B' }))
    expect(f.steps.map((s) => s.display)).toEqual(['tap "A"', 'tap "${W}"', 'press home', 'tap "C"'].map((d) => d))
    expect(f.steps.map((s) => s.index)).toEqual([1, 2, 3, 4])
    expect(f.steps[1].origin).toBe('inner.yaml step 1')
    expect(f.files).toHaveLength(3)
  })

  it('guards include cycles, depth and a jail refusal', async () => {
    const cyc = { '/p/main.yaml': 'steps:\n  - run: b.yaml\n', '/p/b.yaml': 'steps:\n  - run: main.yaml\n' }
    await expect(load(cyc)).rejects.toThrow(/include cycle main\.yaml → b\.yaml → main\.yaml/)
    const deep: Record<string, string> = { '/p/main.yaml': 'steps:\n  - run: f1.yaml\n' }
    for (let i = 1; i <= 8; i++) deep[`/p/f${i}.yaml`] = `steps:\n  - run: f${i + 1}.yaml\n`
    deep['/p/f9.yaml'] = 'steps:\n  - press: home\n'
    await expect(load(deep)).rejects.toThrow(/nested more than 4 deep/)
    await expect(load({ '/p/main.yaml': 'steps:\n  - run: ../../etc/x.yaml\n' })).rejects.toThrow(/outside the project/)
    await expect(load({ '/p/main.yaml': 'steps:\n  - run: missing.yaml\n' })).rejects.toThrow(/could not read/)
  })

  it('bounds the flattened step count', async () => {
    const many = 'steps:\n' + '  - press: home\n'.repeat(201)
    await expect(load({ '/p/main.yaml': many })).rejects.toThrow(/more than 200 steps/)
    // an include that fans out is counted too
    const files: Record<string, string> = { '/p/main.yaml': 'steps:\n' + '  - run: a.yaml\n'.repeat(3), '/p/a.yaml': 'steps:\n' + '  - press: home\n'.repeat(80) }
    await expect(load(files)).rejects.toThrow(/more than 200 steps/)
  })

  it('uses the file name when the flow has no name, and keeps the optional device', async () => {
    const f = await load({ '/p/main.yaml': 'device: android:Pixel_8\nsteps:\n  - press: home\n' })
    expect(f.name).toBe('main')
    expect(f.device).toBe('android:Pixel_8')
  })
})
