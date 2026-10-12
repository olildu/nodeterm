#!/usr/bin/env node
// Smoke test for android-helper: attaches to a RUNNING emulator and exercises every command.
//   node native/android-helper/test/smoke.mjs [--avd <name>] [--bin <path>] [--out <dir>] [--boot <avd>]
// --avd defaults to the first running emulator. The helper must NOT stop it on exit (we did not
// start it). --boot <avd> additionally boots a SHUT-DOWN AVD through the helper, waits for `ready`,
// quits, and checks the emulator it started is gone (ownership).
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const BIN = arg('--bin', path.resolve(here, '../../../resources/bin/android-helper.cjs'))
const OUT = arg('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'android-helper-smoke-')))
const BOOT = arg('--boot', null)
fs.mkdirSync(OUT, { recursive: true })
const SDK = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? path.join(os.homedir(), 'Library/Android/sdk')
const ADB = path.join(SDK, 'platform-tools', 'adb')
const sh = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const helperJson = (a) => JSON.parse(sh(process.execPath, [BIN, ...a]))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Client {
  constructor(id) {
    this.p = spawn(process.execPath, [BIN, 'attach', id], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.buf = Buffer.alloc(0); this.nextId = 1; this.pending = new Map(); this.events = []; this.frames = []
    this.images = new Map(); this.stderr = ''; this.waiters = []
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
      const type = this.buf[4]; const p = Buffer.from(this.buf.subarray(5, 4 + len)); this.buf = this.buf.subarray(4 + len)
      if (type === 1) this.frames.push({ at: Date.now(), captureMs: Number(p.readBigUInt64BE(0)) / 1000, w: p.readUInt16BE(8), h: p.readUInt16BE(10), jpeg: p.subarray(12) })
      else if (type === 3) this.images.set(p.readUInt32BE(0), { fmt: p[4], w: p.readUInt16BE(5), h: p.readUInt16BE(7), data: p.subarray(9) })
      else if (type === 2) {
        const m = JSON.parse(p.toString('utf8'))
        if (m.event) { this.events.push(m); this.waiters = this.waiters.filter((w) => !w(m)) }
        else if (this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id) }
      } else throw new Error('unknown message type ' + type)
    }
  }
  send(cmd, fields = {}, timeoutMs = 30000) {
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

const results = []
async function test(name, fn) {
  const t0 = Date.now()
  try { results.push({ name, ok: true, detail: (await fn()) ?? '', ms: Date.now() - t0 }) }
  catch (e) { results.push({ name, ok: false, detail: String(e.message ?? e), ms: Date.now() - t0 }) }
}
const assert = (c, m) => { if (!c) throw new Error(m) }
const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8
const isPng = (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
const describeFlat = async (c) => { const r = await c.send('describe', { flat: true }); assert(r.ok, `describe: ${r.error}`); return r }
const findLabel = (els, re) => els.find((e) => re.test(e.label ?? '') && e.center && !e.offscreen)

const list = helperJson(['list'])
const running = list.filter((d) => d.state === 'Booted')
const ID = arg('--avd', null) ? `android:${arg('--avd')}` : running[0]?.udid
console.log(`android-helper smoke — bin=${BIN}\n  device=${ID}\n  out=${OUT}\n`)
assert(ID, 'no running emulator — start one, e.g. emulator -avd Nexus_7 -no-window -grpc 8554')
const serial = (() => { const out = sh(ADB, ['devices']); for (const l of out.split('\n')) { const s = l.split('\t')[0]; if (/^emulator-\d+$/.test(s) && sh(ADB, ['-s', s, 'emu', 'avd', 'name']).split('\n')[0].trim() === ID.slice(8)) return s } return null })()
const adbShell = (...a) => sh(ADB, ['-s', serial, 'shell', ...a])

await test('--version / list', async () => {
  const v = sh(process.execPath, [BIN, '--version']).trim()
  const mine = list.find((d) => d.udid === ID)
  assert(mine && mine.state === 'Booted', 'device not listed as Booted')
  return `${v}; ${list.length} AVD(s); ${mine.name} / ${mine.runtime}; adb ${serial}`
})
await test('bad ids refused', async () => {
  const c = new Client('android:../etc'); const ex = await c.exit
  assert(ex.code === 4 && c.events.some((e) => e.code === 'device-not-found'), `exit ${ex.code}`)
  const c2 = new Client('android:No_Such_Avd_X'); const ex2 = await c2.exit
  assert(ex2.code === 4, `exit ${ex2.code}`)
  return 'malformed id and unknown AVD → device-not-found, exit 4'
})

const c = new Client(ID)
let info
await test('ready event', async () => {
  const e = await c.waitEvent('ready', 60000)
  info = e.device
  assert(info.pointWidth > 0 && Math.abs(info.pixelWidth - info.pointWidth * info.scale) < 1, 'point/pixel mismatch')
  assert(info.owned === false, 'a pre-existing emulator must not read as owned')
  return `${info.name} ${info.pixelWidth}x${info.pixelHeight}px @${info.scale}x = ${info.pointWidth}x${info.pointHeight}pt, ${info.runtime}, hardware keyboard ${info.hardwareKeyboard}`
})
await test('info + ping', async () => {
  const r = await c.send('info'); assert(r.ok && r.device.ready === true && r.device.state === 'Booted', JSON.stringify(r))
  const t = []
  for (let i = 0; i < 20; i++) { const s = process.hrtime.bigint(); await c.send('ping'); t.push(Number(process.hrtime.bigint() - s) / 1e6) }
  t.sort((a, b) => a - b)
  return `rtt p50 ${t[10].toFixed(2)}ms`
})
await test('bad requests', async () => {
  const a = await c.send('nope'); const b = await c.send('tap', { x: 'a' }); const d = await c.send('tap', { x: -50, y: 10 })
  const e = await c.send('button', { name: 'siri' })
  assert(!a.ok && a.code === 'unknown-command', 'unknown'); assert(!b.ok && b.code === 'bad-request', 'bad tap')
  assert(!d.ok && d.code === 'out-of-bounds', 'oob'); assert(!e.ok && e.code === 'bad-request', 'siri')
  return 'unknown-command / bad-request / out-of-bounds / siri refused'
})

adbShell('am', 'start', '-W', '-a', 'android.settings.SETTINGS'); await sleep(1500)
await test('describe (flat) on Settings', async () => {
  const r = await describeFlat(c)
  fs.writeFileSync(path.join(OUT, 'describe.json'), JSON.stringify(r, null, 1))
  const named = r.elements.filter((e) => e.label)
  const disp = findLabel(r.elements, /^Display$/)
  assert(disp, 'no "Display" row: ' + named.map((e) => e.label).slice(0, 20).join(', '))
  return `${r.count} elements (${named.length} named), ${r.ms}ms, Display@${disp.center.x},${disp.center.y}`
})
await test('describe (tree) + describe-point', async () => {
  const t = await c.send('describe', { flat: false }); assert(t.ok && t.tree && t.tree.children.length, 'no tree')
  const disp = findLabel((await describeFlat(c)).elements, /^Display$/)
  const p = await c.send('describe-point', { x: disp.center.x, y: disp.center.y })
  assert(p.ok && p.element && /Display/.test(p.element.label), JSON.stringify(p).slice(0, 200))
  return `point → "${p.element.label}" (${p.element.role})`
})
await test('screenshot png + jpeg', async () => {
  const t0 = Date.now()
  const a = await c.send('screenshot', { format: 'png' }); assert(a.ok, JSON.stringify(a))
  const pngMs = Date.now() - t0
  const img = c.images.get(a.imageId); assert(img && isPng(img.data), 'not a PNG')
  assert(img.w === info.pixelWidth && img.h === info.pixelHeight, `size ${img.w}x${img.h}`)
  fs.writeFileSync(path.join(OUT, 'shot.png'), img.data)
  const b = await c.send('screenshot', { format: 'jpeg', scale: 0.5 }); const j = c.images.get(b.imageId)
  assert(j && isJpeg(j.data) && Math.abs(j.w - info.pixelWidth / 2) <= 1, `jpeg ${j && j.w}`)
  return `png ${img.w}x${img.h} ${(img.data.length / 1024).toFixed(0)}KB in ${pngMs}ms; jpeg ${j.w}x${j.h}`
})
await test('tap → navigates (Display) and back button', async () => {
  const disp = findLabel((await describeFlat(c)).elements, /^Display$/)
  const t = await c.send('tap', { x: disp.center.x, y: disp.center.y }); assert(t.ok, JSON.stringify(t))
  await sleep(1200)
  const r = await describeFlat(c)
  assert(findLabel(r.elements, /Brightness|Dark theme/i), 'no Display screen after tap')
  const b = await c.send('button', { name: 'back' }); assert(b.ok, JSON.stringify(b)); await sleep(1000)
  assert(findLabel((await describeFlat(c)).elements, /^Display$/), 'back did not return')
  return `tap ${t.ms}ms → Display screen → back`
})
await test('swipe scrolls; raw touch drag scrolls', async () => {
  const W = info.pointWidth, H = info.pointHeight, x = W / 2
  const y0 = findLabel((await describeFlat(c)).elements, /^Display$/).frame.y
  const s = await c.send('swipe', { x1: x, y1: H * 0.8, x2: x, y2: H * 0.4, ms: 300, steps: 15 }); assert(s.ok, JSON.stringify(s))
  await sleep(1200)
  const d1 = findLabel((await describeFlat(c)).elements, /^Display$/)
  assert(!d1 || d1.frame.y < y0 - 60, `swipe: ${y0} → ${d1?.frame.y}`)
  await c.send('swipe', { x1: x, y1: H * 0.3, x2: x, y2: H * 0.9, ms: 300 }); await sleep(1200)
  let r = await c.send('touch', { phase: 'down', x, y: H * 0.8 }); assert(r.ok, JSON.stringify(r))
  for (let i = 1; i <= 12; i++) { c.notify('touch', { phase: 'move', x, y: H * (0.8 - i * 0.03) }); await sleep(12) }
  r = await c.send('touch', { phase: 'up', x, y: H * 0.44 }); assert(r.ok, JSON.stringify(r)); await sleep(1200)
  const d2 = findLabel((await describeFlat(c)).elements, /^Display$/)
  assert(!d2 || d2.frame.y < y0 - 60, `touch: ${y0} → ${d2?.frame.y}`)
  await c.send('swipe', { x1: x, y1: H * 0.3, x2: x, y2: H * 0.9, ms: 300 }); await sleep(1000)
  return `Display y ${y0} → swipe ${d1 ? d1.frame.y : 'off'}, drag ${d2 ? d2.frame.y : 'off'}`
})
await test('stream (static, then scrolling)', async () => {
  c.frames.length = 0
  const r = await c.send('stream', { on: true, maxFps: 60, scale: 0.5, quality: 0.6 }); assert(r.ok)
  await sleep(1000)
  const staticFrames = c.frames.length
  const t0 = Date.now()
  for (let i = 0; i < 3; i++) {
    const W = info.pointWidth, H = info.pointHeight
    await c.send('swipe', { x1: W / 2, y1: H * 0.8, x2: W / 2, y2: H * 0.3, ms: 350, steps: 20 })
    await c.send('swipe', { x1: W / 2, y1: H * 0.3, x2: W / 2, y2: H * 0.8, ms: 350, steps: 20 })
  }
  const animMs = Date.now() - t0; await sleep(300)
  const fr = c.frames.slice(staticFrames)
  assert(staticFrames >= 1 && staticFrames <= 3, `static: ${staticFrames}`)
  assert(fr.length > 15, `only ${fr.length} frames while animating`)
  assert(fr.every((f) => isJpeg(f.jpeg)), 'bad JPEG')
  const lat = fr.map((f) => f.at - f.captureMs).sort((a, b) => a - b)
  fs.writeFileSync(path.join(OUT, 'stream-last.jpg'), fr[fr.length - 1].jpeg)
  return `static ${staticFrames}/1s; animating ${(fr.length / (animMs / 1000)).toFixed(1)} fps ${fr[0].w}x${fr[0].h}, ${(fr.reduce((s, f) => s + f.jpeg.length, 0) / fr.length / 1024).toFixed(0)}KB/frame, latency p50 ${lat[Math.floor(lat.length / 2)].toFixed(0)}ms`
})
await test('stream off stops frames; on again sends a first frame', async () => {
  await c.send('stream', { on: false }); await sleep(300); c.frames.length = 0; await sleep(1000)
  assert(c.frames.length === 0, `${c.frames.length} after off`)
  await c.send('stream', { on: true, maxFps: 30, scale: 0.33 }); await sleep(1500)
  const n = c.frames.length; await c.send('stream', { on: false })
  assert(n >= 1 && n <= 3, `${n} frames on a static screen`)
  return `off 0; on → ${n} frame(s)`
})
await test('text + key into Settings search', async () => {
  adbShell('am', 'start', '-W', '-n', 'com.android.settings.intelligence/.search.SearchActivity'); await sleep(1500)
  for (let i = 0; i < 40; i++) c.notify('key', { usage: 0x2a }); await sleep(800)
  const r = await c.send('text', { text: 'wifi 123' }); assert(r.ok && r.typed === 8, JSON.stringify(r)); await sleep(800)
  const field = () => describeFlat(c).then((d) => d.elements.find((e) => e.role === 'TextField'))
  let f = await field(); const v1 = f?.label || f?.value
  assert(v1 === 'wifi 123', `field = ${JSON.stringify(v1)}`)
  for (let i = 0; i < 4; i++) { const k = await c.send('key', { usage: 0x2a }); assert(k.ok, JSON.stringify(k)) }
  await sleep(500); f = await field()
  assert((f?.label || f?.value) === 'wifi', `after backspace: ${f?.label}`)
  const s = await c.send('key', { usage: 0x04, mods: ['shift'] }); assert(s.ok); await sleep(400); f = await field()
  assert((f?.label || f?.value) === 'wifiA', `after shift+a: ${f?.label}`)
  return 'typed / backspace / shift+a ok'
})
await test('text (non-ASCII via clipboard + Ctrl+V)', async () => {
  for (let i = 0; i < 10; i++) c.notify('key', { usage: 0x2a }); await sleep(800)
  const r = await c.send('text', { text: 'Café 日本' }); assert(r.ok, JSON.stringify(r)); await sleep(900)
  const f = (await describeFlat(c)).elements.find((e) => e.role === 'TextField')
  const v = f?.label || f?.value
  assert(v === 'Café 日本', `field = ${JSON.stringify(v)}`)
  return `pasted ${r.pasted}; field = ${JSON.stringify(v)}`
})
await test('home button', async () => {
  const r = await c.send('button', { name: 'home' }); assert(r.ok, JSON.stringify(r)); await sleep(1200)
  assert(!(await describeFlat(c)).elements.some((e) => e.role === 'TextField' && !e.offscreen), 'still in settings search')
  return 'home ok'
})
await test('second attach is refused', async () => {
  const c2 = new Client(ID); const ex = await Promise.race([c2.exit, sleep(8000).then(() => null)])
  assert(ex && ex.code === 3, `exit ${ex && ex.code}`)
  assert(c2.events.some((e) => e.code === 'already-attached'), 'no event')
  const p = await c.send('ping'); assert(p.ok)
  return 'exit 3, first still healthy'
})
await test('stdin EOF exits cleanly and leaves the user\'s emulator running', async () => {
  c.p.stdin.end()
  const ex = await Promise.race([c.exit, sleep(5000).then(() => null)])
  assert(ex && ex.code === 0, `exit ${ex && ex.code}`)
  await sleep(1000)
  assert(helperJson(['list']).find((d) => d.udid === ID).state === 'Booted', 'emulator was stopped!')
  return 'exit 0; emulator still Booted'
})

if (BOOT) {
  await test(`boot ${BOOT} headless, then quit stops it`, async () => {
    const id = `android:${BOOT}`
    assert(helperJson(['list']).find((d) => d.udid === id)?.state === 'Shutdown', `${BOOT} must be shut down first`)
    const b = new Client(id)
    await b.waitEvent('device-state', 15000, (e) => e.state === 'Shutdown')
    const t0 = Date.now()
    const r = await b.send('boot'); assert(r.ok && r.booting, JSON.stringify(r))
    const ready = await b.waitEvent('ready', 180000)
    const bootMs = Date.now() - t0
    assert(ready.device.owned === true, 'booted emulator not owned')
    const s = await b.send('screenshot', { format: 'png', scale: 0.5 }); assert(s.ok)
    fs.writeFileSync(path.join(OUT, `boot-${BOOT}.png`), b.images.get(s.imageId).data)
    await b.send('quit'); const ex = await b.exit
    let gone = false
    for (let i = 0; i < 20 && !gone; i++) { await sleep(500); gone = helperJson(['list']).find((d) => d.udid === id)?.state === 'Shutdown' }
    assert(gone, 'emulator still running after quit')
    return `ready after ${(bootMs / 1000).toFixed(1)}s (${ready.device.pixelWidth}x${ready.device.pixelHeight}); quit exit ${ex.code}; emulator stopped`
  })
}

console.log('\n' + '─'.repeat(100))
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(56)} ${String(r.ms).padStart(6)}ms  ${r.detail}`)
const failed = results.filter((r) => !r.ok).length
console.log('─'.repeat(100) + `\n${results.length - failed}/${results.length} passed. artifacts in ${OUT}`)
if (failed) console.log('\nhelper stderr (tail):\n' + c.stderr.split('\n').slice(-15).join('\n'))
process.exit(failed ? 1 : 0)
