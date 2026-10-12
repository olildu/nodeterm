import { describe, expect, it } from 'vitest'
import { SIM_MAX_MESSAGE_BYTES, SimFrameError, SimFrameParser } from './frames'

const msg = (type: number, payload: Buffer): Buffer => {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(payload.length + 1, 0)
  head[4] = type
  return Buffer.concat([head, payload])
}
const json = (o: unknown): Buffer => msg(2, Buffer.from(JSON.stringify(o)))
const videoPayload = (w: number, h: number, n: number): Buffer => {
  const p = Buffer.alloc(12 + n, 7)
  p.writeUInt16BE(w, 8)
  p.writeUInt16BE(h, 10)
  return p
}

describe('SimFrameParser', () => {
  it('parses back-to-back messages in one chunk', () => {
    const p = new SimFrameParser()
    const out = p.push(Buffer.concat([json({ event: 'ready' }), msg(1, videoPayload(4, 8, 3)), json({ id: 1, ok: true })]))
    expect(out.map((m) => m.type)).toEqual([2, 1, 2])
    expect(out[0]).toMatchObject({ json: { event: 'ready' } })
    expect(p.pending).toBe(0)
  })
  it('reassembles a message split at every possible byte boundary', () => {
    const whole = Buffer.concat([json({ id: 3, ok: true, n: 'é' }), msg(1, videoPayload(2, 2, 40))])
    for (let cut = 1; cut < whole.length; cut++) {
      const p = new SimFrameParser()
      const got = [...p.push(whole.subarray(0, cut)), ...p.push(whole.subarray(cut))]
      expect(got.map((m) => m.type), `cut ${cut}`).toEqual([2, 1])
    }
  })
  it('reassembles a message delivered one byte at a time', () => {
    const p = new SimFrameParser()
    const got = []
    for (const b of json({ event: 'x' })) got.push(...p.push(Buffer.from([b])))
    expect(got).toHaveLength(1)
  })
  it('decodes a still image (type 3) with its id, format and size', () => {
    const body = Buffer.alloc(9 + 3)
    body.writeUInt32BE(77, 0)
    body[4] = 2
    body.writeUInt16BE(1179, 5)
    body.writeUInt16BE(2556, 7)
    body.set([9, 8, 7], 9)
    const [m] = new SimFrameParser().push(msg(3, body))
    expect(m).toMatchObject({ type: 3, imageId: 77, format: 'png', width: 1179, height: 2556 })
    expect([...(m as { data: Buffer }).data]).toEqual([9, 8, 7])
  })
  it('drops a frame with no image bytes, bad JSON and unknown types without losing framing', () => {
    const p = new SimFrameParser()
    const out = p.push(Buffer.concat([msg(1, Buffer.alloc(12)), msg(2, Buffer.from('{nope')), msg(9, Buffer.from('?')), json({ ok: 1 })]))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ json: { ok: 1 } })
  })
  it('throws when the length is zero or absurd — the stream has lost framing', () => {
    expect(() => new SimFrameParser().push(Buffer.from([0, 0, 0, 0, 1]))).toThrow(SimFrameError)
    const huge = Buffer.alloc(5)
    huge.writeUInt32BE(SIM_MAX_MESSAGE_BYTES + 1, 0)
    expect(() => new SimFrameParser().push(huge)).toThrow(SimFrameError)
  })
  it('hands out a copy of the frame, not a view into the shared read buffer', () => {
    const buf = Buffer.concat([msg(1, videoPayload(1, 1, 4))])
    const [m] = new SimFrameParser().push(buf)
    buf.fill(0)
    expect((m as { payload: Buffer }).payload[12]).toBe(7)
  })
})
