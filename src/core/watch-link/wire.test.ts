import { describe, it, expect } from 'vitest'
import { hkdfSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { encodePtyData, encodeArgs, parseRpcMessage } from '../../shared/rpc'
import { decrypt, deriveSessionKey, encrypt, randomSessionNonce } from '../relay/e2ee'
import { hkdfSha256 } from '../../shared/watch-link/hkdf'
import { sealBox, openBox, withHeader, readHeader, encodePtyFrame, decodePtyFrame, parseTunnelJson, NONCE_BYTES, RELAY_SESSION_INFO } from '../../shared/watch-link/wire'
import {
  sanitizeChatText,
  sanitizeChatName,
  isWatchEndReason,
  CHAT_NAME_MAX,
  CHAT_TEXT_MAX,
  WATCH_CHAT_CAST,
  WATCH_EVENT,
  WATCH_EVENT_PREFIX
} from '../../shared/watch-link/protocol'
import { concatBytes, utf8 } from '../../shared/watch-link/bytes'
import { isHostOnlyChannel } from '../../shared/host-control'
import { BIDI_CONTROL_CHARS } from '../../shared/presence'

describe('the wire rules match the relay they were copied from', () => {
  it('HKDF equals node:crypto', async () => {
    const ikm = nacl.randomBytes(32), salt = nacl.randomBytes(32)
    const ours = await hkdfSha256(ikm, salt, utf8(RELAY_SESSION_INFO), 32)
    expect(ours).toEqual(new Uint8Array(hkdfSync('sha256', ikm, salt, utf8(RELAY_SESSION_INFO), 32)))
  })
  it("HKDF info and salt order equal the relay's deriveSessionKey", async () => {
    // The test above feeds OUR info string to both sides, so it cannot see the relay's change.
    // This one derives the relay's session key from its own code: salt = hostNonce ‖ clientNonce.
    const base = nacl.randomBytes(32), hn = randomSessionNonce(), cn = randomSessionNonce()
    expect(await hkdfSha256(base, concatBytes(hn, cn), utf8(RELAY_SESSION_INFO), 32)).toEqual(deriveSessionKey(base, hn, cn))
  })
  it("the session-key vectors nodeterm-web tests against are the relay's deriveSessionKey", () => {
    const vectors = JSON.parse(readFileSync(join(__dirname, '../../shared/watch-link/vectors.json'), 'utf8').replace(/\r\n/g, '\n'))
    const hex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'))
    expect(vectors.sessionKeys.length).toBeGreaterThan(0)
    for (const v of vectors.sessionKeys) {
      const key = deriveSessionKey(hex(v.baseKeyHex), hex(v.hostNonceHex), hex(v.clientNonceHex))
      expect(Buffer.from(key).toString('hex')).toBe(v.sessionKeyHex)
    }
  })
  it("the session nonce is as long as e2ee's randomSessionNonce", () => {
    expect(randomSessionNonce()).toHaveLength(NONCE_BYTES)
  })
  it('a box sealed here opens with e2ee.decrypt and vice versa', () => {
    const key = nacl.randomBytes(32), plain = utf8('hello')
    expect(decrypt(sealBox(plain, key), key)).toEqual(plain)
    expect(openBox(encrypt(plain, key), key)).toEqual(plain)
    expect(openBox(Uint8Array.of(1, 2, 3), key)).toBeNull()
  })
  it('the header is role, seq high word LE, seq low word LE', () => {
    const h = withHeader(2, 2 ** 32 + 7, utf8('x'))
    expect(Array.from(h.slice(0, 9))).toEqual([2, 1, 0, 0, 0, 7, 0, 0, 0])
    expect(readHeader(h)).toEqual({ role: 2, seq: 2 ** 32 + 7, body: utf8('x') })
    expect(readHeader(Uint8Array.of(1, 2))).toBeNull()
  })
  it('pty frames equal rpc.ts', () => {
    const sid = 'sess-é', data = 'a\u001b[31mbé'
    expect(encodePtyFrame(sid, data)).toEqual(encodePtyData(sid, data))
    expect(decodePtyFrame(encodePtyData(sid, data))).toEqual({ sessionId: sid, data })
    expect(decodePtyFrame(Uint8Array.of(9))).toBeNull()
  })
  it('tunnel JSON parses like parseRpcMessage, undefined slots included', () => {
    const ev = JSON.stringify({ t: 'ev', channel: 'watch:meta', ...encodeArgs([{ a: 1 }, undefined]) })
    expect(parseTunnelJson(ev)).toEqual(parseRpcMessage(ev))
    const cast = JSON.stringify({ t: 'cast', method: 'trust:confirm', args: [] })
    expect(parseTunnelJson(cast)).toEqual({ t: 'cast', method: 'trust:confirm', args: [] })
    expect(parseTunnelJson('{"t":"res","id":1,"ok":true,"result":1}')).toBeNull()
    expect(parseTunnelJson('nope')).toBeNull()
  })
  it('an `undef` list restores only valid slot indices; junk entries are ignored', () => {
    const m = parseTunnelJson(JSON.stringify({ t: 'ev', channel: 'c', args: ['a', 'b', 'c'], undef: [-1, 1.5, '0', 99, null, 2] }))
    expect(m).toEqual({ t: 'ev', channel: 'c', args: ['a', 'b', undefined] })
    // A non-list `undef` restores nothing.
    expect(parseTunnelJson(JSON.stringify({ t: 'ev', channel: 'c', args: ['a'], undef: 0 }))).toEqual({ t: 'ev', channel: 'c', args: ['a'] })
  })
  it('a pty frame whose session-id length runs past the frame is refused, not read short', () => {
    const f = encodePtyFrame('abc', 'data')
    expect(decodePtyFrame(f)).toEqual({ sessionId: 'abc', data: 'data' })
    const lying = f.slice()
    lying[1] = 0xff // sidLen = 0xff03, far past the frame
    expect(decodePtyFrame(lying)).toBeNull()
    expect(decodePtyFrame(Uint8Array.of(0x01, 0x00, 0x05, 0x61, 0x62))).toBeNull() // sidLen 5, 2 bytes
  })
  it('readHeader reads a view that starts inside a larger buffer (a nonzero byteOffset)', () => {
    const h = withHeader(2, 2 ** 32 + 7, utf8('xy'))
    const backing = new Uint8Array(h.length + 13)
    backing.fill(0xee)
    backing.set(h, 5)
    const view = backing.subarray(5, 5 + h.length)
    expect(view.byteOffset).toBe(5)
    expect(readHeader(view)).toEqual({ role: 2, seq: 2 ** 32 + 7, body: utf8('xy') })
  })
  it('every sealed frame draws a fresh box nonce (the caller cannot supply one)', () => {
    const key = nacl.randomBytes(32), plain = utf8('same')
    const a = sealBox(plain, key), b = sealBox(plain, key)
    expect(a.subarray(0, nacl.box.nonceLength)).not.toEqual(b.subarray(0, nacl.box.nonceLength))
    expect(sealBox.length).toBe(2)
  })
})

describe('protocol', () => {
  it('the viewer cast is not in the host-only owner namespace', () => {
    expect(WATCH_CHAT_CAST.startsWith('watchLink:')).toBe(false)
    expect(WATCH_EVENT_PREFIX).toBe('watch:')
  })
  // relay-host refuses a host-only channel from every peer BEFORE any policy runs: the viewer's one
  // cast, and every event the host sends a viewer, must not be one of them (asked of the real rule,
  // not of a prefix this test assumes).
  it('the viewer cast and every viewer event are not host-only channels', () => {
    expect(isHostOnlyChannel(WATCH_CHAT_CAST)).toBe(false)
    for (const ch of Object.values(WATCH_EVENT)) expect(isHostOnlyChannel(ch)).toBe(false)
    // …while the owner's namespace is.
    expect(isHostOnlyChannel('watchLink:create')).toBe(true)
  })
  it('sanitizes chat text and names', () => {
    expect(sanitizeChatText('  hi\u0007 there\nfriend \u009b ')).toBe('hi there friend')
    expect(sanitizeChatText('x'.repeat(600))).toHaveLength(500)
    expect(sanitizeChatText('   ')).toBeNull()
    expect(sanitizeChatText(42)).toBeNull()
    expect(sanitizeChatName('\u001b[31mAda')).toBe('[31mAda')
    expect(sanitizeChatName('n'.repeat(40))).toHaveLength(32)
    expect(isWatchEndReason('kicked')).toBe(true)
    expect(isWatchEndReason('nope')).toBe(false)
  })
  it('strips every bidi control, from text and from names', () => {
    // An RLO would reorder everything the owner's popover and every viewer draw after it.
    expect(sanitizeChatText('ok \u202Egnihsihp\u202C done')).toBe('ok gnihsihp done')
    expect(sanitizeChatName('Ada\u2066\u200F\u061C\u200E\u202A\u2069')).toBe('Ada')
    expect(sanitizeChatText('\u202E\u2067')).toBeNull()
    // A ZWJ is not a bidi control: an emoji sequence survives.
    expect(sanitizeChatText('hi \u{1F469}\u200D\u{1F4BB}')).toBe('hi \u{1F469}\u200D\u{1F4BB}')
  })
  it("chat strips every @shared/presence bidi control (restated: this directory imports nothing outside), and from text exactly the invisible format characters but the two joiners", () => {
    // Over the whole BMP, outside the controls and the whitespace the sanitizer handles anyway: a
    // character is stripped from chat TEXT if and only if it is a format character (Cf) other than
    // ZWNJ / ZWJ — and every one presence calls a bidi control is among them.
    const cf = /^\p{Cf}$/u
    let checked = 0
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) continue
      const ch = String.fromCharCode(cp)
      if (/\s/.test(ch)) continue
      BIDI_CONTROL_CHARS.lastIndex = 0
      const bidi = BIDI_CONTROL_CHARS.test(ch)
      const invisible = cf.test(ch) && cp !== 0x200c && cp !== 0x200d
      const stripped = sanitizeChatText(`a${ch}b`) === 'ab'
      if (bidi && !stripped) expect.fail(`U+${cp.toString(16)}: a presence bidi control kept in chat`)
      if (stripped !== invisible) expect.fail(`U+${cp.toString(16)}: invisible=${invisible}, stripped from chat=${stripped}`)
      if (bidi && sanitizeChatName(`a${ch}b`) !== 'ab') expect.fail(`U+${cp.toString(16)}: a presence bidi control kept in a name`)
      checked++
    }
    expect(checked).toBeGreaterThan(60_000)
  })
  it('a NAME keeps no invisible character: every format character, and the blank letters, go', () => {
    // Finding L4: "Sharer" and "Sharer" + an invisible character were two names drawn alike.
    for (const ch of ['\u200b', '\u200c', '\u200d', '\u2060', '\u00ad', '\ufeff', '\u034f', '\u115f', '\u1160', '\u2800', '\u3164', '\uffa0', '\u{e0041}', '\u{e007f}']) {
      expect(sanitizeChatName(`Sha${ch}rer${ch}`)).toBe('Sharer')
    }
    // Over the whole BMP: a name loses every format character.
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const ch = String.fromCharCode(cp)
      if (/^\p{Cf}$/u.test(ch) && sanitizeChatName(`a${ch}b`) !== 'ab') expect.fail(`U+${cp.toString(16)} kept in a name`)
    }
    // A name made only of them is no name.
    expect(sanitizeChatName('\u200b\u3164\u2800')).toBeNull()
    // Visible letters and emoji stay (an emoji sequence loses its joiner in a NAME: a name is a claim).
    expect(sanitizeChatName('Ayşe')).toBe('Ayşe')
    expect(sanitizeChatName('Ada \u{1F469}\u200D\u{1F4BB}')).toBe('Ada \u{1F469}\u{1F4BB}')
  })
  it('chat TEXT keeps the zero-width joiner (emoji sequences) and the non-joiner (Persian, the Indic scripts), and loses the other invisibles', () => {
    expect(sanitizeChatText('hi \u{1F469}\u200D\u{1F4BB}')).toBe('hi \u{1F469}\u200D\u{1F4BB}')
    expect(sanitizeChatText('\u0645\u06cc\u200c\u062e\u0648\u0627\u0645')).toBe('\u0645\u06cc\u200c\u062e\u0648\u0627\u0645')
    expect(sanitizeChatText('pass\u200bword\u00ad \u2060here\u{e0041}')).toBe('password here')
  })
  it('caps by code point, never leaving half a surrogate pair', () => {
    // 499 units, then an astral character (2 units): it does not fit in 500, so it is left out WHOLE.
    const text = sanitizeChatText('x'.repeat(CHAT_TEXT_MAX - 1) + '\u{1F600}tail')!
    expect(text).toBe('x'.repeat(CHAT_TEXT_MAX - 1))
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false)
    const name = sanitizeChatName('\u{1F600}'.repeat(40))!
    expect(name).toBe('\u{1F600}'.repeat(CHAT_NAME_MAX / 2))
    expect(name.length).toBe(CHAT_NAME_MAX)
  })
  it('bounds the raw input before the cleaning chain: a huge cast costs the cap, not its size', () => {
    // 4x the cap is read; anything past it never reaches the regex chain (and cannot reach the text).
    const huge = 'y'.repeat(CHAT_TEXT_MAX * 4) + 'MARKER' + 'z'.repeat(5_000_000)
    expect(sanitizeChatText(huge)).toBe('y'.repeat(CHAT_TEXT_MAX))
    // Whitespace and controls that collapse away inside the bound do not empty an honest message.
    expect(sanitizeChatText('\u0007'.repeat(CHAT_TEXT_MAX * 2) + 'hello')).toBe('hello')
    // A leading run longer than the bound is cut with it: the cleaned text may be EMPTY.
    expect(sanitizeChatText(' '.repeat(CHAT_TEXT_MAX * 4) + 'late')).toBeNull()
  })
})
