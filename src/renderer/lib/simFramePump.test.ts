import { describe, expect, it } from 'vitest'
import { createFramePump, type PumpFrame } from './simFramePump'

const frame = (tag: number): PumpFrame => ({ jpeg: new Uint8Array([tag]), width: 4, height: 8 })

/** A decoder the test releases by hand, so frames can be made to arrive "while decoding". */
function rig() {
  const gates: Array<() => void> = []
  const drawn: number[] = []
  const released: number[] = []
  let acks = 0
  const pump = createFramePump<number>({
    decode: (jpeg) => new Promise((resolve) => gates.push(() => resolve(jpeg[0]))),
    draw: (tag) => void drawn.push(tag),
    release: (tag) => void released.push(tag),
    ack: () => void acks++
  })
  const flush = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
  }
  return { pump, gates, drawn, released, acks: () => acks, flush }
}

describe('createFramePump', () => {
  it('draws a frame and acknowledges it after it is on the canvas', async () => {
    const r = rig()
    r.pump.push(frame(1))
    expect(r.acks()).toBe(0)
    r.gates.shift()!()
    await r.flush()
    expect(r.drawn).toEqual([1])
    expect(r.released).toEqual([1])
    expect(r.acks()).toBe(1)
  })
  it('keeps only the newest of the frames that arrive during a decode — and acks the ones it drops', async () => {
    const r = rig()
    r.pump.push(frame(1))
    r.pump.push(frame(2))
    r.pump.push(frame(3)) // replaces 2: 2 is never drawn, but core is still owed its ack
    r.pump.push(frame(4)) // replaces 3
    expect(r.acks()).toBe(2)
    r.gates.shift()!()
    await r.flush()
    r.gates.shift()!()
    await r.flush()
    expect(r.drawn).toEqual([1, 4])
    expect(r.acks()).toBe(4) // one per frame received, none leaked
    expect(r.pump.stats()).toEqual({ count: 2, dropped: 2 })
  })
  it('acknowledges a frame that fails to decode, so a bad JPEG cannot starve the stream of credit', async () => {
    let acks = 0
    const pump = createFramePump<number>({
      decode: () => Promise.reject(new Error('bad jpeg')),
      draw: () => {
        throw new Error('must not draw')
      },
      ack: () => void acks++
    })
    pump.push(frame(1))
    await Promise.resolve()
    await Promise.resolve()
    expect(acks).toBe(1)
  })
  it('does nothing after dispose — no draw on a canvas that is gone, no ack for a window that left', async () => {
    const r = rig()
    r.pump.push(frame(1))
    r.pump.dispose()
    r.gates.shift()!()
    await r.flush()
    r.pump.push(frame(2))
    expect(r.drawn).toEqual([])
    expect(r.acks()).toBe(0)
    expect(r.released).toEqual([1]) // the decoded bitmap is still freed
  })
})
