import { describe, expect, it } from 'vitest'
import { GrpcMessageReader, decodeImage, imageFormat, keyboardEvent, pbBytes, pbDecode, pbInt, pbNum, touchEvent } from './grpc'
import { BUTTON_KEYS, hidToKey, isTypable } from './keys'
import { avdOf, parseAvdList, parseDiscovery, parseIni, parseWmDensity, parseWmSize, runtimeLabel, sdkRootCandidates } from './sdk'
import { decodeEntities, hitTest, parseAttributes, parseBounds, parseDump, roleOf } from './uiautomator'

describe('protobuf', () => {
  it('round-trips varints and nested messages, omitting zero values', () => {
    const img = Buffer.concat([pbBytes(1, imageFormat(2, 600, 960)), pbBytes(4, Buffer.from([1, 2, 3])), pbInt(6, 1791818190988732)])
    const d = decodeImage(img)
    expect(d).toEqual({ format: 2, width: 600, height: 960, data: Buffer.from([1, 2, 3]), timestampUs: 1791818190988732 })
    expect(pbInt(1, 0).length).toBe(0)
  })
  it('encodes touches (x=0 is omitted, which IS 0) and key events', () => {
    const t = pbDecode(touchEvent([{ x: 0, y: 5, identifier: 1, pressure: 1 }]))
    const touch = pbDecode(t.get(1)![0] as Buffer)
    expect(touch.has(1)).toBe(false)
    expect(pbNum(touch, 2)).toBe(5)
    const k = pbDecode(keyboardEvent({ key: 'GoHome' }))
    expect(pbNum(k, 2)).toBe(2)
    expect((k.get(4)![0] as Buffer).toString()).toBe('GoHome')
  })
  it('refuses truncated input', () => {
    expect(() => pbDecode(Buffer.from([0x0a, 0x05, 1]))).toThrow()
  })
})

describe('sdk', () => {
  it('validates android ids', () => {
    expect(avdOf('android:Nexus_7')).toBe('Nexus_7')
    expect(avdOf('android:../x')).toBeNull()
    expect(avdOf('android:a b')).toBeNull()
    expect(avdOf('android:-wipe-data')).toBeNull()
    expect(avdOf('Nexus_7')).toBeNull()
  })
  it('orders SDK candidates: our env, the standard env vars, then the OS default', () => {
    expect(sdkRootCandidates({ ANDROID_HOME: '/h' }, 'darwin', '/Users/u')).toEqual(['/h', '/Users/u/Library/Android/sdk'])
    expect(sdkRootCandidates({}, 'linux', '/home/u')).toEqual(['/home/u/Android/Sdk'])
  })
  it('parses discovery files', () => {
    const ini = 'avd.id=Nexus_7\nport.serial=5554\ngrpc.port=8554\ncmdline="x"\n'
    expect(parseDiscovery(1, ini)).toMatchObject({ pid: 1, avd: 'Nexus_7', consolePort: 5554, grpcPort: 8554 })
    expect(parseDiscovery(1, 'avd.id=X\nport.serial=5556\ngrpc.token=t\n')).toMatchObject({ grpcToken: 't' })
    expect(parseDiscovery(1, 'avd.id=X\n')).toBeNull()
    expect(parseDiscovery(1, 'avd.id=X\nport.serial=5556\n')!.grpcPort).toBeUndefined()
  })
  it('parses wm output, preferring an override', () => {
    expect(parseWmSize('Physical size: 1200x1920\n')).toEqual({ width: 1200, height: 1920 })
    expect(parseWmSize('Physical size: 1080x2400\nOverride size: 720x1600\n')).toEqual({ width: 720, height: 1600 })
    expect(parseWmDensity('Physical density: 420\nOverride density: 320')).toBe(320)
    expect(parseWmSize('nope')).toBeNull()
  })
  it('labels runtimes and lists AVDs ignoring log lines', () => {
    expect(runtimeLabel('android-30')).toBe('Android 11')
    expect(runtimeLabel('android-99')).toBe('Android API 99')
    expect(parseAvdList('INFO    | Storing crashdata\nNexus_7\nPixel_6\n\n')).toEqual(['Nexus_7', 'Pixel_6'])
    expect(parseIni('a=b=c\n x = y ')).toEqual({ a: 'b=c', x: 'y' })
  })
})

describe('uiautomator', () => {
  const xml =
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
    `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" content-desc="" clickable="false" enabled="true" bounds="[0,0][1200,1920]">` +
    `<node index="0" text="Display" resource-id="android:id/title" class="android.widget.TextView" content-desc="" clickable="false" enabled="true" bounds="[100,500][300,600]" />` +
    `<node index="1" text="" resource-id="" class="android.view.View" content-desc="Save &amp; quit" clickable="true" enabled="false" bounds="[0,1800][1200,2100]" />` +
    `<node index="2" text="secret" class="android.widget.EditText" password="true" bounds="[0,2000][100,2100]" />` +
    `</node></hierarchy>`
  it('converts pixels to points and fills the iOS element shape', () => {
    const { flat, tree } = parseDump(xml, 2, { width: 600, height: 960 })
    expect(flat).toHaveLength(4)
    expect(tree!.children).toHaveLength(1)
    const d = flat[1]
    expect(d).toMatchObject({ label: 'Display', identifier: 'android:id/title', role: 'TextView', depth: 1, offscreen: false, clipped: false })
    expect(d.frame).toEqual({ x: 50, y: 250, width: 100, height: 50 })
    expect(d.center).toEqual({ x: 100, y: 275 })
    const b = flat[2]
    expect(b).toMatchObject({ label: 'Save & quit', role: 'Button', enabled: false, clipped: true })
    expect(b.visibleFrame).toEqual({ x: 0, y: 900, width: 600, height: 60 })
    const pw = flat[3]
    expect(pw).toMatchObject({ label: '', value: '', role: 'TextField', password: true, offscreen: true })
    expect(pw.center).toBeUndefined()
  })
  it('reads a text field’s typed text as its value, not its label (Flutter EditText, API 30)', () => {
    const f =
      `<hierarchy rotation="0">` +
      `<node NAF="true" index="2" text="agent@example.com" resource-id="" class="android.widget.EditText" content-desc="" clickable="true" password="false" bounds="[42,475][1038,633]" />` +
      `<node index="3" text="" class="android.widget.EditText" content-desc="" hint="Enter your password" password="true" bounds="[42,748][1038,906]" />` +
      `<node index="4" text="Hi" class="android.widget.EditText" content-desc="Name" bounds="[42,900][1038,1000]" />` +
      `</hierarchy>`
    const [email, pw, name] = parseDump(f, 2.625, { width: 411.43, height: 914.29 }).flat
    expect(email).toMatchObject({ role: 'TextField', label: '', value: 'agent@example.com' })
    expect(pw).toMatchObject({ role: 'TextField', label: 'Enter your password', value: '', password: true })
    expect(name).toMatchObject({ label: 'Name', value: 'Hi' })
  })
  it('hit-tests the deepest visible element', () => {
    const { flat } = parseDump(xml, 2, { width: 600, height: 960 })
    expect(hitTest(flat, 100, 270)!.label).toBe('Display')
    expect(hitTest(flat, 5, 5)!.role).toBe('Element')
  })
  it('never throws on junk', () => {
    expect(parseDump('<<<>>> <node bounds="x"', 2, { width: 1, height: 1 }).flat.length).toBeLessThanOrEqual(1)
    expect(parseDump('', 2, { width: 1, height: 1 })).toEqual({ tree: null, flat: [] })
  })
  it('decodes attributes and entities', () => {
    expect(parseAttributes(' a="1" b="x &lt;y&gt;" c=\'z\' /')).toEqual({ a: '1', b: 'x <y>', c: 'z' })
    expect(decodeEntities('&#x1F600;&#65;&bogus;')).toBe('😀A&bogus;')
    expect(parseBounds('[1,2][3,4]')).toEqual({ l: 1, t: 2, r: 3, b: 4 })
    expect(parseBounds('[1,2]')).toBeNull()
    expect(roleOf('android.widget.FrameLayout', true)).toBe('Button')
    expect(roleOf('', false)).toBe('Element')
  })
})

describe('keys', () => {
  it('maps HID usages', () => {
    expect(hidToKey(0x28)).toBe('Enter')
    expect(hidToKey(0x04)).toBe('a')
    expect(hidToKey(0x04, true)).toBe('A')
    expect(hidToKey(0x1e, true)).toBe('!')
    expect(hidToKey(0x27)).toBe('0')
    expect(hidToKey(0x38, true)).toBe('?')
    expect(hidToKey(0x3a)).toBe('F1')
    expect(hidToKey(0x99)).toBeNull()
  })
  it('maps buttons, refusing the iOS-only ones', () => {
    expect(BUTTON_KEYS.home).toBe('GoHome')
    expect(BUTTON_KEYS.back).toBe('GoBack')
    expect(BUTTON_KEYS.siri).toBeUndefined()
    expect(BUTTON_KEYS.playpause).toBeUndefined()
  })
  it('types ASCII and pastes the rest', () => {
    expect(isTypable('Hello 123!\n')).toBe(true)
    expect(isTypable('Café')).toBe(false)
  })
})

describe('adb input fallback (no hardware keyboard)', () => {
  it('batches plain keycodes and types the rest one quoted character at a time', async () => {
    const { inputTextScript, inputKeyScript } = await import('./keys')
    expect(inputTextScript('def')).toBe('input keyevent 32 33 34')
    expect(inputTextScript('a@b.c 1')).toBe('input keyevent 29 77 30 56 31 62 8')
    expect(inputTextScript('Hi!')).toBe("input text 'H'; input keyevent 37; input text '!'")
    expect(inputTextScript("it's")).toBe('input keyevent 37 48 75 47')
    expect(inputTextScript('"$(x)')).toBe(`input text '"'; input text '$'; input text '('; input keyevent 52; input text ')'`)
    expect(inputKeyScript(0x28, false)).toBe('input keyevent 66')
    expect(inputKeyScript(0x04, true)).toBe("input text 'A'")
    expect(inputKeyScript(0x99, false)).toBeNull()
  })
  it('reads hw.keyboard from the running instance', async () => {
    const { hardwareKeyboard } = await import('./sdk')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-'))
    fs.writeFileSync(path.join(dir, 'hardware-qemu.ini'), 'hw.keyboard = false\n')
    expect(hardwareKeyboard(dir)).toBe(false)
    fs.writeFileSync(path.join(dir, 'hardware-qemu.ini'), 'hw.keyboard = true\n')
    expect(hardwareKeyboard(dir)).toBe(true)
    expect(hardwareKeyboard(path.join(dir, 'nope'))).toBeNull()
    expect(hardwareKeyboard(undefined)).toBeNull()
    fs.rmSync(dir, { recursive: true })
  })
})

describe('GrpcMessageReader', () => {
  const frameOf = (payload: Buffer, compressed = 0): Buffer => {
    const head = Buffer.alloc(5)
    head[0] = compressed
    head.writeUInt32BE(payload.length, 1)
    return Buffer.concat([head, payload])
  }
  const payloads = [Buffer.from('a'), Buffer.alloc(0), Buffer.alloc(70_000, 7), Buffer.from('hello world'), Buffer.alloc(5, 9)]
  const wire = Buffer.concat(payloads.map((p) => frameOf(p)))

  it('yields every message whatever the chunk boundaries (1 byte, odd sizes, the whole wire)', () => {
    for (const size of [1, 2, 3, 4, 5, 6, 7, 1000, 16_384, 65_536, wire.length]) {
      const r = new GrpcMessageReader()
      const got: Buffer[] = []
      for (let i = 0; i < wire.length; i += size) got.push(...r.push(wire.subarray(i, i + size)))
      expect(got.map((b) => b.length), `chunk ${size}`).toEqual(payloads.map((p) => p.length))
      got.forEach((b, i) => expect(b.equals(payloads[i]), `chunk ${size} message ${i}`).toBe(true))
      expect(r.pending).toBe(0)
    }
  })

  it('returns several messages from one chunk and holds a partial one back', () => {
    const r = new GrpcMessageReader()
    const two = Buffer.concat([frameOf(Buffer.from('one')), frameOf(Buffer.from('two'))])
    const third = frameOf(Buffer.from('three'))
    const out = r.push(Buffer.concat([two, third.subarray(0, 4)]))
    expect(out.map(String)).toEqual(['one', 'two'])
    expect(r.pending).toBe(4)
    expect(r.push(third.subarray(4)).map(String)).toEqual(['three'])
    expect(r.pending).toBe(0)
  })

  it('does not copy a message that arrives whole in one chunk, and joins a split one exactly once', () => {
    const r = new GrpcMessageReader()
    const f = frameOf(Buffer.alloc(100, 1))
    const [m] = r.push(f)
    expect(m.buffer).toBe(f.buffer) // a view of the chunk, no copy
    const big = frameOf(Buffer.alloc(40_000, 2))
    const parts: Buffer[] = []
    for (let i = 0; i < big.length; i += 16_384) parts.push(big.subarray(i, i + 16_384))
    const got = parts.flatMap((c) => r.push(c))
    expect(got).toHaveLength(1)
    expect(got[0].length).toBe(40_000)
  })

  it('ignores an empty chunk', () => {
    const r = new GrpcMessageReader()
    expect(r.push(Buffer.alloc(0))).toEqual([])
    expect(r.pending).toBe(0)
  })
})
