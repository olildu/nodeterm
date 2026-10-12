import { SIM_MSG_FRAME, SIM_MSG_IMAGE, SIM_MSG_JSON, SimFrameError, SimFrameParser } from './frames'

/**
 * One `sim-helper attach <udid>` child: request/reply over its stdin/stdout, with the framing
 * (`frames.ts`) and the lifecycle rules in one place so `service.ts` only reasons about devices.
 *
 * The child is injected (`spawn`) so the lifecycle — refcounting, crash handling, quit-then-kill —
 * is tested with a fake process; nothing here imports `node:child_process`.
 */

export interface HelperChild {
  stdin: {
    write(chunk: string): unknown
    end(): unknown
    on(event: 'error', cb: (err: Error) => void): unknown
    destroyed?: boolean
    /** Bytes queued in the pipe; a wedged helper makes this grow. */
    writableLength?: number
  } | null
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): unknown } | null
  stderr: { on(event: 'data', cb: (chunk: Buffer) => void): unknown } | null
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', cb: (err: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
  pid?: number
}

export type SpawnHelper = (bin: string, args: string[], env?: Record<string, string>) => HelperChild

/**
 * How to start a helper: the executable, the arguments BEFORE `attach <udid>`, and extra env. The iOS
 * helper is a native binary (`{bin}`); the Android one is a script run by Electron's own Node
 * (`{bin: execPath, args: [script], env: {ELECTRON_RUN_AS_NODE: '1'}}`).
 */
export interface HelperLaunch {
  bin: string
  args?: string[]
  env?: Record<string, string>
}

export type HelperEvent = { event: string } & Record<string, unknown>
export type HelperReply = { ok: boolean } & Record<string, unknown>

export interface HelperImage {
  imageId: number
  format: 'jpeg' | 'png'
  width: number
  height: number
  data: Buffer
}

export interface HelperExit {
  code: number | null
  signal: string | null
  /** Set when the process could not even start (ENOENT, EACCES). */
  spawnError?: string
  /** The last few hundred bytes of the helper's stderr, for the log line. */
  stderrTail: string
  /** We asked it to go (quit / kill) — not a crash. */
  requested: boolean
}

export interface HelperHandlers {
  onFrame(payload: Buffer): void
  onEvent(event: HelperEvent): void
  onExit(info: HelperExit): void
}

/** Replies slower than this are answered `timeout` so a wedged helper cannot hang a caller. */
const DEFAULT_TIMEOUT_MS = 10_000
const TIMEOUTS: Record<string, number> = { describe: 45_000, screenshot: 20_000 }
/** How long a `quit` gets before SIGTERM, and SIGTERM before SIGKILL. */
export const QUIT_GRACE_MS = 1_500
const STDERR_TAIL = 600
/** Unread bytes in the helper's stdin beyond which fire-and-forget input is dropped. */
export const FIRE_BACKLOG_MAX = 256 * 1024

interface Pending {
  resolve: (r: HelperReply) => void
  timer: ReturnType<typeof setTimeout>
  cmd: string
}

export class SimHelper {
  private child: HelperChild | null = null
  private parser = new SimFrameParser()
  private nextId = 1
  private pending = new Map<number, Pending>()
  private images = new Map<number, HelperImage>()
  private stderrTail = ''
  private exited = false
  private quitting = false
  private exitWaiters: Array<() => void> = []

  constructor(
    private readonly launch: HelperLaunch,
    private readonly udid: string,
    private readonly spawn: SpawnHelper,
    private readonly handlers: HelperHandlers
  ) {}

  get running(): boolean {
    return this.child !== null && !this.exited
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  start(): void {
    let child: HelperChild
    try {
      const { bin, args = [], env } = this.launch
      child = env ? this.spawn(bin, [...args, 'attach', this.udid], env) : this.spawn(bin, [...args, 'attach', this.udid])
    } catch (e) {
      this.finish(null, null, e instanceof Error ? e.message : String(e))
      return
    }
    this.child = child
    // A pipe write failure is an async 'error' EVENT, not a throw (see stream-epipe.guard.test.ts):
    // the helper dying mid-write must not take the main process with it. The exit handler reports.
    child.stdin?.on('error', (err) => console.warn('[sim] helper stdin error:', err.message))
    child.stdout?.on('data', (chunk) => this.onStdout(chunk))
    child.stderr?.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL)
    })
    // 'error' fires for a spawn failure (and may or may not be followed by 'exit'); `finish` is idempotent.
    child.on('error', (err) => this.finish(null, null, err.message))
    child.on('exit', (code, signal) => this.finish(code, signal))
  }

  /** A reply is awaited. Resolves `{ok:false}` (never rejects) on timeout, exit or a dead stdin. */
  request(cmd: Record<string, unknown>): Promise<HelperReply> {
    const name = typeof cmd.cmd === 'string' ? cmd.cmd : ''
    if (!this.running) return Promise.resolve(notRunning())
    const id = this.nextId++
    return new Promise<HelperReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, code: 'timeout', error: `${name} timed out` })
      }, TIMEOUTS[name] ?? DEFAULT_TIMEOUT_MS)
      this.pending.set(id, { resolve, timer, cmd: name })
      if (!this.write({ id, ...cmd })) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(notRunning())
      }
    })
  }

  /** A screenshot: the helper sends the image (type 3) just before the reply that names it. */
  async requestImage(cmd: Record<string, unknown>): Promise<{ reply: HelperReply; image?: HelperImage }> {
    const reply = await this.request(cmd)
    const imageId = reply.ok && typeof reply.imageId === 'number' ? reply.imageId : null
    const image = imageId !== null ? this.images.get(imageId) : undefined
    if (imageId !== null) this.images.delete(imageId)
    return { reply, image }
  }

  /** No reply wanted (`quiet: true`). A failing command still gets an error reply, which nobody awaits. */
  fire(cmd: Record<string, unknown>): void {
    if (!this.running) return
    // A wedged helper that never reads would otherwise buffer every touch move forever. Input that
    // far behind is stale anyway; drop it (replies and `quit` still go through `write`).
    if ((this.child?.stdin?.writableLength ?? 0) > FIRE_BACKLOG_MAX) return
    this.write({ id: this.nextId++, ...cmd, quiet: true })
  }

  /**
   * Ask it to leave: `quit`, then SIGTERM after {@link QUIT_GRACE_MS}, then SIGKILL after the same
   * again. Resolves once the process is gone. Safe to call twice and after an exit.
   */
  quit(): Promise<void> {
    if (!this.running) return Promise.resolve()
    this.quitting = true
    const done = new Promise<void>((resolve) => this.exitWaiters.push(resolve))
    this.write({ id: this.nextId++, cmd: 'quit' })
    try {
      this.child?.stdin?.end()
    } catch {
      /* already closed */
    }
    const term = setTimeout(() => {
      if (!this.running) return
      this.child?.kill('SIGTERM')
      const kill = setTimeout(() => {
        if (this.running) this.child?.kill('SIGKILL')
      }, QUIT_GRACE_MS)
      void done.then(() => clearTimeout(kill))
    }, QUIT_GRACE_MS)
    void done.then(() => clearTimeout(term))
    return done
  }

  private write(obj: Record<string, unknown>): boolean {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed) return false
    try {
      stdin.write(JSON.stringify(obj) + '\n')
      return true
    } catch {
      return false
    }
  }

  private onStdout(chunk: Buffer): void {
    let messages
    try {
      messages = this.parser.push(chunk)
    } catch (e) {
      if (e instanceof SimFrameError) {
        // Framing is lost; nothing after this can be trusted. Kill it — the exit handler reports.
        this.child?.kill('SIGKILL')
        return
      }
      throw e
    }
    for (const m of messages) {
      if (m.type === SIM_MSG_FRAME) {
        this.handlers.onFrame(m.payload)
      } else if (m.type === SIM_MSG_IMAGE) {
        this.images.set(m.imageId, m)
        // A screenshot whose reply never comes would otherwise pin its bytes; keep the newest few.
        while (this.images.size > 4) this.images.delete(this.images.keys().next().value as number)
      } else if (m.type === SIM_MSG_JSON) {
        this.onJson(m.json)
      }
    }
  }

  private onJson(json: unknown): void {
    if (!json || typeof json !== 'object') return
    const msg = json as Record<string, unknown>
    if (typeof msg.event === 'string') {
      this.handlers.onEvent(msg as HelperEvent)
      return
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return // an error reply to a quiet command, or one that already timed out
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      p.resolve(msg as HelperReply)
    }
  }

  private finish(code: number | null, signal: string | null, spawnError?: string): void {
    if (this.exited) return
    this.exited = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve(notRunning())
    }
    this.pending.clear()
    this.images.clear()
    const waiters = this.exitWaiters
    this.exitWaiters = []
    this.handlers.onExit({
      code,
      signal,
      ...(spawnError ? { spawnError } : {}),
      stderrTail: this.stderrTail.trim(),
      requested: this.quitting
    })
    for (const w of waiters) w()
  }
}

function notRunning(): HelperReply {
  return { ok: false, code: 'not-running', error: 'The simulator helper is not running.' }
}
