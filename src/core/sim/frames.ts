// sim-helper's stdout framing (native/sim-helper/PROTOCOL.md): `u32be len | u8 type | payload`,
// `len` counting the type byte plus the payload. Pure — the process wrapper feeds it chunks.

export const SIM_MSG_FRAME = 1
export const SIM_MSG_JSON = 2
export const SIM_MSG_IMAGE = 3

/** A video frame is a few tens of KB; a still image at full scale a few MB. Anything near this is a corrupt stream. */
export const SIM_MAX_MESSAGE_BYTES = 64 * 1024 * 1024

export type HelperMessage =
  /** `u64 µs | u16 w | u16 h | JPEG` — forwarded to renderers unchanged. */
  | { type: typeof SIM_MSG_FRAME; payload: Buffer }
  | { type: typeof SIM_MSG_JSON; json: unknown }
  | {
      type: typeof SIM_MSG_IMAGE
      imageId: number
      format: 'jpeg' | 'png'
      width: number
      height: number
      data: Buffer
    }

export class SimFrameError extends Error {}

/**
 * Incremental parser. Chunks are kept as a list and joined only when a whole message is available,
 * so a 30 KB frame arriving in 64 KB pipe reads costs one copy, not one per chunk. A malformed
 * length (zero, or past {@link SIM_MAX_MESSAGE_BYTES}) throws {@link SimFrameError}: the stream has
 * lost framing and nothing after it can be trusted, so the caller kills the helper.
 */
export class SimFrameParser {
  private chunks: Buffer[] = []
  private size = 0

  push(chunk: Buffer): HelperMessage[] {
    this.chunks.push(chunk)
    this.size += chunk.length
    const out: HelperMessage[] = []
    for (;;) {
      if (this.size < 4) break
      const head = this.peek(4)
      const len = head.readUInt32BE(0)
      if (len < 1 || len > SIM_MAX_MESSAGE_BYTES) throw new SimFrameError(`bad message length ${len}`)
      if (this.size < 4 + len) break
      const body = this.take(4 + len).subarray(4)
      const type = body[0]
      const payload = body.subarray(1)
      const msg = decode(type, payload)
      if (msg) out.push(msg)
    }
    return out
  }

  /** Bytes buffered but not yet a whole message (tests, and the exit log). */
  get pending(): number {
    return this.size
  }

  private join(): void {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.size)]
  }

  private peek(n: number): Buffer {
    this.join()
    return this.chunks[0].subarray(0, n)
  }

  private take(n: number): Buffer {
    this.join()
    const whole = this.chunks[0]
    const out = whole.subarray(0, n)
    this.chunks = n < whole.length ? [whole.subarray(n)] : []
    this.size -= n
    return out
  }
}

function decode(type: number, p: Buffer): HelperMessage | null {
  if (type === SIM_MSG_FRAME) {
    // 12-byte header + at least one image byte; a shorter one is dropped, not fatal.
    return p.length > 12 ? { type, payload: Buffer.from(p) } : null
  }
  if (type === SIM_MSG_JSON) {
    try {
      return { type, json: JSON.parse(p.toString('utf8')) }
    } catch {
      return null
    }
  }
  if (type === SIM_MSG_IMAGE) {
    if (p.length < 9) return null
    const fmt = p[4]
    return {
      type,
      imageId: p.readUInt32BE(0),
      format: fmt === 2 ? 'png' : 'jpeg',
      width: p.readUInt16BE(5),
      height: p.readUInt16BE(7),
      data: Buffer.from(p.subarray(9))
    }
  }
  return null // an unknown type from a newer helper is skipped, not fatal
}
