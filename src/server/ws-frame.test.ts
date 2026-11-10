import { describe, expect, it } from 'vitest'
import { WS_CLIENT_FRAME_MAX, fitsOneWsFrame } from '../shared/ws-frame'
import { WS_MAX_PAYLOAD } from './ws'

describe('fitsOneWsFrame', () => {
  it('is the same limit the server enforces', () => {
    expect(WS_CLIENT_FRAME_MAX).toBe(WS_MAX_PAYLOAD)
  })

  it('accepts a normal board and refuses one that would get the socket closed', () => {
    expect(fitsOneWsFrame(['p1', 'whiteboard-1', '{"elements":[]}'])).toBe(true)
    expect(fitsOneWsFrame(['p1', 'whiteboard-1', 'x'.repeat(WS_CLIENT_FRAME_MAX)])).toBe(false)
  })

  it('measures UTF-8 bytes, not string length (a 3-byte character counts as 3)', () => {
    const chars = Math.floor(WS_CLIENT_FRAME_MAX / 3)
    expect(fitsOneWsFrame(['€'.repeat(chars)])).toBe(false)
  })
})
