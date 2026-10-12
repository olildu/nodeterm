/**
 * android-helper — the Android emulator's counterpart of `sim-helper`, speaking the SAME stdio
 * protocol (native/sim-helper/PROTOCOL.md, plus the "Android" section there), so nodeterm's sim
 * service, the `sim` verb and the Simulator node treat an AVD exactly like an iOS device.
 *
 *   android-helper --version
 *   android-helper list                     → JSON array {udid, name, runtime, state, deviceType}
 *   android-helper attach android:<avd>     → the protocol on stdin/stdout
 *
 * Runs under Electron's Node (`ELECTRON_RUN_AS_NODE=1`) or plain Node. Screen and input go through
 * the emulator's gRPC endpoint (`streamScreenshot`, `sendTouch`, `sendKey`); the accessibility tree
 * through `adb … uiautomator dump`. JPEG encoding uses nodeterm's own `sharp`.
 *
 * Emulator ownership: attaching never boots anything. `boot` starts the AVD headless on free ports
 * and records the emulator as OURS; on quit the helper shuts down only an emulator it started (the
 * record survives a helper crash, so the next helper still knows). An emulator the user started —
 * Android Studio, a terminal — is driven but never stopped.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import {
  EmulatorGrpc,
  IMG_RGB888,
  KEY_DOWN,
  KEY_PRESS,
  KEY_UP,
  clipData,
  decodeImage,
  decodeStatus,
  imageFormat,
  keyboardEvent,
  touchEvent,
  type EmuImage,
  type EmuTouch,
  type StreamHandle
} from './grpc'
import { BUTTON_KEYS, MODIFIER_KEYS, hidToKey, isTypable } from './keys'
import {
  avdHome,
  avdOf,
  findSdk,
  parseAvdList,
  parseWmDensity,
  parseWmSize,
  pickPorts,
  pidAlive,
  readAvd,
  runningEmulators,
  type AvdInfo,
  type RunningEmulator,
  type Sdk
} from './sdk'
import { hitTest, parseDump, stripChildren } from './uiautomator'

const VERSION = 'android-helper 0.1'

// ─── output framing ──────────────────────────────────────────────────────────────────────────

const MSG_FRAME = 1
const MSG_JSON = 2
const MSG_IMAGE = 3

function writeMsg(type: number, payload: Buffer): boolean {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(payload.length + 1, 0)
  head[4] = type
  return process.stdout.write(Buffer.concat([head, payload]))
}

function sendJson(obj: Record<string, unknown>): void {
  writeMsg(MSG_JSON, Buffer.from(JSON.stringify(obj), 'utf8'))
}

const event = (name: string, body: Record<string, unknown> = {}): void => sendJson({ event: name, ...body })
const log = (...a: unknown[]): void => {
  process.stderr.write(`[android-helper] ${a.map(String).join(' ')}\n`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

class CmdError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

// ─── sharp (nodeterm's own copy) ─────────────────────────────────────────────────────────────

type SharpFn = (input: Buffer, opts?: Record<string, unknown>) => {
  jpeg(o: Record<string, unknown>): { toBuffer(): Promise<Buffer> }
  png(o?: Record<string, unknown>): { toBuffer(): Promise<Buffer> }
}

let sharpFn: SharpFn | null = null
function sharp(): SharpFn {
  if (sharpFn) return sharpFn
  // Packaged: the main process tells us where the app's node_modules are (inside app.asar, with
  // sharp unpacked). Dev: plain resolution from resources/bin finds the repo's node_modules.
  const from = process.env.NODETERM_REQUIRE_FROM
  const req = createRequire(from && fs.existsSync(path.dirname(from)) ? from : __filename)
  sharpFn = req('sharp') as SharpFn
  return sharpFn
}

// ─── process helpers ─────────────────────────────────────────────────────────────────────────

function run(bin: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim().split('\n').pop() ?? err.message))
      else resolve(stdout)
    })
  })
}

// ─── modes ───────────────────────────────────────────────────────────────────────────────────

async function listMode(): Promise<number> {
  const sdk = findSdk()
  if (!sdk) {
    process.stdout.write('[]\n')
    return 0
  }
  let names: string[] = []
  try {
    names = parseAvdList(await run(sdk.emulator, ['-list-avds'], 10_000))
  } catch (e) {
    log('emulator -list-avds failed:', (e as Error).message)
  }
  const running = runningEmulators()
  const out = names.map((avd) => {
    const info = readAvd(avd)
    const live = running.find((r) => r.avd === avd)
    const booted = !!live
    return {
      udid: `android:${avd}`,
      name: info.name,
      runtime: info.runtime,
      state: booted ? 'Booted' : 'Shutdown',
      ...(info.deviceType ? { deviceType: info.deviceType } : {}),
      // The adb serial: what Maestro (`--device`) and adb (`-s`) call this emulator.
      ...(live ? { serial: `emulator-${live.consolePort}` } : {})
    }
  })
  process.stdout.write(JSON.stringify(out) + '\n')
  return 0
}

// ─── attach ──────────────────────────────────────────────────────────────────────────────────

interface Facts {
  pixelWidth: number
  pixelHeight: number
  density: number
  release?: string
}

interface StreamWant {
  on: boolean
  maxFps: number
  scale: number
  quality: number
}

const clamp = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d

class Controller {
  private emu: RunningEmulator | null = null
  private grpc: EmulatorGrpc | null = null
  private serial = ''
  private facts: Facts | null = null
  private ready = false
  private state = ''
  private setupGen = 0
  private bootChild: ChildProcess | null = null
  private bootLog = ''
  private monitorTimer: ReturnType<typeof setTimeout> | null = null
  private reportedSetupError = ''
  private stopping = false

  private want: StreamWant = { on: false, maxFps: 30, scale: 0.5, quality: 0.7 }
  private stream: StreamHandle | null = null
  private streamKey = ''
  private latest: EmuImage | null = null
  private encoding = false
  private lastSentAt = 0
  private lastJpeg: Buffer | null = null
  private pumpTimer: ReturnType<typeof setTimeout> | null = null

  private inputQueue: Promise<unknown> = Promise.resolve()
  private describeQueue: Promise<unknown> = Promise.resolve()
  private shotQueue: Promise<unknown> = Promise.resolve()
  private nextImageId = 1
  /** Fingers currently down: id → last pixel position. */
  private fingers = new Map<number, { x: number; y: number }>()

  constructor(
    private readonly sdk: Sdk,
    private readonly avd: string,
    private readonly info: AvdInfo,
    private readonly ownedFile: string
  ) {}

  // ── device facts ──

  private get scale(): number {
    return (this.facts?.density ?? this.info.density ?? 160) / 160
  }

  private deviceBody(): Record<string, unknown> {
    const pw = this.facts?.pixelWidth ?? this.info.pixelWidth ?? 0
    const ph = this.facts?.pixelHeight ?? this.info.pixelHeight ?? 0
    const s = this.scale
    return {
      udid: `android:${this.avd}`,
      name: this.info.name,
      runtime: this.facts?.release ? `Android ${this.facts.release}` : this.info.runtime,
      state: this.state || 'Shutdown',
      ...(this.info.deviceType ? { deviceType: this.info.deviceType } : {}),
      platform: 'android',
      pixelWidth: pw,
      pixelHeight: ph,
      pointWidth: Math.round((pw / s) * 100) / 100,
      pointHeight: Math.round((ph / s) * 100) / 100,
      scale: s,
      ready: this.ready,
      streaming: this.want.on,
      helperVersion: VERSION,
      pid: process.pid,
      ...(this.emu ? { serial: this.serial, owned: this.isOwned(this.emu.pid) } : {})
    }
  }

  private setState(state: string): void {
    if (state === this.state) return
    this.state = state
    event('device-state', { state, booted: state === 'Booted' })
  }

  // ── ownership ──

  private readOwned(): number | null {
    try {
      const j = JSON.parse(fs.readFileSync(this.ownedFile, 'utf8')) as { pid?: unknown }
      return typeof j.pid === 'number' ? j.pid : null
    } catch {
      return null
    }
  }

  private writeOwned(pid: number | null): void {
    try {
      if (pid === null) fs.rmSync(this.ownedFile, { force: true })
      else fs.writeFileSync(this.ownedFile, JSON.stringify({ pid, avd: this.avd, at: Date.now() }), { mode: 0o600 })
    } catch (e) {
      log('ownership record:', (e as Error).message)
    }
  }

  private isOwned(pid: number): boolean {
    return this.readOwned() === pid
  }

  // ── monitor: which emulator (if any) runs this AVD ──

  start(): void {
    void this.monitor()
  }

  private async monitor(): Promise<void> {
    if (this.stopping) return
    try {
      const running = runningEmulators().find((r) => r.avd === this.avd) ?? null
      if (!running) {
        if (this.emu) this.teardown('emulator stopped')
        const booting = this.bootChild && this.bootChild.exitCode === null && this.bootChild.signalCode === null
        this.setState(booting ? 'Booting' : 'Shutdown')
      } else if (!this.emu || this.emu.pid !== running.pid) {
        if (this.emu) this.teardown('emulator replaced')
        // An emulator that appears while our own boot is running is the one we started (the
        // `emulator` launcher may exec qemu under the same pid, or hand off to a child).
        if (this.bootChild && (this.bootChild.pid === running.pid || this.bootChild.exitCode === null || this.readOwned() === this.bootChild.pid)) {
          this.writeOwned(running.pid)
        }
        this.emu = running
        this.serial = `emulator-${running.consolePort}`
        this.setState('Booting')
        void this.setup(++this.setupGen, running)
      } else if (!pidAlive(running.pid)) {
        this.teardown('emulator exited')
      }
    } catch (e) {
      log('monitor:', (e as Error).message)
    }
    this.monitorTimer = setTimeout(() => void this.monitor(), this.ready ? 1500 : 700)
  }

  private teardown(why: string): void {
    log(`teardown: ${why}`)
    this.setupGen++
    this.stopStream()
    this.grpc?.close()
    this.grpc = null
    this.emu = null
    this.ready = false
    this.facts = null
    this.fingers.clear()
    this.reportedSetupError = ''
  }

  private setupError(message: string): void {
    if (message === this.reportedSetupError) return
    this.reportedSetupError = message
    event('error', { code: 'setup-failed', message })
  }

  private async setup(gen: number, emu: RunningEmulator): Promise<void> {
    const live = (): boolean => gen === this.setupGen && !this.stopping
    if (!emu.grpcPort) {
      this.setupError(
        `${this.info.name} is running without gRPC, which nodeterm needs for its screen. ` +
          'Close it and boot it from nodeterm (or start it with -grpc <port>).'
      )
      return
    }
    if (emu.grpcJwt && !emu.grpcToken) {
      this.setupError(
        `${this.info.name} was started with gRPC JWT auth (Android Studio does this), which nodeterm cannot use. ` +
          'Close it and boot it from nodeterm.'
      )
      return
    }
    const grpc = new EmulatorGrpc(emu.grpcPort, emu.grpcToken)
    this.grpc = grpc
    // 1. gRPC answers and the guest says it has booted.
    for (;;) {
      if (!live()) return
      try {
        const st = decodeStatus(await grpc.unary('getStatus', Buffer.alloc(0), 3000))
        if (st.booted) break
      } catch (e) {
        if (!live()) return
        const msg = (e as Error).message
        if (/unauthenticated|permission/i.test(msg)) {
          this.setupError(`The emulator refused nodeterm's gRPC connection (${msg}). Close it and boot it from nodeterm.`)
          return
        }
      }
      await sleep(600)
    }
    // 2. Android itself finished booting (getStatus says "booted" a little before the launcher is up).
    for (;;) {
      if (!live()) return
      try {
        const v = (await run(this.sdk.adb, ['-s', this.serial, 'shell', 'getprop', 'sys.boot_completed'], 5000)).trim()
        if (v === '1') break
      } catch {
        /* adb not connected yet */
      }
      await sleep(700)
    }
    // 3. Display facts.
    let facts: Facts | null = null
    try {
      const out = await run(this.sdk.adb, ['-s', this.serial, 'shell', 'wm size; echo ---; wm density; echo ---; getprop ro.build.version.release'], 8000)
      const [sizeOut, densOut, rel] = out.split('---')
      const size = parseWmSize(sizeOut ?? '')
      const density = parseWmDensity(densOut ?? '')
      if (size && density) facts = { pixelWidth: size.width, pixelHeight: size.height, density, release: (rel ?? '').trim() || undefined }
    } catch (e) {
      log('wm size:', (e as Error).message)
    }
    if (!facts && this.info.pixelWidth && this.info.pixelHeight) {
      facts = { pixelWidth: this.info.pixelWidth, pixelHeight: this.info.pixelHeight, density: this.info.density ?? 160 }
    }
    if (!live()) return
    if (!facts) {
      this.setupError('Could not read the emulator display size (adb shell wm size).')
      return
    }
    this.facts = facts
    this.ready = true
    this.reportedSetupError = ''
    this.setState('Booted')
    event('ready', { device: this.deviceBody() })
    this.applyStream(true)
  }

  // ── stream ──

  private stopStream(): void {
    this.stream?.cancel()
    this.stream = null
    this.streamKey = ''
    this.latest = null
    if (this.pumpTimer) clearTimeout(this.pumpTimer)
    this.pumpTimer = null
  }

  private applyStream(force = false): void {
    if (!this.want.on || !this.ready || !this.grpc || !this.facts) {
      this.stopStream()
      return
    }
    const w = Math.max(2, Math.round((this.facts.pixelWidth * this.want.scale) / 2) * 2)
    const h = Math.max(2, Math.round((this.facts.pixelHeight * this.want.scale) / 2) * 2)
    const k = `${w}x${h}`
    if (!force && this.stream && this.streamKey === k) return
    this.stopStream()
    this.streamKey = k
    this.lastJpeg = null // the first frame of a (re)opened stream always goes out
    const grpc = this.grpc
    const handle = grpc.serverStream('streamScreenshot', imageFormat(IMG_RGB888, w, h), (m) => {
      if (this.stream !== handle) return
      this.latest = decodeImage(m)
      this.pump()
    })
    this.stream = handle
    void handle.done.then(() => {
      if (this.stream !== handle || this.stopping) return
      // Ended under us (emulator hiccup, a dropped connection): reopen shortly if still wanted.
      this.stream = null
      this.streamKey = ''
      setTimeout(() => this.applyStream(), 500)
    })
  }

  private pump(): void {
    if (this.encoding || !this.latest || this.pumpTimer) return
    const wait = this.lastSentAt + 1000 / this.want.maxFps - Date.now()
    if (wait > 0) {
      this.pumpTimer = setTimeout(() => {
        this.pumpTimer = null
        this.pump()
      }, wait)
      return
    }
    const img = this.latest
    this.latest = null
    this.encoding = true
    void this.encode(img).finally(() => {
      this.encoding = false
      if (this.latest) this.pump()
    })
  }

  private async encode(img: EmuImage): Promise<void> {
    if (img.format !== IMG_RGB888 || img.data.length < img.width * img.height * 3) return
    try {
      const jpeg = await sharp()(img.data, { raw: { width: img.width, height: img.height, channels: 3 } })
        .jpeg({ quality: Math.round(this.want.quality * 100) })
        .toBuffer()
      if (!this.want.on || !this.stream) return
      if (this.lastJpeg && this.lastJpeg.equals(jpeg)) return
      // stdout backed up (a slow reader): drop rather than queue — the newest frame wins next time.
      if (process.stdout.writableNeedDrain) return
      this.lastJpeg = jpeg
      this.lastSentAt = Date.now()
      const head = Buffer.alloc(12)
      head.writeBigUInt64BE(BigInt(img.timestampUs || Date.now() * 1000), 0)
      head.writeUInt16BE(img.width, 8)
      head.writeUInt16BE(img.height, 10)
      writeMsg(MSG_FRAME, Buffer.concat([head, jpeg]))
    } catch (e) {
      event('error', { code: 'stream-failed', message: `JPEG encode failed: ${(e as Error).message}` })
    }
  }

  // ── input ──

  private needReady(): EmulatorGrpc {
    if (!this.ready || !this.grpc || !this.facts) throw new CmdError('not-ready', `${this.info.name} is not booted.`)
    return this.grpc
  }

  private toPx(x: number, y: number, mustBeOnScreen: boolean): { x: number; y: number } {
    const f = this.facts!
    const px = x * this.scale
    const py = y * this.scale
    if (mustBeOnScreen && (px < 0 || py < 0 || px >= f.pixelWidth || py >= f.pixelHeight)) {
      throw new CmdError('out-of-bounds', `(${x},${y}) is outside the ${Math.round(f.pixelWidth / this.scale)}×${Math.round(f.pixelHeight / this.scale)} screen`)
    }
    return {
      x: Math.round(Math.min(f.pixelWidth - 1, Math.max(0, px))),
      y: Math.round(Math.min(f.pixelHeight - 1, Math.max(0, py)))
    }
  }

  private async sendTouches(grpc: EmulatorGrpc, touches: EmuTouch[]): Promise<void> {
    await grpc.unary('sendTouch', touchEvent(touches), 5000)
  }

  private async touch(phase: string, x: number, y: number, id = 0): Promise<void> {
    const grpc = this.needReady()
    if (phase === 'down') {
      const p = this.toPx(x, y, true)
      this.fingers.set(id, p)
      await this.sendTouches(grpc, [{ ...p, identifier: id, pressure: 1 }])
    } else if (phase === 'move') {
      if (!this.fingers.has(id)) throw new CmdError('no-touch', 'move without a touch down')
      const p = this.toPx(x, y, false)
      this.fingers.set(id, p)
      await this.sendTouches(grpc, [{ ...p, identifier: id, pressure: 1 }])
    } else {
      if (!this.fingers.has(id)) throw new CmdError('no-touch', 'up without a touch down')
      const p = this.toPx(x, y, false)
      this.fingers.delete(id)
      await this.sendTouches(grpc, [{ ...p, identifier: id, pressure: 0 }])
    }
  }

  private async swipe(r: Record<string, number>): Promise<void> {
    const steps = Math.round(clamp(r.steps, 1, 200, 20))
    const ms = clamp(r.ms, 1, 5000, 300)
    await this.touch('down', r.x1, r.y1)
    for (let i = 1; i <= steps; i++) {
      await sleep(ms / steps)
      const t = i / steps
      await this.touch('move', r.x1 + (r.x2 - r.x1) * t, r.y1 + (r.y2 - r.y1) * t)
    }
    await this.touch('up', r.x2, r.y2)
  }

  private async pinch(r: Record<string, number>): Promise<void> {
    const grpc = this.needReady()
    const steps = Math.round(clamp(r.steps, 1, 200, 20))
    const ms = clamp(r.ms, 1, 5000, 400)
    const a = (clamp(r.angleDeg, -360, 360, 45) * Math.PI) / 180
    const at = (rad: number): EmuTouch[] => {
      const dx = Math.cos(a) * rad
      const dy = Math.sin(a) * rad
      const p0 = this.toPx(r.cx + dx, r.cy + dy, false)
      const p1 = this.toPx(r.cx - dx, r.cy - dy, false)
      return [
        { ...p0, identifier: 0, pressure: 1 },
        { ...p1, identifier: 1, pressure: 1 }
      ]
    }
    this.toPx(r.cx, r.cy, true)
    await this.sendTouches(grpc, at(r.r1))
    for (let i = 1; i <= steps; i++) {
      await sleep(ms / steps)
      await this.sendTouches(grpc, at(r.r1 + ((r.r2 - r.r1) * i) / steps))
    }
    await this.sendTouches(grpc, at(r.r2).map((t) => ({ ...t, pressure: 0 })))
  }

  private async key(grpc: EmulatorGrpc, key: string, eventType = KEY_PRESS): Promise<void> {
    await grpc.unary('sendKey', keyboardEvent({ key, eventType }), 5000)
  }

  private async hidKey(r: Record<string, unknown>): Promise<void> {
    const grpc = this.needReady()
    const usage = Number(r.usage)
    const mods = Array.isArray(r.mods) ? (r.mods as string[]).filter((m) => MODIFIER_KEYS[m]) : []
    // Shift alone just picks the shifted character; other modifiers are held around the key.
    const shift = mods.includes('shift')
    const key = hidToKey(usage, shift)
    const shiftConsumed = shift && hidToKey(usage, false) !== key
    const held = mods.filter((m) => m !== 'shift' || !shiftConsumed).map((m) => MODIFIER_KEYS[m])
    if (!key) throw new CmdError('bad-request', `key: usage 0x${usage.toString(16)} has no Android equivalent`)
    if (r.down === true) return this.key(grpc, key, KEY_DOWN)
    if (r.down === false) return this.key(grpc, key, KEY_UP)
    for (const m of held) await this.key(grpc, m, KEY_DOWN)
    try {
      await this.key(grpc, key, KEY_PRESS)
    } finally {
      for (const m of held.reverse()) await this.key(grpc, m, KEY_UP)
    }
  }

  private async text(r: Record<string, unknown>): Promise<{ typed: number; pasted: number }> {
    const grpc = this.needReady()
    const text = String(r.text ?? '')
    if (!text) throw new CmdError('bad-request', 'text: empty')
    if (r.paste !== true && isTypable(text)) {
      // Newlines as Enter presses: `text` types characters, and "\n" is not one.
      const parts = text.split('\n')
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]) await grpc.unary('sendKey', keyboardEvent({ text: parts[i] }), 10_000)
        if (i < parts.length - 1) await this.key(grpc, 'Enter')
      }
      return { typed: text.length, pasted: 0 }
    }
    // Anything else through the clipboard (overwrites the device clipboard), then KEYCODE_PASTE.
    // MEASURED (emulator 36.6, API 30): gRPC `text` drops non-ASCII characters, and neither a W3C
    // Control+v nor evdev Ctrl+V / KEY_PASTE over gRPC pastes — modifiers do not combine there. adb's
    // `input keyevent 279` does (~0.5 s).
    try {
      await grpc.unary('setClipboard', clipData(text), 5000)
    } catch (e) {
      throw new CmdError('paste-failed', `setClipboard: ${(e as Error).message}`)
    }
    await sleep(150)
    try {
      await run(this.sdk.adb, ['-s', this.serial, 'shell', 'input', 'keyevent', '279'], 8000)
    } catch (e) {
      throw new CmdError('paste-failed', `paste: ${(e as Error).message}`)
    }
    return { typed: 0, pasted: [...text].length }
  }

  private async button(r: Record<string, unknown>): Promise<void> {
    const grpc = this.needReady()
    const name = String(r.name ?? '')
    const key = BUTTON_KEYS[name]
    if (!key) throw new CmdError('bad-request', `button: ${name} has no Android equivalent (home, back, recents, power, volup, voldown)`)
    const hold = clamp(r.holdMs, 0, 5000, 0)
    if (hold > 0) {
      await this.key(grpc, key, KEY_DOWN)
      await sleep(hold)
      await this.key(grpc, key, KEY_UP)
    } else await this.key(grpc, key, KEY_PRESS)
  }

  // ── screenshot / describe ──

  private async screenshot(id: unknown, r: Record<string, unknown>): Promise<void> {
    const grpc = this.needReady()
    const f = this.facts!
    const scale = clamp(r.scale, 0.05, 1, 1)
    const format = r.format === 'jpeg' ? 'jpeg' : 'png'
    const w = Math.max(1, Math.round(f.pixelWidth * scale))
    const h = Math.max(1, Math.round(f.pixelHeight * scale))
    const img = decodeImage(await grpc.unary('getScreenshot', imageFormat(IMG_RGB888, w, h), 15_000))
    if (img.format !== IMG_RGB888 || img.data.length < img.width * img.height * 3) throw new CmdError('screenshot-failed', 'The emulator sent no image.')
    const s = sharp()(img.data, { raw: { width: img.width, height: img.height, channels: 3 } })
    const data = format === 'png' ? await s.png().toBuffer() : await s.jpeg({ quality: Math.round(clamp(r.quality, 0.05, 1, 0.85) * 100) }).toBuffer()
    const imageId = this.nextImageId++
    const head = Buffer.alloc(9)
    head.writeUInt32BE(imageId, 0)
    head[4] = format === 'png' ? 2 : 1
    head.writeUInt16BE(img.width, 5)
    head.writeUInt16BE(img.height, 7)
    writeMsg(MSG_IMAGE, Buffer.concat([head, data]))
    sendJson({ id, ok: true, imageId, format, width: img.width, height: img.height, bytes: data.length })
  }

  private async dump(): Promise<{ xml: string; ms: number }> {
    this.needReady()
    const t0 = Date.now()
    let last = ''
    for (let attempt = 0; attempt < 4; attempt++) {
      const out = await run(this.sdk.adb, ['-s', this.serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], 20_000).catch((e: Error) => e.message)
      const start = out.indexOf('<?xml')
      const end = out.lastIndexOf('</hierarchy>')
      if (start >= 0 && end > start) return { xml: out.slice(start, end + '</hierarchy>'.length), ms: Date.now() - t0 }
      last = out.trim().split('\n').pop() ?? ''
      // "could not get idle state" while the screen animates: try again shortly.
      await sleep(400)
    }
    throw new CmdError('describe-failed', `uiautomator dump failed${last ? `: ${last.slice(0, 200)}` : ''}`)
  }

  private screenPoints(): { width: number; height: number } {
    const f = this.facts!
    return { width: f.pixelWidth / this.scale, height: f.pixelHeight / this.scale }
  }

  private async describe(r: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { xml, ms } = await this.dump()
    const screen = this.screenPoints()
    const parsed = parseDump(xml, this.scale, screen)
    const flat = r.flat !== false
    return {
      ...(flat ? { elements: parsed.flat.map(stripChildren) } : { tree: parsed.tree }),
      count: parsed.flat.length,
      screen,
      ms
    }
  }

  private async describePoint(r: Record<string, unknown>): Promise<Record<string, unknown>> {
    const x = Number(r.x)
    const y = Number(r.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new CmdError('bad-request', 'describe-point: x and y must be numbers')
    const { xml, ms } = await this.dump()
    const parsed = parseDump(xml, this.scale, this.screenPoints())
    const hit = hitTest(parsed.flat, x, y)
    return { element: hit ? stripChildren(hit) : null, ms }
  }

  // ── boot ──

  private async boot(): Promise<Record<string, unknown>> {
    if (this.emu) return { alreadyRunning: true }
    if (this.bootChild && this.bootChild.exitCode === null && this.bootChild.signalCode === null) return { booting: true }
    const ports = await pickPorts(runningEmulators())
    if (!ports) throw new CmdError('boot-failed', 'No free emulator console port (5554–5682).')
    const logFile = path.join(os.tmpdir(), `nodeterm-android-${this.avd}.log`)
    const fd = fs.openSync(logFile, 'w', 0o600)
    const args = ['-avd', this.avd, '-no-window', '-no-audio', '-no-snapshot', '-no-boot-anim', '-gpu', 'host', '-grpc', String(ports.grpcPort), '-port', String(ports.consolePort)]
    log(`boot: emulator ${args.join(' ')}`)
    const child = spawn(this.sdk.emulator, args, { detached: true, stdio: ['ignore', fd, fd] })
    fs.closeSync(fd)
    child.unref()
    this.bootChild = child
    this.bootLog = logFile
    if (child.pid) this.writeOwned(child.pid)
    child.once('exit', (code, signal) => {
      if (this.bootChild !== child) return
      this.bootChild = null
      if (this.ready || this.stopping || signal) return
      let tail = ''
      try {
        tail = fs.readFileSync(logFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => /error|fatal|cannot|running multiple/i.test(l)).pop() ?? ''
      } catch {
        /* no log */
      }
      if (!this.emu) {
        event('error', { code: 'boot-failed', message: `The emulator exited (code ${code})${tail ? `: ${tail.slice(0, 240)}` : '.'}` })
        this.setState('Shutdown')
      }
    })
    child.once('error', (err) => {
      if (this.bootChild === child) this.bootChild = null
      event('error', { code: 'boot-failed', message: `Could not start the emulator: ${err.message}` })
    })
    this.setState('Booting')
    return { booting: true, consolePort: ports.consolePort, grpcPort: ports.grpcPort }
  }

  // ── dispatch ──

  async handle(raw: string): Promise<void> {
    let req: Record<string, unknown>
    try {
      req = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    if (!req || typeof req !== 'object') return
    const id = req.id
    const quiet = req.quiet === true
    const ok = (body: Record<string, unknown> = {}): void => {
      if (!quiet) sendJson({ id, ok: true, ...body })
    }
    const fail = (code: string, error: string): void => sendJson({ id, ok: false, code, error })
    const t0 = Date.now()
    const ms = (): number => Date.now() - t0
    const num = (k: string): number => {
      const v = req[k]
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new CmdError('bad-request', `${String(req.cmd)}: ${k} must be a number`)
      return v
    }
    const exec = async (fn: () => Promise<void>): Promise<void> => {
      try {
        await fn()
      } catch (e) {
        if (e instanceof CmdError) fail(e.code, e.message)
        else fail('failed', (e as Error).message ?? String(e))
      }
    }
    const queued = (q: 'input' | 'describe' | 'shot', fn: () => Promise<void>): void => {
      const key = q === 'input' ? 'inputQueue' : q === 'describe' ? 'describeQueue' : 'shotQueue'
      const next = this[key].then(() => exec(fn))
      this[key] = next.catch(() => undefined)
    }
    switch (req.cmd) {
      case 'ping':
        return ok({ t: Date.now() * 1000 })
      case 'info':
        return ok({ device: this.deviceBody() })
      case 'stream': {
        const on = req.on !== false
        this.want = {
          on,
          maxFps: clamp(req.maxFps, 1, 120, this.want.maxFps),
          scale: clamp(req.scale, 0.05, 1, this.want.scale),
          quality: clamp(req.quality, 0.05, 1, this.want.quality)
        }
        this.applyStream()
        return ok({ streaming: on, deviceReady: this.ready })
      }
      case 'boot':
        return exec(async () => ok(await this.boot()))
      case 'touch':
        return queued('input', async () => {
          const phase = req.phase
          if (phase !== 'down' && phase !== 'move' && phase !== 'up') throw new CmdError('bad-request', 'touch: phase must be down, move or up')
          await this.touch(phase, num('x'), num('y'))
          ok({ ms: ms() })
        })
      case 'tap':
        return queued('input', async () => {
          const x = num('x')
          const y = num('y')
          await this.touch('down', x, y)
          await sleep(clamp(req.holdMs, 0, 5000, 40))
          await this.touch('up', x, y)
          ok({ ms: ms() })
        })
      case 'swipe':
        return queued('input', async () => {
          await this.swipe({ x1: num('x1'), y1: num('y1'), x2: num('x2'), y2: num('y2'), ms: req.ms as number, steps: req.steps as number })
          ok({ ms: ms() })
        })
      case 'pinch':
        return queued('input', async () => {
          await this.pinch({ cx: num('cx'), cy: num('cy'), r1: num('r1'), r2: num('r2'), ms: req.ms as number, steps: req.steps as number, angleDeg: req.angleDeg as number })
          ok({ ms: ms() })
        })
      case 'button':
        return queued('input', async () => {
          await this.button(req)
          ok({ ms: ms() })
        })
      case 'key':
        return queued('input', async () => {
          num('usage')
          await this.hidKey(req)
          ok({ ms: ms() })
        })
      case 'text':
        return queued('input', async () => {
          const r = await this.text(req)
          ok({ ...r, ms: ms() })
        })
      case 'screenshot':
        return queued('shot', () => this.screenshot(id, req))
      case 'describe':
        return queued('describe', async () => ok(await this.describe(req)))
      case 'describe-point':
        return queued('describe', async () => ok(await this.describePoint(req)))
      case 'quit':
        if (!quiet) sendJson({ id, ok: true })
        return this.shutdown(0)
      default:
        return fail('unknown-command', `unknown command ${String(req.cmd)}`)
    }
  }

  /** Release a held touch, stop OUR emulator (never the user's), drop the lock, exit. */
  async shutdown(code: number): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (this.monitorTimer) clearTimeout(this.monitorTimer)
    if (this.grpc && this.fingers.size) {
      try {
        await this.sendTouches(this.grpc, [...this.fingers].map(([identifier, p]) => ({ ...p, identifier, pressure: 0 })))
      } catch {
        /* best effort */
      }
    }
    this.stopStream()
    this.grpc?.close()
    const owned = this.readOwned()
    const targets = new Set<number>()
    if (owned !== null && this.emu && this.emu.pid === owned) targets.add(owned)
    if (owned !== null && !this.emu && pidAlive(owned)) {
      // Booting, not discovered yet: the launcher we spawned.
      if (this.bootChild?.pid === owned) targets.add(owned)
    }
    if (this.bootChild?.pid && this.bootChild.exitCode === null) targets.add(this.bootChild.pid)
    for (const pid of targets) {
      log(`stopping the emulator nodeterm started (pid ${pid})`)
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
    if (targets.size) this.writeOwned(null)
    releaseLock()
    // Let stdout drain the last reply before leaving.
    process.stdout.write('', () => process.exit(code))
    setTimeout(() => process.exit(code), 500).unref()
  }
}

// ─── lock: one controller per AVD ────────────────────────────────────────────────────────────

let lockPath = ''
function releaseLock(): void {
  if (!lockPath) return
  try {
    const held = Number(fs.readFileSync(lockPath, 'utf8'))
    if (held === process.pid) fs.rmSync(lockPath, { force: true })
  } catch {
    /* gone */
  }
  lockPath = ''
}

function takeLock(avd: string): boolean {
  const p = path.join(os.tmpdir(), `nodeterm-android-helper-${avd}.lock`)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(p, String(process.pid), { flag: 'wx', mode: 0o600 })
      lockPath = p
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const holder = Number(fs.readFileSync(p, 'utf8').trim())
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && pidAlive(holder)) return false
      fs.rmSync(p, { force: true }) // stale: its owner is gone
    }
  }
  return false
}

async function attachMode(id: string): Promise<number | null> {
  const fatal = (code: string, message: string, exit: number): number => {
    event('error', { code, message, fatal: true })
    return exit
  }
  const avd = avdOf(id)
  if (!avd) return fatal('device-not-found', `${id} is not an Android emulator id (android:<avd>).`, 4)
  const sdk = findSdk()
  if (!sdk) {
    return fatal(
      'no-android-sdk',
      'The Android SDK was not found (looked at ANDROID_SDK_ROOT, ANDROID_HOME and the default install location). Install Android Studio or the command-line tools.',
      5
    )
  }
  const home = avdHome()
  let known = fs.existsSync(path.join(home, `${avd}.ini`))
  if (!known) {
    try {
      known = parseAvdList(await run(sdk.emulator, ['-list-avds'], 10_000)).includes(avd)
    } catch {
      /* fall through */
    }
  }
  if (!known) return fatal('device-not-found', `No Android emulator named ${avd} (emulator -list-avds).`, 4)
  if (!takeLock(avd)) return fatal('already-attached', `Another nodeterm controller already drives ${avd}.`, 3)

  const ctl = new Controller(sdk, avd, readAvd(avd, home), path.join(os.tmpdir(), `nodeterm-android-helper-${avd}.owned.json`))
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    if (line.trim()) void ctl.handle(line)
  })
  rl.on('close', () => void ctl.shutdown(0))
  process.on('SIGTERM', () => void ctl.shutdown(0))
  process.on('SIGINT', () => void ctl.shutdown(0))
  process.stdout.on('error', () => void ctl.shutdown(0))
  ctl.start()
  return null // keep running
}

async function main(): Promise<void> {
  const [mode, arg] = process.argv.slice(2)
  if (mode === '--version') {
    process.stdout.write(VERSION + '\n')
    process.exit(0)
  }
  if (mode === 'list') process.exit(await listMode())
  if (mode === 'attach' && arg) {
    const code = await attachMode(arg)
    if (code !== null) process.stdout.write('', () => process.exit(code))
    return
  }
  process.stderr.write('usage: android-helper --version | list | attach android:<avd>\n')
  process.exit(2)
}

void main()
