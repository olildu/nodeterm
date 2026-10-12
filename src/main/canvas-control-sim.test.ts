// The `sim` verb as the OTHER verbs' tables see it, and as the agent is told about it. The grammar
// itself is `core/sim/verb.test.ts`; the run is `core/sim/control.test.ts`. This file pins the three
// places a verb is easy to half-register — the registry, the off-screen disposition, the Server
// Edition refusal — and the rule that the agent-facing text is RENDERED from the code that
// enforces it (CLAUDE.md → Canvas control: "a doc line with no such test is a plan, not a fact").
import { describe, expect, it } from 'vitest'
import {
  buildCanvasControlInstructions,
  buildCanvasSkillBody,
  parseControlRequest,
  VERBS_FOR_TEST
} from '../core/canvas-control-core'
import { requiresVerified, verifiedRefusalFor } from '../core/agents/hook-server'
import { offScreenDisposition, needsLiveCanvas } from '../shared/control-off-screen'
import { createServerEditionControlHandler, unsupportedServerVerbMessage } from '../server/control-unsupported'
import {
  SIM_BOOT_TIMEOUT_MS,
  SIM_IDLE_QUIET_MS,
  SIM_IDLE_TIMEOUT_MS,
  SIM_KEY_DOC_NAMES,
  SIM_PRESS_BUTTONS,
  SIM_REACTION_MS,
  SIM_SWIPE_MS_DEFAULT,
  SIM_TIMEOUT_MAX_MS,
  SIM_PICK_DEVICE_RULES,
  OPEN_SIMULATOR_SYNTAX
} from '../core/sim/verb'
import { REQUEST_ID_VERBS } from '../core/control-request-ledger'
import { SIM_TEXT_MAX } from '../shared/sim'

const UDID = 'AE342EEF-B624-4060-B9E6-AE6E9EAAC24A'
const bodies = (): Array<readonly [string, string]> => [
  ['skill', buildCanvasSkillBody('/x/shim.sh')],
  ['instructions', buildCanvasControlInstructions('/x/shim.sh')]
]

describe('the sim verb is registered everywhere a verb has to be', () => {
  it('is in the verb registry and parses through parseControlRequest', () => {
    expect(VERBS_FOR_TEST).toContain('sim')
    expect(parseControlRequest('sim', { udid: UDID, describe: '' })).toMatchObject({ verb: 'sim' })
    expect(parseControlRequest('sim', { udid: UDID })).toMatchObject({ error: expect.stringMatching(/exactly one action/) })
    expect(parseControlRequest('sim', { udid: UDID, tap: '1' })).toMatchObject({ error: expect.stringMatching(/--tap takes x,y/) })
  })

  it('is verified-only, with its own flat refusal', () => {
    expect(requiresVerified.has('sim')).toBe(true)
    expect(verifiedRefusalFor('sim')).toBe('Simulator control refused.')
  })

  it('is answered whichever project is on screen: store-answered, never travelling', () => {
    expect(offScreenDisposition('sim')).toEqual({ kind: 'store-answered' })
    expect(needsLiveCanvas('sim')).toBe(false)
  })

  it('is refused by name on the Server Edition, permanently', async () => {
    expect(unsupportedServerVerbMessage('sim')).toMatch(/not supported by nodeterm Server Edition v1.*do not retry.*iOS Simulator belongs to the nodeterm desktop app/s)
    const handler = createServerEditionControlHandler({} as never)
    expect(await handler({ verb: 'sim', nodeId: 'n1', args: { list: '' }, verified: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining('control-unsupported')
    })
  })
})

describe('both agent-facing bodies document the sim verb, rendered from the code that enforces it', () => {
  it('names the verb, every action and the one-action rule', () => {
    for (const [name, body] of bodies()) {
      expect(body, name).toContain('- `sim <one action> [--node <Simulator node id> | --udid <device id>]`')
      for (const flag of ['--list', '--boot', '--describe', '--point x,y', '--screenshot', '--tap x,y', '--tap-label', '--swipe', '--type', '--key', '--press', '--wait-idle']) {
        expect(body, `${name} ${flag}`).toContain(flag)
      }
      expect(body, name).toMatch(/Pass exactly ONE action/)
      expect(body, name).toMatch(/Simulator\.app is never opened/)
      expect(body, name).toMatch(/Server\s+Edition refuses it by name/)
    }
  })

  it('renders the limits from the parser, not from prose', () => {
    for (const [name, body] of bodies()) {
      expect(body, name).toContain(`${Math.round(SIM_BOOT_TIMEOUT_MS / 1000)}s`)
      expect(body, name).toContain(`${Math.round(SIM_IDLE_TIMEOUT_MS / 1000)}s default, ${Math.round(SIM_TIMEOUT_MAX_MS / 1000)}s max`)
      expect(body, name).toContain(`for ${SIM_IDLE_QUIET_MS} ms`)
      expect(body, name).toContain(`${SIM_IDLE_QUIET_MS} ms with no pixel changing`)
      expect(body, name).toContain(`up to ${SIM_REACTION_MS} ms to start moving`)
      expect(body, name).toContain(`${SIM_SWIPE_MS_DEFAULT} ms default`)
      expect(body, name).toContain(`at most ${SIM_TEXT_MAX} characters`)
      expect(body, name).toContain(SIM_PRESS_BUTTONS.join('|'))
      expect(body, name).toContain(SIM_KEY_DOC_NAMES.join('|'))
    }
  })

  it('states the settle-by-default rule and its escape, and the shim-safe bare-switch spelling', () => {
    for (const [name, body] of bodies()) {
      expect(body, name).toMatch(/Every INPUT action .* waits for the screen to settle before it answers/s)
      expect(body, name).toContain('`--no-wait true`')
      expect(body, name).toContain('`--describe true`')
    }
  })

  it('warns about the pasteboard, untrusted labels and one driver per device', () => {
    for (const [name, body] of bodies()) {
      expect(body, name).toMatch(/OVERWRITES the device pasteboard/)
      expect(body, name).toMatch(/Labels are the app's words/)
      expect(body, name).toMatch(/One\s+driver per device/)
    }
  })

  it('every documented example flag is one the parser accepts (docs cannot promise a flag it refuses)', () => {
    const examples: Array<Record<string, string>> = [
      { list: '' },
      { udid: UDID, boot: '' },
      { udid: UDID, describe: '' },
      { udid: UDID, point: '196,430' },
      { udid: UDID, screenshot: 'a.png', scale: '0.5' },
      { udid: UDID, tap: '196,430' },
      { udid: UDID, 'tap-label': 'General' },
      { udid: UDID, swipe: '196,700,196,200', ms: '300' },
      { udid: UDID, type: 'x' },
      { udid: UDID, key: 'Enter', mods: 'cmd,shift' },
      { udid: UDID, press: 'home' },
      { udid: UDID, 'wait-idle': '', quiet: '300' },
      { udid: UDID, tap: '1,2', 'no-wait': 'true', timeout: '1000' }
    ]
    for (const args of examples) expect(parseControlRequest('sim', args), JSON.stringify(args)).toMatchObject({ verb: 'sim' })
    for (const key of SIM_KEY_DOC_NAMES) expect(parseControlRequest('sim', { udid: UDID, key }), key).toMatchObject({ verb: 'sim' })
    for (const press of SIM_PRESS_BUTTONS) expect(parseControlRequest('sim', { udid: UDID, press }), press).toMatchObject({ verb: 'sim' })
  })
})

describe('the iOS testing guidance both bodies carry (step 4)', () => {
  it('spells the loop: list, describe, act, re-describe, then a Maestro flow in a terminal node', () => {
    for (const [name, body] of bodies()) {
      expect(body, name).toContain('Testing an iOS app (the `sim` verb + Maestro):')
      expect(body, name).toContain('`sim --list`')
      expect(body, name).toContain('re-`--describe` to')
      expect(body, name).toContain('.maestro/<name>.yaml')
      for (const key of ['appId:', 'launchApp', 'tapOn:', 'inputText:', 'assertVisible:']) expect(body, `${name} ${key}`).toContain(key)
      expect(body, name).toContain('maestro --device <udid> test .maestro/<name>.yaml')
      expect(body, name).toContain('TERMINAL node')
    }
  })

  it('says what Maestro costs, where it lives, and that it must not run beside sim input', () => {
    for (const [name, body] of bodies()) {
      expect(body, name).toMatch(/10-45 s per run/)
      expect(body, name).toContain('~/.maestro/bin/maestro')
      expect(body, name).toMatch(/ONE driver per device: do not call `sim` \(input or looking\) while Maestro runs/)
      expect(body, name).toMatch(/Simulator node may stay open beside a run/)
    }
  })

  it('explains the Flutter accessibility rule', () => {
    for (const [name, body] of bodies()) {
      expect(body, name).toMatch(/Flutter widget with no `Semantics`/)
      expect(body, name).toContain('Semantics(label:')
    }
  })
})

describe('the agent-facing text tells the Simulator-link story (both bodies)', () => {
  it.each(bodies())('%s: default target, refusals, auto-link and its removal rule, link --to', (_n, body) => {
    expect(body).toContain('LINKING A SIMULATOR NODE')
    expect(body).toContain('DEFAULT `sim`')
    expect(body).toContain('sim-ambiguous-target')
    expect(body).toContain('sim-no-target')
    expect(body).toContain('AUTO-LINK')
    expect(body).toMatch(/NOT re-created for the rest of this app run/)
    expect(body).toMatch(/Never across projects/)
    expect(body).toMatch(/`--to` may also be a Simulator node/)
    expect(body).toContain('(simulator: iPhone 15)')
  })
  it('the target flags are optional in the grammar, not required', () => {
    expect(parseControlRequest('sim', { describe: '' })).toMatchObject({ verb: 'sim' })
  })
})

describe('open-simulator is registered and documented', () => {
  it('is registered: verified-only, off-canvas, request-id, refused on the Server Edition', async () => {
    expect(VERBS_FOR_TEST).toContain('open-simulator')
    expect(requiresVerified.has('open-simulator')).toBe(true)
    expect(verifiedRefusalFor('open-simulator')).toBe('Simulator control refused.')
    expect(offScreenDisposition('open-simulator')).toEqual({ kind: 'off-canvas' })
    expect(REQUEST_ID_VERBS.has('open-simulator')).toBe(true)
    expect(unsupportedServerVerbMessage('open-simulator')).toMatch(/do not retry/)
    const handler = createServerEditionControlHandler({} as never)
    expect(await handler({ verb: 'open-simulator', nodeId: 'n1', args: {}, verified: true })).toMatchObject({ ok: false })
  })

  it('parses --udid strictly and rejects unknown flags', () => {
    expect(parseControlRequest('open-simulator', {})).toMatchObject({ verb: 'open-simulator' })
    expect(parseControlRequest('open-simulator', { udid: UDID })).toMatchObject({ verb: 'open-simulator' })
    expect(parseControlRequest('open-simulator', { udid: 'nope' })).toMatchObject({ error: expect.stringMatching(/--udid/) })
    expect(parseControlRequest('open-simulator', { bogus: '1' })).toMatchObject({ error: expect.stringMatching(/unknown flag/) })
  })

  it.each(bodies())('%s: documents the verb and the pick-a-device rules from the constants', (_n, body) => {
    expect(body).toContain(OPEN_SIMULATOR_SYNTAX)
    for (const rule of SIM_PICK_DEVICE_RULES) expect(body).toContain(rule)
    expect(body).toContain('Never open a second Simulator node for a device that already has one')
    expect(body).not.toMatch(/ask (them|the user) to add a Simulator node/)
  })
})
