import { describe, expect, it } from 'vitest'
import {
  SIM_DESCRIBE_LINES_MAX,
  SIM_IDLE_QUIET_MS,
  SIM_IDLE_TIMEOUT_MS,
  SIM_BOOT_TIMEOUT_MS,
  SIM_TIMEOUT_MAX_MS,
  compactScreen,
  isFieldElement,
  parseNumberList,
  parseSimArgs,
  readDescribe,
  renderCompactDiff,
  renderCompactText,
  renderDescribeText,
  renderElement,
  resolveElement,
  resolveTapLabel,
  simKeyUsage,
  type SimCall,
  type SimElement,
  type SimScreenRead
} from './verb'

const UDID = 'AE342EEF-B624-4060-B9E6-AE6E9EAAC24A'

const ok = (args: Record<string, string>): SimCall => {
  const r = parseSimArgs(args)
  if ('error' in r) throw new Error(`expected a call, got: ${r.error}`)
  return r
}
const err = (args: Record<string, string>): string => {
  const r = parseSimArgs(args)
  if (!('error' in r)) throw new Error('expected a refusal')
  return r.error
}

describe('parseSimArgs — exactly one action, a target, nothing unknown', () => {
  it('needs an action, and exactly one', () => {
    expect(err({ udid: UDID })).toMatch(/exactly one action/)
    expect(err({ udid: UDID, describe: '', tap: '1,2' })).toMatch(/exactly ONE action.*--describe and --tap/)
  })

  it('refuses an unknown flag instead of ignoring it (a typo must not re-enable the settle wait)', () => {
    expect(err({ udid: UDID, tap: '1,2', 'no-wiat': 'true' })).toMatch(/unknown flag --no-wiat/)
    expect(err({ udid: UDID, screenshot: 'a.png', scal: '0.5' })).toMatch(/unknown flag --scal/)
  })

  it('--list takes no target; every other action needs exactly one', () => {
    expect(ok({ list: '' }).target).toBeNull()
    expect(err({ list: '', udid: UDID })).toMatch(/takes no --node or --udid/)
    expect(parseSimArgs({ describe: '' })).toMatchObject({ target: null })
    expect(err({ describe: '', node: 'n1', udid: UDID })).toMatch(/not both/)
  })

  it('validates the target: a safe node id, a UUID udid (normalised to upper case)', () => {
    expect(ok({ describe: '', node: 'node-1' }).target).toEqual({ by: 'node', node: 'node-1' })
    expect(err({ describe: '', node: '../x' })).toMatch(/not a node id/)
    expect(err({ describe: '', node: '' })).toMatch(/not a node id/)
    expect(ok({ describe: '', udid: UDID.toLowerCase() }).target).toEqual({ by: 'udid', udid: UDID })
    expect(err({ describe: '', udid: 'booted' })).toMatch(/not a simulator id/)
  })

  it('accepts a bare switch both ways (the old shim loop turns a bare flag into a value)', () => {
    expect(ok({ udid: UDID, describe: '' }).action.kind).toBe('describe')
    expect(ok({ udid: UDID, describe: 'true' }).action.kind).toBe('describe')
    expect(ok({ udid: UDID, boot: 'true' }).action.kind).toBe('boot')
    expect(ok({ udid: UDID, 'wait-idle': '' }).action.kind).toBe('wait-idle')
    expect(err({ udid: UDID, describe: '--node' })).toMatch(/takes no value/)
    expect(err({ udid: UDID, describe: 'false' })).toMatch(/takes no value/)
  })

  it('parses points, swipes, labels, text', () => {
    expect(ok({ udid: UDID, tap: '196, 430' }).action).toEqual({ kind: 'tap', x: 196, y: 430 })
    expect(ok({ udid: UDID, point: '10.5,20' }).action).toEqual({ kind: 'point', x: 10.5, y: 20 })
    expect(ok({ udid: UDID, swipe: '196,700,196,200' }).action).toMatchObject({ kind: 'swipe', x1: 196, y2: 200, ms: 300 })
    expect(ok({ udid: UDID, 'tap-label': ' General ' }).action).toEqual({ kind: 'tap-label', label: 'General', index: null, waitForMs: 3000 })
    expect(ok({ udid: UDID, type: 'héllo wörld' }).action).toEqual({ kind: 'type', text: 'héllo wörld' })
  })

  it.each([
    ['tap', '196'],
    ['tap', '1,2,3'],
    ['tap', 'a,b'],
    ['tap', 'NaN,1'],
    ['tap', '1e3,1'],
    ['tap', '99999,1'],
    ['swipe', '1,2,3'],
    ['point', '']
  ])('refuses a malformed point: --%s %j', (flag, value) => {
    expect(err({ udid: UDID, [flag]: value })).toMatch(/device points/)
  })

  it('refuses empty labels, empty or oversize or control-char text', () => {
    expect(err({ udid: UDID, 'tap-label': '  ' })).toMatch(/--tap-label/)
    expect(err({ udid: UDID, type: '' })).toMatch(/--type/)
    expect(err({ udid: UDID, type: 'x'.repeat(4001) })).toMatch(/longer than 4000/)
    expect(err({ udid: UDID, type: 'a\u0000b' })).toMatch(/control character/)
    expect(ok({ udid: UDID, type: 'line1\nline2\tx' }).action).toMatchObject({ kind: 'type' })
  })

  it('--screenshot needs a .png path', () => {
    expect(ok({ udid: UDID, screenshot: '.maestro/home.png' }).action).toEqual({ kind: 'screenshot', path: '.maestro/home.png' })
    expect(err({ udid: UDID, screenshot: 'shot' })).toMatch(/must end in \.png/)
    expect(ok({ udid: UDID, screenshot: '' }).action).toEqual({ kind: 'screenshot', path: null })
  })

  it('--press is a closed set', () => {
    expect(ok({ udid: UDID, press: 'Home' }).action).toEqual({ kind: 'press', button: 'home' })
    for (const b of ['lock', 'volup', 'voldown', 'siri', 'back', 'recents', 'power']) expect(ok({ udid: UDID, press: b }).action).toMatchObject({ button: b })
    expect(err({ udid: UDID, press: 'mute' })).toMatch(/home\|back\|recents\|lock\|power\|volup\|voldown\|siri/)
    expect(err({ udid: UDID, press: 'side' })).toMatch(/--press takes/)
  })

  it('--key takes names, characters and HID usages, with a closed modifier set', () => {
    expect(ok({ udid: UDID, key: 'Enter' }).action).toMatchObject({ kind: 'key', usage: 0x28, mods: [] })
    expect(ok({ udid: UDID, key: 'a', mods: 'cmd,shift' }).action).toMatchObject({ usage: 0x04, mods: ['cmd', 'shift'] })
    expect(ok({ udid: UDID, key: 'k', mods: 'Command, Option, command' }).action).toMatchObject({ mods: ['cmd', 'alt'] })
    expect(err({ udid: UDID, key: 'F13' })).toMatch(/--key takes/)
    expect(err({ udid: UDID, key: 'a', mods: 'super' })).toMatch(/--mods takes/)
    expect(err({ udid: UDID, key: 'a', mods: '' })).toMatch(/--mods takes/)
    expect(err({ udid: UDID, tap: '1,2', mods: 'cmd' })).toMatch(/--mods applies to --key only/)
  })

  it('modifiers apply only to the action they modify', () => {
    expect(err({ udid: UDID, tap: '1,2', scale: '0.5' })).toMatch(/--scale applies to --screenshot/)
    expect(err({ udid: UDID, tap: '1,2', ms: '100' })).toMatch(/--ms applies to --swipe/)
    expect(err({ udid: UDID, describe: '', 'no-wait': 'true' })).toMatch(/--no-wait applies to the input actions/)
  })

  it('--scale, --ms, --quiet and --timeout are range-checked', () => {
    expect(ok({ udid: UDID, screenshot: 'a.png' }).scale).toBe(1)
    expect(ok({ udid: UDID, screenshot: 'a.png', scale: '0.5' }).scale).toBe(0.5)
    expect(err({ udid: UDID, screenshot: 'a.png', scale: '0' })).toMatch(/--scale takes/)
    expect(err({ udid: UDID, screenshot: 'a.png', scale: '2' })).toMatch(/--scale takes/)
    expect(err({ udid: UDID, screenshot: 'a.png', scale: 'big' })).toMatch(/--scale takes/)
    expect(ok({ udid: UDID, swipe: '1,2,3,4', ms: '800' }).action).toMatchObject({ ms: 800 })
    expect(err({ udid: UDID, swipe: '1,2,3,4', ms: '10' })).toMatch(/--ms takes/)
    expect(err({ udid: UDID, swipe: '1,2,3,4', ms: '99999' })).toMatch(/--ms takes/)
    expect(ok({ udid: UDID, 'wait-idle': '', quiet: '500' }).quietMs).toBe(500)
    expect(err({ udid: UDID, 'wait-idle': '', quiet: '5' })).toMatch(/--quiet takes/)
  })

  it('defaults: input waits for idle, settle timeout 5 s, boot waits 60 s; timeout is clamped', () => {
    const tap = ok({ udid: UDID, tap: '1,2' })
    expect(tap).toMatchObject({ wait: true, quietMs: SIM_IDLE_QUIET_MS, timeoutMs: SIM_IDLE_TIMEOUT_MS })
    expect(ok({ udid: UDID, describe: '' }).wait).toBe(false)
    expect(ok({ udid: UDID, boot: '' }).timeoutMs).toBe(SIM_BOOT_TIMEOUT_MS)
    expect(ok({ udid: UDID, tap: '1,2', timeout: '999999' }).timeoutMs).toBe(SIM_TIMEOUT_MAX_MS)
    expect(ok({ udid: UDID, tap: '1,2', timeout: '250' }).timeoutMs).toBe(250)
    expect(err({ udid: UDID, tap: '1,2', timeout: '0' })).toMatch(/--timeout takes/)
    expect(err({ udid: UDID, tap: '1,2', timeout: 'soon' })).toMatch(/--timeout takes/)
  })

  it('--no-wait skips the settle wait, and says false means wait', () => {
    expect(ok({ udid: UDID, tap: '1,2', 'no-wait': 'true' }).wait).toBe(false)
    expect(ok({ udid: UDID, tap: '1,2', 'no-wait': '' }).wait).toBe(false)
    expect(ok({ udid: UDID, tap: '1,2', 'no-wait': 'false' }).wait).toBe(true)
    expect(err({ udid: UDID, tap: '1,2', 'no-wait': 'maybe' })).toMatch(/--no-wait takes true or false/)
  })

  it('--wait-idle is an action in its own right', () => {
    expect(ok({ udid: UDID, 'wait-idle': 'true' }).action.kind).toBe('wait-idle')
  })
})

describe('parseNumberList', () => {
  it('is exact about count and shape', () => {
    expect(parseNumberList('1,2', 2)).toEqual([1, 2])
    expect(parseNumberList(' -3 , 4.5 ', 2)).toEqual([-3, 4.5])
    expect(parseNumberList('1,2', 4)).toBeNull()
    expect(parseNumberList('1,,2', 2)).toBeNull()
    expect(parseNumberList('Infinity,1', 2)).toBeNull()
  })
})

describe('simKeyUsage', () => {
  it('maps names, characters and usages onto HID page 7', () => {
    expect(simKeyUsage('Enter')).toBe(0x28)
    expect(simKeyUsage('backspace')).toBe(0x2a)
    expect(simKeyUsage('ArrowUp')).toBe(0x52)
    expect(simKeyUsage('Up')).toBe(0x52)
    expect(simKeyUsage('Space')).toBe(0x2c)
    expect(simKeyUsage('z')).toBe(0x1d)
    expect(simKeyUsage('1')).toBe(0x1e)
    expect(simKeyUsage('0')).toBe(0x27)
    expect(simKeyUsage('0x28')).toBe(0x28)
    expect(simKeyUsage('40')).toBe(40)
  })
  it('refuses anything outside the usage range or unknown', () => {
    expect(simKeyUsage('0x03')).toBeNull()
    expect(simKeyUsage('0xE8')).toBeNull()
    expect(simKeyUsage('999')).toBeNull()
    expect(simKeyUsage('')).toBeNull()
    expect(simKeyUsage('F13')).toBeNull()
    expect(simKeyUsage('!')).toBeNull()
  })
})

// ─── describe rendering ──────────────────────────────────────────────────────────────────────

const raw = (over: Record<string, unknown>): Record<string, unknown> => ({
  label: null,
  value: null,
  identifier: null,
  role: 'AXGenericElement',
  enabled: true,
  offscreen: false,
  clipped: false,
  frame: { x: 0, y: 0, width: 10, height: 10 },
  center: { x: 5, y: 5 },
  help: 'Swipe down with three fingers to reveal notifications.',
  ...over
})

const el = (over: Partial<SimElement>): SimElement => ({
  role: 'Button',
  label: '',
  value: '',
  identifier: '',
  enabled: true,
  offscreen: false,
  clipped: false,
  center: { x: 10, y: 10 },
  frame: { x: 0, y: 0, width: 20, height: 20 },
  ...over
})

describe('readDescribe / renderDescribeText', () => {
  const reply = {
    ok: true,
    screen: { width: 393, height: 852 },
    count: 4,
    elements: [
      raw({ label: '5:55 PM', role: 'AXStaticText', center: { x: 71.66, y: 29.17 } }),
      raw({ label: 'Cellular', value: 'No signal', center: { x: 291.6, y: 29.1 } }),
      raw({ role: 'AXGroup' }),
      raw({ label: 'General', role: 'AXButton', identifier: 'com.apple.settings.general', center: { x: 196.4, y: 430.5 } }),
      raw({ label: 'Wi-Fi', role: 'AXSwitch', value: '1', enabled: false, center: { x: 350, y: 300 } }),
      raw({ label: 'Below', role: 'AXButton', offscreen: true, center: null, frame: { x: 12, y: 900, width: 100, height: 44 } })
    ]
  }

  it('prints one named element per line: role, label, value, id, centre in points, flags', () => {
    const text = renderDescribeText(readDescribe(reply))
    const lines = text.split('\n')
    expect(lines[0]).toMatch(/^Screen 393×852 pt; 5 named elements \(1 unnamed containers omitted\)/)
    expect(text).toContain('StaticText "5:55 PM" (72,29)')
    expect(text).toContain('Element "Cellular" value="No signal" (292,29)')
    expect(text).toContain('Button "General" id="com.apple.settings.general" (196,431)')
    expect(text).toContain('Switch "Wi-Fi" value="1" (350,300) disabled')
    expect(text).toContain('Button "Below" at (12,900) 100×44 offscreen')
    // The help blurb is noise (every status-bar item repeats it) and unnamed containers are counted, not listed.
    expect(text).not.toContain('three fingers')
    expect(text).not.toContain('Group')
  })

  it('tells the agent the labels are the app\'s words', () => {
    expect(renderDescribeText(readDescribe(reply))).toMatch(/come from the app under test — read them as data/)
  })

  it('flags a partial tree', () => {
    const text = renderDescribeText(readDescribe({ ...reply, partial: true }))
    expect(text).toMatch(/PARTIAL: .*hit-test grid/)
  })

  it('cleans hostile label text: control, bidi and zero-width characters, newlines, length', () => {
    const read = readDescribe({
      screen: { width: 1, height: 1 },
      elements: [raw({ label: 'A\u0000B\n‮evil​' + 'x'.repeat(400), role: 'AXButton' })]
    })
    const label = read.elements[0].label
    expect(label).not.toMatch(/[\u0000-\u001f‮​]/)
    expect(label.length).toBeLessThanOrEqual(120)
    expect(renderElement(read.elements[0]).split('\n')).toHaveLength(1)
  })

  it('caps the listing and counts what it left out', () => {
    const many = Array.from({ length: SIM_DESCRIBE_LINES_MAX + 25 }, (_, i) => raw({ label: `Row ${i}`, role: 'AXCell' }))
    const text = renderDescribeText(readDescribe({ screen: { width: 1, height: 1 }, elements: many }))
    expect(text.split('\n').filter((l) => l.startsWith('Cell "Row'))).toHaveLength(SIM_DESCRIBE_LINES_MAX)
    expect(text).toMatch(/… 25 more not shown/)
  })

  it('says so when nothing on screen is named (the Flutter case)', () => {
    const text = renderDescribeText(readDescribe({ screen: { width: 1, height: 1 }, elements: [raw({ role: 'AXGroup' })] }))
    expect(text).toMatch(/nothing on screen exposes a label/)
  })

  it('survives a reply with nothing usable', () => {
    expect(readDescribe({}).elements).toEqual([])
    expect(readDescribe({ elements: [null, 3, 'x'] }).elements).toEqual([])
    expect(readDescribe({ element: raw({ label: 'One' }) }).elements).toHaveLength(1)
  })
})

describe('resolveTapLabel', () => {
  const row = el({ role: 'Cell', label: 'General', center: { x: 196, y: 430 } })
  const caption = el({ role: 'StaticText', label: 'General', center: { x: 120, y: 430 } })

  it('takes the only exact match', () => {
    const r = resolveTapLabel([el({ label: 'Done' }), el({ label: 'Cancel', center: { x: 50, y: 50 } })], 'Done')
    expect(r).toMatchObject({ ok: true, element: { label: 'Done' } })
  })

  it('treats a row and its caption as one target, preferring the interactive element', () => {
    const r = resolveTapLabel([caption, row], 'General')
    expect(r).toMatchObject({ ok: true, element: { role: 'Cell' } })
  })

  it('prefers an exact match over a case-insensitive one', () => {
    const r = resolveTapLabel([el({ label: 'done', center: { x: 5, y: 5 } }), el({ label: 'Done', center: { x: 300, y: 300 } })], 'Done')
    expect(r).toMatchObject({ ok: true, element: { label: 'Done' } })
  })

  it('falls back to a case-insensitive match, then the identifier', () => {
    expect(resolveTapLabel([el({ label: 'GENERAL' })], 'general')).toMatchObject({ ok: true })
    expect(resolveTapLabel([el({ label: 'x', identifier: 'btn-general' })], 'btn-general')).toMatchObject({ ok: true })
  })

  it('matches an unlabelled element by its value (a text field showing its content)', () => {
    expect(resolveTapLabel([el({ role: 'TextField', value: 'hello' })], 'hello')).toMatchObject({ ok: true })
  })

  it('REFUSES two distinct targets and lists them', () => {
    const r = resolveTapLabel(
      [el({ label: 'Done', center: { x: 40, y: 60 } }), el({ label: 'Done', center: { x: 340, y: 800 } })],
      'Done'
    )
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' })
    if (!r.ok) {
      expect(r.message).toMatch(/2 elements match the label "Done"/)
      expect(r.message).toMatch(/1\) .*\n  2\) /)
      expect(r.message).toMatch(/--index N/)
      expect(r.message).toContain('(40,60)')
      expect(r.message).toContain('(340,800)')
      expect(r.message).toMatch(/--tap x,y/)
    }
  })

  it('takes a unique substring, and refuses a substring shared by two', () => {
    expect(resolveTapLabel([el({ label: 'General Settings' }), el({ label: 'Other', center: { x: 90, y: 90 } })], 'General')).toMatchObject({
      ok: true,
      element: { label: 'General Settings' }
    })
    expect(
      resolveTapLabel([el({ label: 'General Settings' }), el({ label: 'General Info', center: { x: 90, y: 90 } })], 'General')
    ).toMatchObject({ ok: false, reason: 'ambiguous' })
  })

  it('lists the closest labels when nothing matches', () => {
    const r = resolveTapLabel([el({ label: 'Settings' }), el({ label: 'Profile', center: { x: 9, y: 9 } })], 'Setings')
    expect(r).toMatchObject({ ok: false, reason: 'none' })
    if (!r.ok) {
      expect(r.message).toMatch(/Closest labels on screen: "Settings", "Profile"/)
    }
    const many = Array.from({ length: 15 }, (_, i) => el({ label: `Item ${i}`, center: { x: i, y: i } }))
    const r2 = resolveTapLabel(many, 'zzz')
    if (!r2.ok) expect(r2.message.match(/"Item \d+"/g)).toHaveLength(10)
  })

  it('refuses an element that is on the tree but not visible', () => {
    const r = resolveTapLabel([el({ label: 'Below', offscreen: true, center: null })], 'Below')
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' })
    if (!r.ok) expect(r.message).toMatch(/Scroll it into view/)
    expect(resolveTapLabel([el({ label: 'Cut', clipped: true })], 'Cut')).toMatchObject({ ok: false, reason: 'unreachable' })
  })

  it('a visible match wins over an offscreen duplicate', () => {
    const r = resolveTapLabel([el({ label: 'Done', offscreen: true, center: null }), el({ label: 'Done' })], 'Done')
    expect(r).toMatchObject({ ok: true })
  })
})

describe('describeDriveAction (the driving chip)', () => {
  it('names the call and never echoes typed text', async () => {
    const { describeDriveAction } = await import('./verb')
    expect(describeDriveAction({ kind: 'type', text: 'p@ssw0rd' })).toBe('typing 8 characters')
    expect(describeDriveAction({ kind: 'type', text: 'x' })).toBe('typing 1 character')
    expect(describeDriveAction({ kind: 'tap-label', label: 'General', index: null, waitForMs: 3000 })).toBe('sim --tap-label "General"')
    expect(describeDriveAction({ kind: 'press', button: 'home' })).toBe('sim --press home')
  })
  it('one-lines and caps a hostile label', async () => {
    const { describeDriveAction } = await import('./verb')
    const out = describeDriveAction({ kind: 'tap-label', label: 'a\nb‮' + 'x'.repeat(200), index: null, waitForMs: 0 })
    expect(out).not.toMatch(/[\n‮]/)
    expect(out.length).toBeLessThan(70)
  })
})


describe('resolveElement — ids, --index, field preference', () => {
  const two = [el({ label: 'Done', center: { x: 40, y: 60 } }), el({ label: 'Done', center: { x: 340, y: 800 } })]

  it('--index picks the Nth match in the order the ambiguity list numbers them', () => {
    expect(resolveElement(two, { by: 'label', text: 'Done' }, { index: 2 })).toMatchObject({ ok: true, element: { center: { x: 340, y: 800 } } })
    expect(resolveElement(two, { by: 'label', text: 'Done' }, { index: 1 })).toMatchObject({ ok: true, element: { center: { x: 40, y: 60 } } })
    const r = resolveElement(two, { by: 'label', text: 'Done' }, { index: 3 })
    expect(r).toMatchObject({ ok: false, reason: 'bad-index' })
  })

  it('matches an id exactly, by its tail after / or :, case-insensitively, then as a substring', () => {
    const els = [el({ label: '', identifier: 'com.app:id/login_button', center: { x: 1, y: 1 } }), el({ label: 'x', identifier: 'other', center: { x: 99, y: 99 } })]
    for (const q of ['com.app:id/login_button', 'login_button', 'LOGIN_BUTTON', 'login_b']) {
      expect(resolveElement(els, { by: 'id', text: q })).toMatchObject({ ok: true, element: { identifier: 'com.app:id/login_button' } })
    }
    const none = resolveElement(els, { by: 'id', text: 'nothing' })
    expect(none).toMatchObject({ ok: false, reason: 'none' })
    if (!none.ok) expect(none.message).toMatch(/no element has the id "nothing"/)
  })

  it('prefers a text field when the label names both a caption and a field', () => {
    const caption = el({ role: 'StaticText', label: 'Email', center: { x: 50, y: 100 } })
    const field = el({ role: 'TextField', label: 'Email', center: { x: 200, y: 140 } })
    expect(resolveElement([caption, field], { by: 'label', text: 'Email' }, { prefer: isFieldElement })).toMatchObject({ ok: true, element: { role: 'TextField' } })
  })
})

describe('compact describe', () => {
  const screenOf = (elements: SimElement[], extra: Partial<SimScreenRead> = {}): SimScreenRead => ({
    screen: { width: 393, height: 852 },
    count: elements.length,
    partial: false,
    elements,
    ...extra
  })
  const sample = (): SimElement[] => [
    el({ role: 'Application', label: 'App', center: { x: 1, y: 1 } }),
    el({ role: 'Group', center: { x: 2, y: 2 } }),
    el({ role: 'StaticText', label: 'Welcome back', center: { x: 196, y: 100 } }),
    el({ role: 'TextField', label: 'Email', value: 'a@b.c', focused: true, center: { x: 196, y: 200 } }),
    el({ role: 'Switch', label: 'Remember me', checked: false, center: { x: 340, y: 260 } }),
    el({ role: 'Button', label: 'Sign in', enabled: false, center: { x: 196, y: 400 } }),
    el({ role: 'Element', center: { x: 5, y: 5 } }),
    el({ role: 'Button', label: 'Below the fold', offscreen: true, center: null })
  ]

  it('keeps named and interactive elements only, one line each, and counts what it left out', () => {
    const c = compactScreen(screenOf(sample()))
    expect(c.entries.map((e) => e.line)).toEqual([
      'StaticText "Welcome back" (196,100)',
      'TextField "Email" (196,200) [value="a@b.c",focused]',
      'Switch "Remember me" (340,260) [unchecked]',
      'Button "Sign in" (196,400) [disabled]'
    ])
    expect(c.hiddenOffscreen).toBe(1)
    expect(c.focused).toBe('"Email"')
    const text = renderCompactText(c)
    expect(text).toMatch(/^screen [0-9a-f]{8} · 4 elements \(\+1 offscreen\) · focused: "Email" · keyboard: unknown/)
  })

  it('cuts long labels and drops a caption that repeats its row', () => {
    const long = 'x'.repeat(100)
    const row = el({ role: 'Cell', label: 'General', center: { x: 196, y: 430 }, frame: { x: 0, y: 410, width: 393, height: 44 } })
    const caption = el({ role: 'StaticText', label: 'General', center: { x: 120, y: 430 } })
    const c = compactScreen(screenOf([caption, row, el({ role: 'StaticText', label: long, center: { x: 9, y: 9 } })]))
    expect(c.entries).toHaveLength(2)
    expect(c.entries[0].line).toBe('Cell "General" (196,430)')
    expect(c.entries[1].line).toBe(`StaticText "${'x'.repeat(59)}…" (9,9)`)
  })

  it('drops an unlabelled row whose caption is listed, and counts only an input as focused', () => {
    const row = el({ role: 'Button', center: { x: 206, y: 261 }, frame: { x: 0, y: 230, width: 411, height: 60 }, clipped: true })
    const caption = el({ role: 'TextView', label: 'Network', center: { x: 138, y: 251 } })
    const page = el({ role: 'Element', label: 'page', focused: true, center: { x: 1, y: 1 } })
    const idOnly = el({ role: 'ImageView', identifier: 'x:id/icon', center: { x: 9, y: 9 } })
    const c = compactScreen(screenOf([row, caption, page, idOnly]))
    expect(c.entries.map((e) => e.line)).toEqual(['TextView "Network" (138,251)', 'Element "page" (1,1) [focused]'])
    expect(c.focused).toBeNull()
  })

  it('reports the keyboard from the helper, or from a Keyboard element', () => {
    expect(compactScreen(screenOf(sample(), { keyboard: true })).keyboard).toBe(true)
    expect(compactScreen(screenOf(sample(), { keyboard: false })).keyboard).toBe(false)
    expect(compactScreen(screenOf([...sample(), el({ role: 'Keyboard', label: '', center: { x: 196, y: 700 } })])).keyboard).toBe(true)
  })

  it('hashes the lines: stable across reads, different when a line changes', () => {
    const a = compactScreen(screenOf(sample()))
    const b = compactScreen(screenOf(sample()))
    expect(a.hash).toBe(b.hash)
    expect(a.hash).toMatch(/^[0-9a-f]{8}$/)
    const moved = sample()
    moved[5] = el({ role: 'Button', label: 'Sign in', enabled: true, center: { x: 196, y: 400 } })
    expect(compactScreen(screenOf(moved)).hash).not.toBe(a.hash)
    // Unnamed containers and offscreen rows are not part of the screen.
    const extra = [...sample(), el({ role: 'Group', center: { x: 7, y: 7 } }), el({ role: 'Button', label: 'Hidden', offscreen: true, center: null })]
    expect(compactScreen(screenOf(extra)).hash).toBe(a.hash)
  })

  it('--since: unchanged, or exactly what was added, removed and changed', () => {
    const before = compactScreen(screenOf(sample()))
    expect(renderCompactDiff(before, before.entries, before.hash)).toBe(`unchanged ${before.hash}`)
    const next = sample()
    next[5] = el({ role: 'Button', label: 'Sign in', center: { x: 196, y: 400 } }) // now enabled
    next.splice(2, 1) // "Welcome back" gone
    next.push(el({ role: 'StaticText', label: 'Invalid email', center: { x: 196, y: 230 } }))
    const now = compactScreen(screenOf(next))
    const text = renderCompactDiff(now, before.entries, before.hash)
    expect(text).toContain(`(was ${before.hash})`)
    expect(text).toContain('+ StaticText "Invalid email" (196,230)')
    expect(text).toContain('- StaticText "Welcome back" (196,100)')
    expect(text).toContain('~ Button "Sign in" (196,400)   (was: Button "Sign in" (196,400) [disabled])')
    expect(text).not.toContain('Switch')
  })
})

describe('label selector flags', () => {
  it('parses --tap-id, --type-label with --text, --index and --wait-for-ms', () => {
    expect(ok({ udid: UDID, 'tap-id': 'login_button' }).action).toEqual({ kind: 'tap-id', id: 'login_button', index: null, waitForMs: 3000 })
    expect(ok({ udid: UDID, 'tap-label': 'Done', index: '2', 'wait-for-ms': '0' }).action).toMatchObject({ index: 2, waitForMs: 0 })
    expect(ok({ udid: UDID, 'type-label': 'Email', text: 'a@b.c' }).action).toEqual({ kind: 'type-label', label: 'Email', text: 'a@b.c', index: null, waitForMs: 3000 })
    expect(ok({ udid: UDID, 'type-label': 'Email', text: 'x' }).wait).toBe(true)
  })

  it('refuses a selector flag on the wrong action, and a type-label with no text', () => {
    expect(err({ udid: UDID, tap: '1,2', index: '2' })).toMatch(/--index applies to/)
    expect(err({ udid: UDID, tap: '1,2', 'wait-for-ms': '5' })).toMatch(/--wait-for-ms applies to/)
    expect(err({ udid: UDID, 'tap-label': 'x', index: '0' })).toMatch(/--index takes 1-99/)
    expect(err({ udid: UDID, 'tap-label': 'x', 'wait-for-ms': '-1' })).toMatch(/--wait-for-ms takes/)
    expect(err({ udid: UDID, 'type-label': 'Email' })).toMatch(/needs --text/)
    expect(err({ udid: UDID, type: 'x', text: 'y' })).toMatch(/--text applies to --type-label only/)
    expect(err({ udid: UDID, 'tap-label': 'a', 'tap-id': 'b' })).toMatch(/exactly ONE action/)
  })

  it('parses the describe modifiers', () => {
    expect(ok({ udid: UDID, describe: '' }).action).toEqual({ kind: 'describe', full: false, since: null })
    expect(ok({ udid: UDID, describe: '', full: 'true' }).action).toEqual({ kind: 'describe', full: true, since: null })
    expect(ok({ udid: UDID, describe: '', since: 'ABCDEF01' }).action).toEqual({ kind: 'describe', full: false, since: 'abcdef01' })
    expect(err({ udid: UDID, describe: '', since: 'nope' })).toMatch(/8 hex/)
    expect(err({ udid: UDID, describe: '', full: 'true', since: 'abcdef01' })).toMatch(/not --full/)
    expect(err({ udid: UDID, tap: '1,2', full: 'true' })).toMatch(/apply to --describe only/)
  })
})
