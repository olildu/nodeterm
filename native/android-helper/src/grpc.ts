/**
 * Just enough protobuf and gRPC to talk to the Android emulator's `EmulatorController` service
 * (`emulator/lib/emulator_controller.proto` in the SDK) over `node:http2`.
 *
 * WHY hand-rolled: the helper must run as one file under Electron's Node (`ELECTRON_RUN_AS_NODE`)
 * with no node_modules of its own, and the handful of messages it needs (ImageFormat, Image,
 * TouchEvent, KeyboardEvent, ClipData, EmulatorStatus) are flat. `@grpc/grpc-js` + a proto loader
 * would add two dependencies and a .proto file to ship for ~200 lines of wire format.
 *
 * Wire format recap: a gRPC message is `u8 compressed(0) | u32be length | protobuf bytes`, sent as
 * an HTTP/2 POST to `/<package>.<Service>/<method>` with `content-type: application/grpc` and
 * `te: trailers`; the status arrives in the `grpc-status` trailer (or header, for an immediate error).
 */
import http2 from 'node:http2'

// ─── protobuf ────────────────────────────────────────────────────────────────────────────────

function varint(value: number | bigint): Buffer {
  let n = BigInt(value)
  if (n < 0n) n += 1n << 64n
  const out: number[] = []
  do {
    let byte = Number(n & 0x7fn)
    n >>= 7n
    if (n) byte |= 0x80
    out.push(byte)
  } while (n)
  return Buffer.from(out)
}

const key = (field: number, wire: number): Buffer => varint((field << 3) | wire)

/** A varint field; proto3 omits zero values, and so do we. */
export function pbInt(field: number, value: number | undefined): Buffer {
  return value ? Buffer.concat([key(field, 0), varint(Math.trunc(value))]) : Buffer.alloc(0)
}

export function pbBytes(field: number, bytes: Buffer): Buffer {
  return Buffer.concat([key(field, 2), varint(bytes.length), bytes])
}

export function pbString(field: number, value: string | undefined): Buffer {
  return value ? pbBytes(field, Buffer.from(value, 'utf8')) : Buffer.alloc(0)
}

export function pbMessage(field: number, body: Buffer): Buffer {
  return pbBytes(field, body)
}

export type PbValue = bigint | Buffer
export type PbFields = Map<number, PbValue[]>

/** Decodes one message into field number → values (varints as bigint, length-delimited as Buffer). */
export function pbDecode(buf: Buffer): PbFields {
  const out: PbFields = new Map()
  let i = 0
  const readVarint = (): bigint => {
    let result = 0n
    let shift = 0n
    for (;;) {
      if (i >= buf.length) throw new Error('truncated varint')
      const b = buf[i++]
      result |= BigInt(b & 0x7f) << shift
      if (!(b & 0x80)) return result
      shift += 7n
      if (shift > 70n) throw new Error('varint too long')
    }
  }
  while (i < buf.length) {
    const k = readVarint()
    const field = Number(k >> 3n)
    const wire = Number(k & 7n)
    let value: PbValue
    if (wire === 0) value = readVarint()
    else if (wire === 2) {
      const len = Number(readVarint())
      if (i + len > buf.length) throw new Error('truncated field')
      value = buf.subarray(i, i + len)
      i += len
    } else if (wire === 5) {
      value = BigInt(buf.readUInt32LE(i))
      i += 4
    } else if (wire === 1) {
      value = buf.readBigUInt64LE(i)
      i += 8
    } else throw new Error(`unsupported wire type ${wire}`)
    const list = out.get(field)
    if (list) list.push(value)
    else out.set(field, [value])
  }
  return out
}

export const pbNum = (f: PbFields, field: number): number => {
  const v = f.get(field)?.[0]
  return typeof v === 'bigint' ? Number(v) : 0
}
export const pbBuf = (f: PbFields, field: number): Buffer | undefined => {
  const v = f.get(field)?.[0]
  return Buffer.isBuffer(v) ? v : undefined
}

// ─── emulator messages ───────────────────────────────────────────────────────────────────────

/** ImageFormat.ImgFormat */
export const IMG_PNG = 0
export const IMG_RGB888 = 2

export function imageFormat(format: number, width: number, height: number): Buffer {
  return Buffer.concat([pbInt(1, format), pbInt(3, width), pbInt(4, height)])
}

export interface EmuImage {
  format: number
  width: number
  height: number
  data: Buffer
  /** Unix µs (measured: the emulator stamps frames with wall-clock microseconds). */
  timestampUs: number
}

export function decodeImage(buf: Buffer): EmuImage {
  const f = pbDecode(buf)
  const fmt = pbBuf(f, 1)
  const ff = fmt ? pbDecode(fmt) : new Map()
  return {
    format: pbNum(ff, 1),
    width: pbNum(ff, 3) || pbNum(f, 2),
    height: pbNum(ff, 4) || pbNum(f, 3),
    data: pbBuf(f, 4) ?? Buffer.alloc(0),
    timestampUs: pbNum(f, 6)
  }
}

export interface EmuTouch {
  x: number
  y: number
  identifier: number
  /** 0 = lifted. */
  pressure: number
}

export function touchEvent(touches: EmuTouch[]): Buffer {
  return Buffer.concat(
    touches.map((t) =>
      pbMessage(
        1,
        Buffer.concat([
          // x/y may legitimately be 0, which proto3 omits — that IS 0 on the other side.
          pbInt(1, t.x),
          pbInt(2, t.y),
          pbInt(3, t.identifier),
          pbInt(4, t.pressure)
        ])
      )
    )
  )
}

/** KeyboardEvent.KeyEventType */
export const KEY_DOWN = 0
export const KEY_UP = 1
export const KEY_PRESS = 2

/** `key` is a W3C KeyboardEvent.key value ("Enter", "GoHome", "a"); `text` types a string. */
export function keyboardEvent(o: { eventType?: number; key?: string; text?: string }): Buffer {
  return Buffer.concat([pbInt(2, o.eventType ?? KEY_PRESS), pbString(4, o.key), pbString(5, o.text)])
}

export function clipData(text: string): Buffer {
  return pbString(1, text)
}

export function decodeStatus(buf: Buffer): { version: string; booted: boolean } {
  const f = pbDecode(buf)
  return { version: pbBuf(f, 1)?.toString('utf8') ?? '', booted: pbNum(f, 3) === 1 }
}

// ─── gRPC over http2 ─────────────────────────────────────────────────────────────────────────

const SERVICE = '/android.emulation.control.EmulatorController/'

/**
 * Reassembles gRPC length-prefixed messages (`u8 compressed | u32be length | payload`) from HTTP/2 DATA
 * chunks. A raw 1080x1920 RGB frame is 6.2 MB and arrives in a few hundred chunks, so the chunks are
 * KEPT in a list and joined ONCE per message: re-concatenating the whole buffer on every chunk costs
 * O(chunks x size) memcpy (measured 34 ms a frame at that size on an M4).
 */
export class GrpcMessageReader {
  private chunks: Buffer[] = []
  private have = 0
  /** Bytes of the message being read (5-byte prefix included); 0 = its prefix has not been read yet. */
  private need = 0

  /** Feeds one chunk; returns every message it completed (each WITHOUT the 5-byte prefix). */
  push(chunk: Buffer): Buffer[] {
    const out: Buffer[] = []
    if (chunk.length === 0) return out
    this.chunks.push(chunk)
    this.have += chunk.length
    for (;;) {
      if (this.need === 0) {
        if (this.have < 5) break
        const head = this.chunks[0].length >= 5 ? this.chunks[0] : Buffer.concat(this.chunks.slice(0, 5))
        this.need = 5 + head.readUInt32BE(1)
      }
      if (this.have < this.need) break
      out.push(this.take(this.need).subarray(5))
      this.need = 0
    }
    return out
  }

  /** Bytes buffered that are not yet a whole message. */
  get pending(): number {
    return this.have
  }

  private take(n: number): Buffer {
    const parts: Buffer[] = []
    let got = 0
    while (got < n) {
      const c = this.chunks[0]
      if (got + c.length <= n) {
        parts.push(c)
        this.chunks.shift()
        got += c.length
      } else {
        const k = n - got
        parts.push(c.subarray(0, k))
        this.chunks[0] = c.subarray(k)
        got = n
      }
    }
    this.have -= n
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, n)
  }
}

export class GrpcError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message)
  }
}

function frame(msg: Buffer): Buffer {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(msg.length, 1)
  return Buffer.concat([head, msg])
}

export interface StreamHandle {
  cancel(): void
  /** Settles when the stream ends for any reason (cancel included). */
  done: Promise<void>
}

/** HTTP/2 flow control we advertise to the emulator (see connect()). */
const STREAM_WINDOW_BYTES = 16 * 1024 * 1024
const SESSION_WINDOW_BYTES = 64 * 1024 * 1024
const MAX_FRAME_BYTES = 1024 * 1024

export class EmulatorGrpc {
  private session: http2.ClientHttp2Session | null = null
  private closed = false

  constructor(
    private readonly port: number,
    private readonly token?: string
  ) {}

  private connect(): http2.ClientHttp2Session {
    if (this.closed) throw new GrpcError('client closed', null)
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session
    // Node's HTTP/2 defaults (64 KB windows, 16 KB frames, 10 MB session memory) throttle multi-MB frames:
    // a 6 MB RGB frame needs ~95 window updates. Ask for big windows and frames up front.
    const s = http2.connect(`http://127.0.0.1:${this.port}`, {
      settings: { initialWindowSize: STREAM_WINDOW_BYTES, maxFrameSize: MAX_FRAME_BYTES },
      maxSessionMemory: 256
    })
    try {
      s.setLocalWindowSize(SESSION_WINDOW_BYTES)
    } catch {
      /* an older Node: the stream window above still applies */
    }
    s.on('error', () => {
      /* surfaced per call */
    })
    s.on('close', () => {
      if (this.session === s) this.session = null
    })
    this.session = s
    return s
  }

  private open(method: string): http2.ClientHttp2Stream {
    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': SERVICE + method,
      'content-type': 'application/grpc',
      te: 'trailers'
    }
    if (this.token) headers.authorization = `Bearer ${this.token}`
    return this.connect().request(headers)
  }

  /** Calls `method`, yielding each reply message to `onMessage`; resolves at the trailers. */
  private run(method: string, body: Buffer, onMessage: (m: Buffer) => void, timeoutMs?: number): { stream: http2.ClientHttp2Stream; done: Promise<void> } {
    const stream = this.open(method)
    const reader = new GrpcMessageReader()
    const done = new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      if (timeoutMs) {
        timer = setTimeout(() => {
          stream.close(http2.constants.NGHTTP2_CANCEL)
          reject(new GrpcError(`${method} timed out`, null))
        }, timeoutMs)
      }
      const check = (h: http2.IncomingHttpHeaders): boolean => {
        const raw = h['grpc-status']
        if (raw === undefined) return false
        const status = Number(raw)
        if (timer) clearTimeout(timer)
        if (status === 0) resolve()
        else reject(new GrpcError(`${method}: ${String(h['grpc-message'] ?? `grpc status ${status}`)}`, status))
        return true
      }
      stream.on('response', (h) => {
        check(h) // a "trailers-only" response puts the status in the headers
      })
      stream.on('data', (chunk: Buffer) => {
        for (const msg of reader.push(chunk)) {
          try {
            onMessage(msg)
          } catch (e) {
            console.error('[android-helper] message handler threw:', e)
          }
        }
      })
      stream.on('trailers', (h) => {
        check(h)
      })
      stream.on('close', () => {
        if (timer) clearTimeout(timer)
        resolve() // a cancelled or reset stream: settled; a status, if any, already decided it
      })
      stream.on('error', (err) => {
        if (timer) clearTimeout(timer)
        reject(new GrpcError(`${method}: ${err.message}`, null))
      })
    })
    stream.end(frame(body))
    return { stream, done }
  }

  async unary(method: string, body: Buffer, timeoutMs = 10_000): Promise<Buffer> {
    let reply: Buffer<ArrayBufferLike> | null = null
    await this.run(method, body, (m) => (reply = Buffer.from(m)), timeoutMs).done
    return reply ?? Buffer.alloc(0)
  }

  serverStream(method: string, body: Buffer, onMessage: (m: Buffer) => void): StreamHandle {
    const { stream, done } = this.run(method, body, onMessage)
    return {
      cancel: () => {
        if (!stream.closed) stream.close(http2.constants.NGHTTP2_CANCEL)
      },
      done: done.catch(() => undefined)
    }
  }

  close(): void {
    this.closed = true
    this.session?.close()
    this.session = null
  }
}
