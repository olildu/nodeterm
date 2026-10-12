/**
 * Finding the Android SDK, its AVDs and the emulators that are running right now.
 *
 * The parsers are pure (and unit-tested); the readers take the filesystem through Node directly —
 * this module only ever runs inside the helper process, never in nodeterm's main process.
 *
 * Running emulators are found through the emulator's own DISCOVERY files, the mechanism Android
 * Studio uses: every emulator writes `pid_<pid>.ini` into a per-user directory while it runs, naming
 * its AVD (`avd.id`), console port (`port.serial`, which is also the adb serial `emulator-<port>`),
 * and gRPC port and token if it has one. So a user-started emulator is found exactly like ours, and
 * nothing is guessed from process listings.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** `android:<avd>` — the device id nodeterm stores. AVD names are `[A-Za-z0-9._-]` (avdmanager's rule). */
export const ANDROID_ID = /^android:([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/

export function avdOf(id: string): string | null {
  const m = ANDROID_ID.exec(id)
  return m ? m[1] : null
}

/** First existing SDK root: the env vars, then the default install location per OS. */
export function sdkRootCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  const out: string[] = []
  for (const v of [env.NODETERM_ANDROID_SDK, env.ANDROID_SDK_ROOT, env.ANDROID_HOME]) if (v) out.push(v)
  if (platform === 'darwin') out.push(path.join(home, 'Library', 'Android', 'sdk'))
  else if (platform === 'win32') {
    if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'Android', 'Sdk'))
  } else out.push(path.join(home, 'Android', 'Sdk'))
  return out
}

export interface Sdk {
  root: string
  adb: string
  emulator: string
}

export function findSdk(env: NodeJS.ProcessEnv = process.env): Sdk | null {
  const exe = process.platform === 'win32' ? '.exe' : ''
  for (const root of sdkRootCandidates(env, process.platform, os.homedir())) {
    const adb = path.join(root, 'platform-tools', `adb${exe}`)
    const emulator = path.join(root, 'emulator', `emulator${exe}`)
    if (fs.existsSync(adb) && fs.existsSync(emulator)) return { root, adb, emulator }
  }
  return null
}

/** `key=value` lines (the AVD `.ini`, `config.ini` and the discovery files all use it). */
export function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i <= 0) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/** API level → Android version, for the "runtime" label. Unknown levels say the API level. */
const ANDROID_VERSIONS: Record<number, string> = {
  21: '5.0', 22: '5.1', 23: '6', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9', 29: '10',
  30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16'
}

export function runtimeLabel(target: string | undefined): string {
  const m = /android-(\d+)/.exec(target ?? '')
  if (!m) return 'Android'
  const api = Number(m[1])
  return ANDROID_VERSIONS[api] ? `Android ${ANDROID_VERSIONS[api]}` : `Android API ${api}`
}

export interface AvdInfo {
  avd: string
  name: string
  runtime: string
  deviceType?: string
  /** From config.ini, before a boot tells us better. */
  pixelWidth?: number
  pixelHeight?: number
  density?: number
}

export function avdHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME
  const base = env.ANDROID_USER_HOME ?? (env.ANDROID_EMULATOR_HOME || path.join(os.homedir(), '.android'))
  return path.join(base, 'avd')
}

/** Reads `<avdHome>/<avd>.ini` + its `config.ini`. Anything unreadable degrades to the bare name. */
export function readAvd(avd: string, home = avdHome()): AvdInfo {
  const base: AvdInfo = { avd, name: avd.replace(/_/g, ' '), runtime: 'Android' }
  try {
    const top = parseIni(fs.readFileSync(path.join(home, `${avd}.ini`), 'utf8'))
    base.runtime = runtimeLabel(top.target)
    const dir = top.path && fs.existsSync(top.path) ? top.path : path.join(home, `${avd}.avd`)
    const cfg = parseIni(fs.readFileSync(path.join(dir, 'config.ini'), 'utf8'))
    if (cfg['avd.ini.displayname']) base.name = cfg['avd.ini.displayname'].slice(0, 80)
    if (cfg['hw.device.name']) base.deviceType = cfg['hw.device.name'].slice(0, 80)
    const n = (v: string | undefined): number | undefined => (v && /^\d+$/.test(v) ? Number(v) : undefined)
    base.pixelWidth = n(cfg['hw.lcd.width'])
    base.pixelHeight = n(cfg['hw.lcd.height'])
    base.density = n(cfg['hw.lcd.density'])
    if (base.runtime === 'Android' && cfg['image.sysdir.1']) base.runtime = runtimeLabel(cfg['image.sysdir.1'])
  } catch {
    /* missing or unreadable: the bare name */
  }
  return base
}

/** `emulator -list-avds` output (one name per line; the emulator also prints INFO/WARNING lines). */
export function parseAvdList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9._-]{1,100}$/.test(l))
}

// ─── running emulators ───────────────────────────────────────────────────────────────────────

export interface RunningEmulator {
  pid: number
  avd: string
  /** Console port; the adb serial is `emulator-<consolePort>`. */
  consolePort: number
  grpcPort?: number
  grpcToken?: string
  /** The emulator asks for a JWT (Android Studio's default) — a token we cannot mint. */
  grpcJwt?: boolean
  cmdline: string
}

export function discoveryDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string, uid: number | null): string[] {
  const out: string[] = []
  if (platform === 'darwin') out.push(path.join(home, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running'))
  else if (platform === 'win32') {
    if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'Temp', 'avd', 'running'))
  } else {
    if (env.XDG_RUNTIME_DIR) out.push(path.join(env.XDG_RUNTIME_DIR, 'avd', 'running'))
    if (uid !== null) out.push(path.join('/run/user', String(uid), 'avd', 'running'))
    out.push(path.join(os.tmpdir(), `android-${os.userInfo().username}`, 'avd', 'running'))
  }
  return out
}

export function parseDiscovery(pid: number, text: string): RunningEmulator | null {
  const ini = parseIni(text)
  const avd = ini['avd.id']
  const consolePort = Number(ini['port.serial'])
  if (!avd || !Number.isInteger(consolePort) || consolePort <= 0) return null
  const grpc = Number(ini['grpc.port'])
  return {
    pid,
    avd,
    consolePort,
    ...(Number.isInteger(grpc) && grpc > 0 ? { grpcPort: grpc } : {}),
    ...(ini['grpc.token'] ? { grpcToken: ini['grpc.token'] } : {}),
    ...(ini['grpc.jwks'] || ini['grpc.jwk_active'] ? { grpcJwt: true } : {}),
    cmdline: ini.cmdline ?? ''
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function runningEmulators(dirs = discoveryDirs(process.env, process.platform, os.homedir(), typeof process.getuid === 'function' ? process.getuid() : null)): RunningEmulator[] {
  const out: RunningEmulator[] = []
  const seen = new Set<number>()
  for (const dir of dirs) {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const m = /^pid_(\d+)\.ini$/.exec(name)
      if (!m) continue
      const pid = Number(m[1])
      if (seen.has(pid) || !pidAlive(pid)) continue
      try {
        const e = parseDiscovery(pid, fs.readFileSync(path.join(dir, name), 'utf8'))
        if (e) {
          out.push(e)
          seen.add(pid)
        }
      } catch {
        /* being written or removed */
      }
    }
  }
  return out
}

/** Free TCP port on 127.0.0.1? */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

/**
 * A console port (even, 5554–5682, its adb port +1 free too) and a gRPC port nobody uses. The
 * emulator's own rule: console ports are even and adb is console+1.
 */
export async function pickPorts(running: RunningEmulator[]): Promise<{ consolePort: number; grpcPort: number } | null> {
  const usedConsole = new Set(running.map((r) => r.consolePort))
  const usedGrpc = new Set(running.map((r) => r.grpcPort).filter((p): p is number => !!p))
  for (let c = 5554; c <= 5682; c += 2) {
    if (usedConsole.has(c)) continue
    if (!(await portFree(c)) || !(await portFree(c + 1))) continue
    for (let g = 8554 + (c - 5554); g < 8554 + 400; g++) {
      if (usedGrpc.has(g)) continue
      if (await portFree(g)) return { consolePort: c, grpcPort: g }
    }
  }
  return null
}

/** `wm size` → the effective size (an Override wins over the Physical one). */
export function parseWmSize(stdout: string): { width: number; height: number } | null {
  let found: { width: number; height: number } | null = null
  for (const m of stdout.matchAll(/(Physical|Override) size:\s*(\d+)x(\d+)/g)) {
    const v = { width: Number(m[2]), height: Number(m[3]) }
    if (m[1] === 'Override' || !found) found = v
  }
  return found
}

export function parseWmDensity(stdout: string): number | null {
  let found: number | null = null
  for (const m of stdout.matchAll(/(Physical|Override) density:\s*(\d+)/g)) {
    const v = Number(m[2])
    if (m[1] === 'Override' || found === null) found = v
  }
  return found
}
