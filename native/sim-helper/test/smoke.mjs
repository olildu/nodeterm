#!/usr/bin/env node
// Smoke test for sim-helper: spawns `attach` against a booted device and exercises every command.
//   node native/sim-helper/test/smoke.mjs [--udid <udid>] [--bin <path>] [--out <dir>] [--recovery]
// Needs a BOOTED simulator (it launches Settings on it and leaves it on the home screen).
// --recovery additionally restarts backboardd and then shuts the device down and boots it again.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const BIN = arg('--bin', path.resolve(here, '../../../resources/bin/sim-helper'))
const OUT = arg('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'sim-helper-smoke-')))
const RECOVERY = args.includes('--recovery')
fs.mkdirSync(OUT, { recursive: true })

const sh = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
function bootedUdid() {
  const j = JSON.parse(sh('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']))
  for (const list of Object.values(j.devices)) for (const d of list) if (d.state === 'Booted') return d.udid
  throw new Error('no booted simulator — boot one with: xcrun simctl boot <udid>')
}
const UDID = arg('--udid', null) ?? bootedUdid()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- tiny framing parser: u32be len | u8 type | payload (len counts type + payload) -------------
class Client {
  constructor(bin, udid) {
    this.p = spawn(bin, ['attach', udid], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.buf = Buffer.alloc(0)
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    this.frames = []
    this.images = new Map()
    this.stderr = ''
    this.waiters = []
    this.exit = new Promise((r) => this.p.once('exit', (code, sig) => r({ code, sig })))
    this.p.stderr.on('data', (d) => { this.stderr += d })
    this.p.stdout.on('data', (d) => this.onData(d))
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d])
    for (;;) {
      if (this.buf.length < 5) return
      const len = this.buf.readUInt32BE(0)
      if (this.buf.length < 4 + len) return
      const type = this.buf[4]
      const payload = this.buf.subarray(5, 4 + len)
      this.buf = this.buf.subarray(4 + len)
      this.onMessage(type, Buffer.from(payload))
    }
  }
  onMessage(type, p) {
    if (type === 1) {
      const micros = Number(p.readBigUInt64BE(0))
      this.frames.push({ at: Date.now(), captureMs: micros / 1000, w: p.readUInt16BE(8), h: p.readUInt16BE(10), jpeg: p.subarray(12) })
    } else if (type === 3) {
      this.images.set(p.readUInt32BE(0), { fmt: p[4], w: p.readUInt16BE(5), h: p.readUInt16BE(7), data: p.subarray(9) })
    } else if (type === 2) {
      const m = JSON.parse(p.toString('utf8'))
      if (m.event) { this.events.push(m); this.waiters = this.waiters.filter((w) => !w(m)) }
      else if (this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id) }
    } else throw new Error('unknown message type ' + type)
  }
  send(cmd, fields = {}, timeoutMs = 15000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for reply to ${cmd}`)), timeoutMs)
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m) })
      this.p.stdin.write(JSON.stringify({ id, cmd, ...fields }) + '\n')
    })
  }
  notify(cmd, fields = {}) { this.p.stdin.write(JSON.stringify({ cmd, quiet: true, ...fields }) + '\n') }
  waitEvent(name, timeoutMs = 15000, pred = () => true) {
    const have = this.events.find((e) => e.event === name && pred(e))
    if (have) return Promise.resolve(have)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for event ${name}`)), timeoutMs)
      this.waiters.push((m) => (m.event === name && pred(m) ? (clearTimeout(t), resolve(m), true) : false))
    })
  }
}

// ---- tests ---------------------------------------------------------------------------------
const results = []
async function test(name, fn) {
  const t0 = Date.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail: detail ?? '', ms: Date.now() - t0 })
  } catch (e) {
    results.push({ name, ok: false, detail: String(e.message ?? e), ms: Date.now() - t0 })
  }
}
const assert = (c, m) => { if (!c) throw new Error(m) }
const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9
const isPng = (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
const labelOf = (e) => (e.label ?? '') + ''
const find = (els, pred) => els.find(pred)
const center = (e) => e.center
const simctl = (...a) => sh('xcrun', ['simctl', ...a])
const describeFlat = async (c) => { const r = await c.send('describe', { flat: true }); assert(r.ok, `describe: ${r.error}`); return r }

console.log(`sim-helper smoke — bin=${BIN}\n  device=${UDID}\n  out=${OUT}\n`)
assert(fs.existsSync(BIN), `missing ${BIN} — run: npm run build:sim-helper`)

await test('--version / list', async () => {
  const v = sh(BIN, ['--version']).trim()
  const l = JSON.parse(sh(BIN, ['list']))
  const mine = l.find((d) => d.udid === UDID)
  assert(mine && mine.state === 'Booted', 'device not listed as Booted')
  return `${v}; ${l.length} device(s); ${mine.name} / ${mine.runtime}`
})

try { simctl('terminate', UDID, 'com.apple.Preferences') } catch {}
const c = new Client(BIN, UDID)
let info
await test('ready event', async () => {
  const e = await c.waitEvent('ready', 20000)
  info = e.device
  assert(info.pointWidth > 0 && info.pixelWidth === info.pointWidth * info.scale, 'point/pixel mismatch')
  return `${info.name} ${info.pixelWidth}x${info.pixelHeight}px @${info.scale}x = ${info.pointWidth}x${info.pointHeight}pt`
})
await test('info', async () => {
  const r = await c.send('info')
  assert(r.ok && r.device.state === 'Booted' && r.device.ready === true, JSON.stringify(r))
  return `state=${r.device.state} runtime=${r.device.runtime}`
})
await test('ping', async () => {
  const t = []
  for (let i = 0; i < 20; i++) { const s = process.hrtime.bigint(); await c.send('ping'); t.push(Number(process.hrtime.bigint() - s) / 1e6) }
  t.sort((a, b) => a - b)
  return `rtt p50 ${t[10].toFixed(2)}ms max ${t[19].toFixed(2)}ms`
})
await test('bad requests', async () => {
  const a = await c.send('nope')
  const b = await c.send('tap', { x: 'a' })
  const d = await c.send('tap', { x: -50, y: 10 })
  const e = await c.send('button', { name: 'bogus' })
  assert(!a.ok && a.code === 'unknown-command', 'unknown cmd')
  assert(!b.ok && b.code === 'bad-request', 'bad tap')
  assert(!d.ok && d.code === 'out-of-bounds', 'oob tap')
  assert(!e.ok && e.code === 'bad-request', 'bad button')
  return 'unknown-command / bad-request / out-of-bounds / bad button all refused'
})

// put the device in a known state: Settings, top level
simctl('launch', UDID, 'com.apple.Preferences'); await sleep(2000)

await test('describe (flat)', async () => {
  const t0 = Date.now()
  const r = await describeFlat(c)
  fs.writeFileSync(path.join(OUT, 'describe.json'), JSON.stringify(r, null, 1))
  const general = find(r.elements, (e) => labelOf(e) === 'General')
  assert(r.count > 5, `only ${r.count} elements`)
  assert(general && general.center, 'no "General" element with a center')
  return `${r.count} elements, helper ${r.ms.toFixed(0)}ms (${Date.now() - t0}ms round trip), General@${general.center.x.toFixed(0)},${general.center.y.toFixed(0)}`
})
await test('describe (tree) + offscreen flags', async () => {
  const r = await c.send('describe', { flat: false })
  assert(r.ok && r.tree && Array.isArray(r.tree.children), 'no tree')
  const flat = await describeFlat(c)
  const off = flat.elements.filter((e) => e.offscreen).length
  const clipped = flat.elements.filter((e) => e.clipped).length
  return `tree root children=${r.tree.children.length}; flat: ${off} offscreen, ${clipped} clipped`
})
await test('describe-point', async () => {
  const r = await describeFlat(c)
  const g = find(r.elements, (e) => labelOf(e) === 'General')
  const p = await c.send('describe-point', { x: g.center.x, y: g.center.y })
  assert(p.ok && p.element, JSON.stringify(p).slice(0, 200))
  assert(labelOf(p.element).includes('General'), `hit "${labelOf(p.element)}"`)
  return `element at (${g.center.x.toFixed(0)},${g.center.y.toFixed(0)}) = "${labelOf(p.element)}" ${p.ms.toFixed(0)}ms`
})

await test('screenshot png + jpeg', async () => {
  const a = await c.send('screenshot', { format: 'png' })
  assert(a.ok, JSON.stringify(a))
  const img = c.images.get(a.imageId)
  assert(img && isPng(img.data), 'not a PNG')
  assert(img.w === info.pixelWidth && img.h === info.pixelHeight, `size ${img.w}x${img.h}`)
  fs.writeFileSync(path.join(OUT, 'shot.png'), img.data)
  const b = await c.send('screenshot', { format: 'jpeg', scale: 0.5, quality: 0.8 })
  assert(b.ok, JSON.stringify(b))
  const j = c.images.get(b.imageId)
  assert(j && isJpeg(j.data) && Math.abs(j.w - info.pixelWidth / 2) <= 1, `jpeg ${j && j.w}`)
  fs.writeFileSync(path.join(OUT, 'shot.jpg'), j.data)
  return `png ${img.w}x${img.h} ${(img.data.length / 1024).toFixed(0)}KB; jpeg ${j.w}x${j.h} ${(j.data.length / 1024).toFixed(0)}KB`
})

await test('tap → navigates (General → About)', async () => {
  const r = await describeFlat(c)
  const g = find(r.elements, (e) => labelOf(e) === 'General')
  const t = await c.send('tap', { x: g.center.x, y: g.center.y }); assert(t.ok, JSON.stringify(t))
  await sleep(900)
  const r2 = await describeFlat(c)
  assert(find(r2.elements, (e) => labelOf(e) === 'About'), 'About row not visible after tapping General')
  return `tap ${t.ms.toFixed(1)}ms; About visible`
})
await test('edge swipe back (left edge)', async () => {
  const s = await c.send('swipe', { x1: 3, y1: 450, x2: 330, y2: 450, ms: 250, steps: 18, edge: 'left' })
  assert(s.ok, JSON.stringify(s))
  await sleep(900)
  const r = await describeFlat(c)
  assert(!find(r.elements, (e) => labelOf(e) === 'About' && !e.offscreen), 'still on General')
  assert(find(r.elements, (e) => labelOf(e) === 'General'), 'General row not back')
  return 'back on Settings root'
})
await test('swipe scrolls a list', async () => {
  const before = find((await describeFlat(c)).elements, (e) => labelOf(e) === 'General')
  const s = await c.send('swipe', { x1: 200, y1: 650, x2: 200, y2: 450, ms: 300, steps: 15 }); assert(s.ok)
  await sleep(1200)
  const after = find((await describeFlat(c)).elements, (e) => labelOf(e) === 'General')
  assert(!after || after.frame.y < before.frame.y - 60, `General did not move: ${before.frame.y} → ${after?.frame.y}`)
  for (let i = 0; i < 2; i++) { await c.send('swipe', { x1: 200, y1: 250, x2: 200, y2: 780, ms: 300, steps: 15 }); await sleep(900) }
  return `General y ${before.frame.y.toFixed(0)} → ${after ? after.frame.y.toFixed(0) : 'scrolled off-screen'}`
})
await test('touch down/move/up (manual drag scrolls)', async () => {
  const before = find((await describeFlat(c)).elements, (e) => labelOf(e) === 'General')
  let r = await c.send('touch', { phase: 'down', x: 200, y: 650 }); assert(r.ok, JSON.stringify(r))
  for (let i = 1; i <= 12; i++) { c.notify('touch', { phase: 'move', x: 200, y: 650 - i * 15 }); await sleep(12) }
  r = await c.send('touch', { phase: 'up', x: 200, y: 470 }); assert(r.ok, JSON.stringify(r))
  await sleep(1200)
  const after = find((await describeFlat(c)).elements, (e) => labelOf(e) === 'General')
  assert(!after || after.frame.y < before.frame.y - 60, `no scroll: ${before.frame.y} → ${after?.frame.y}`)
  for (let i = 0; i < 2; i++) { await c.send('swipe', { x1: 200, y1: 250, x2: 200, y2: 780, ms: 300, steps: 15 }); await sleep(900) }
  return 'scrolled via raw touch events'
})
await test('pinch (accepted)', async () => {
  const r = await c.send('pinch', { cx: 196, cy: 400, r1: 30, r2: 100, ms: 300 })
  assert(r.ok, JSON.stringify(r)); return `pinch ${r.ms.toFixed(0)}ms (visual effect needs Maps; not asserted)`
})

await test('stream 3s (static 1s, then scrolling 2s)', async () => {
  c.frames.length = 0
  const r = await c.send('stream', { on: true, maxFps: 60, scale: 0.33, quality: 0.6 }); assert(r.ok)
  await sleep(1000)
  const staticFrames = c.frames.length
  const t0 = Date.now()
  for (let i = 0; i < 4; i++) {
    await c.send('swipe', { x1: 200, y1: 700, x2: 200, y2: 300, ms: 350, steps: 20 })
    await c.send('swipe', { x1: 200, y1: 300, x2: 200, y2: 700, ms: 350, steps: 20 })
  }
  const animMs = Date.now() - t0
  await sleep(200)
  const fr = c.frames.slice(staticFrames)
  assert(fr.length > 20, `only ${fr.length} frames while animating`)
  assert(fr.every((f) => isJpeg(f.jpeg)), 'bad JPEG in stream')
  const lat = fr.map((f) => f.at - f.captureMs).filter((x) => x >= -5).sort((a, b) => a - b)
  const bytes = fr.reduce((s, f) => s + f.jpeg.length, 0)
  fs.writeFileSync(path.join(OUT, 'stream-last.jpg'), fr[fr.length - 1].jpeg)
  return `static: ${staticFrames} frame(s)/1s; animating: ${(fr.length / (animMs / 1000)).toFixed(1)} fps, ${fr[0].w}x${fr[0].h}, ${(bytes / fr.length / 1024).toFixed(0)}KB/frame, ${(bytes / 1024 / (animMs / 1000) / 1024).toFixed(1)}MB/s, latency p50 ${lat[Math.floor(lat.length / 2)].toFixed(0)}ms p95 ${lat[Math.floor(lat.length * 0.95)].toFixed(0)}ms`
})
await test('stream off stops frames; static screen sends nothing', async () => {
  await c.send('stream', { on: false }); await sleep(300)
  c.frames.length = 0; await sleep(1000)
  assert(c.frames.length === 0, `${c.frames.length} frames after stream off`)
  await sleep(1500)  // let scroll deceleration settle
  c.frames.length = 0
  await c.send('stream', { on: true, maxFps: 30, scale: 0.33, quality: 0.6 }); await sleep(2500)
  const n = c.frames.length
  await c.send('stream', { on: false })
  assert(n >= 1 && n <= 3, `static screen sent ${n} frames in 2.5s`)
  return `off: 0 frames; static 2.5s: ${n} frame(s)`
})

await test('button home', async () => {
  const r = await c.send('button', { name: 'home' }); assert(r.ok, JSON.stringify(r))
  await sleep(1200)
  const d = await describeFlat(c)
  assert(!find(d.elements, (e) => labelOf(e) === 'General' && !e.offscreen), 'Settings still frontmost after home')
  return `home ${r.ms.toFixed(1)}ms; Settings no longer frontmost`
})
await test('buttons accepted (volup/voldown/lock/siri refused-safe)', async () => {
  for (const name of ['volup', 'voldown']) { const r = await c.send('button', { name }); assert(r.ok, name + JSON.stringify(r)) }
  const s = await c.send('button', { name: 'siri-legacy' }); assert(!s.ok, 'legacy siri source must be refused')
  await sleep(500)
  return 'volup/voldown ok; siri-legacy refused (siri itself is NOT exercised: it pops a banner)'
})

// ---- keyboard: Settings search field ----
try { simctl('terminate', UDID, 'com.apple.Preferences') } catch {}
simctl('launch', UDID, 'com.apple.Preferences'); await sleep(1500)
async function focusSearch() {
  const els = (await describeFlat(c)).elements
  const f = find(els, (e) => /TextField|SearchField/.test(e.role ?? ''))
  const p = f?.center ?? { x: 200, y: 800 }
  const t = await c.send('tap', { x: p.x, y: p.y }); assert(t.ok); await sleep(700)
  return f
}
const fieldValue = async () => {
  const els = (await describeFlat(c)).elements
  const f = find(els, (e) => /TextField|SearchField/.test(e.role ?? ''))
  return f ? String(f.value ?? '') : null
}
await test('key + text (ASCII)', async () => {
  await focusSearch()
  const r = await c.send('text', { text: 'Hello World 123!' }); assert(r.ok, JSON.stringify(r))
  await sleep(600)
  const v = await fieldValue()
  fs.writeFileSync(path.join(OUT, 'after-text.png'), c.images.get((await c.send('screenshot', { format: 'png', scale: 0.5 })).imageId).data)
  assert(v === 'Hello World 123!', `field value = ${JSON.stringify(v)}`)
  assert(r.typed === 16 && r.pasted === 0, `typed=${r.typed} pasted=${r.pasted}`)
  return `field = "${v}" (typed ${r.typed}, ${r.ms.toFixed(0)}ms)`
})
await test('key (backspace) + mods', async () => {
  for (let i = 0; i < 3; i++) { const r = await c.send('key', { usage: 42 }); assert(r.ok) }
  await sleep(400)
  const v = await fieldValue()
  assert(v === 'Hello World 1', `after 3×backspace: ${JSON.stringify(v)}`)
  const a = await c.send('key', { usage: 4, mods: ['shift'] }); assert(a.ok)  // Shift+a
  await sleep(300)
  const v2 = await fieldValue()
  assert(v2 === 'Hello World 1A', `after Shift+a: ${JSON.stringify(v2)}`)
  return `backspace ok; shift+a → "${v2}"`
})
await test('text (non-ASCII via pasteboard + Cmd+V, mixed run)', async () => {
  for (let i = 0; i < 20; i++) c.notify('key', { usage: 42 }); await sleep(300)
  const r = await c.send('text', { text: 'Café 日本 🚀 ok' }); assert(r.ok, JSON.stringify(r))
  await sleep(700)
  const v = await fieldValue()
  assert(v === 'Café 日本 🚀 ok', `field value = ${JSON.stringify(v)}`)
  return `field = "${v}" (typed ${r.typed}, pasted ${r.pasted})`
})
await test('key down/up explicit', async () => {
  const a = await c.send('key', { usage: 227, down: true }); const b = await c.send('key', { usage: 227, down: false })
  assert(a.ok && b.ok); return 'cmd down/up acked'
})
// leave Settings cleanly
for (let i = 0; i < 30; i++) c.notify('key', { usage: 42 })
await sleep(300)
await c.send('button', { name: 'home' }); await sleep(600)
try { simctl('terminate', UDID, 'com.apple.Preferences') } catch {}

await test('second attach is refused', async () => {
  const c2 = new Client(BIN, UDID)
  const ex = await Promise.race([c2.exit, sleep(5000).then(() => null)])
  assert(ex, 'second attach did not exit')
  assert(ex.code === 3, `exit code ${ex.code}`)
  const ev = c2.events.find((e) => e.event === 'error' && e.code === 'already-attached')
  assert(ev, 'no already-attached event')
  return `exit ${ex.code}: ${ev.message.slice(0, 90)}`
})
await test('first helper still healthy after refusal', async () => {
  const r = await c.send('ping'); assert(r.ok); return 'ping ok'
})

if (RECOVERY) {
  await test('recovery: backboardd restart', async () => {
    simctl('spawn', UDID, 'launchctl', 'kickstart', '-k', 'system/com.apple.backboardd')
    await sleep(4000)
    await c.send('button', { name: 'home' })               // may trigger HID rebuild
    const r2 = await c.send('tap', { x: 100, y: 100 })
    const s = await c.send('screenshot', { format: 'jpeg', scale: 0.3 })
    assert(s.ok, 'screenshot after backboardd restart: ' + JSON.stringify(s))
    return `tap after restart: ${JSON.stringify({ ok: r2.ok, code: r2.code })}; screenshot ok; events: ${c.events.map((e) => e.event).join(',')}`
  })
  await test('recovery: shutdown → events → boot → ready again', async () => {
    c.events.length = 0
    simctl('shutdown', UDID)
    await c.waitEvent('device-state', 20000, (e) => e.booted === false)
    const dead = await c.send('tap', { x: 100, y: 100 })
    assert(!dead.ok && dead.code === 'not-ready', 'tap while shut down: ' + JSON.stringify(dead))
    simctl('boot', UDID)
    await c.waitEvent('ready', 60000)
    await sleep(3000)
    const r = await c.send('screenshot', { format: 'jpeg', scale: 0.3 }); assert(r.ok, JSON.stringify(r))
    const t = await c.send('tap', { x: 100, y: 100 }); assert(t.ok, JSON.stringify(t))
    return 'device-state(shutdown) → not-ready errors → ready again → screenshot + tap work'
  })
}

await test('stdin EOF exits cleanly', async () => {
  c.p.stdin.end()
  const ex = await Promise.race([c.exit, sleep(4000).then(() => null)])
  assert(ex, 'did not exit on EOF'); assert(ex.code === 0, `exit code ${ex.code}`)
  return 'exit 0'
})

console.log('\n' + '─'.repeat(100))
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(58)} ${String(r.ms).padStart(6)}ms  ${r.detail}`)
const failed = results.filter((r) => !r.ok).length
console.log('─'.repeat(100) + `\n${results.length - failed}/${results.length} passed. artifacts in ${OUT}`)
if (failed) console.log('\nhelper stderr (tail):\n' + c.stderr.split('\n').slice(-15).join('\n'))
process.exit(failed ? 1 : 0)
