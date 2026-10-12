/**
 * Frame intake for the simulator node: decode the NEWEST frame, never a backlog.
 *
 * Core pushes JPEGs and lets at most two be unacknowledged; this is the other half of that
 * contract. While a decode is running, an arriving frame replaces whatever was waiting (the older
 * one is stale by definition — it is the same screen, earlier), and the ack goes back only after
 * the frame is on the canvas, which is what lets core send the next one. A frame that is replaced
 * before it is drawn is acknowledged at once. Injected `decode` /
 * `draw` / `ack` keep it testable without a browser.
 */
export interface FramePumpDeps<Decoded> {
  decode(jpeg: Uint8Array): Promise<Decoded | null>
  draw(frame: Decoded, width: number, height: number): void
  ack(): void
  /** Releases a decoded bitmap that was superseded or drawn. */
  release?(frame: Decoded): void
}

export interface PumpFrame {
  jpeg: Uint8Array
  width: number
  height: number
}

export function createFramePump<Decoded>(deps: FramePumpDeps<Decoded>) {
  let busy = false
  let waiting: PumpFrame | null = null
  let disposed = false
  const drawn = { count: 0, dropped: 0 }

  async function run(frame: PumpFrame): Promise<void> {
    busy = true
    let next: PumpFrame | null = frame
    while (next && !disposed) {
      const current: PumpFrame = next
      next = null
      let decoded: Decoded | null = null
      try {
        decoded = await deps.decode(current.jpeg)
      } catch {
        decoded = null
      }
      if (decoded && !disposed) {
        deps.draw(decoded, current.width, current.height)
        drawn.count++
      }
      if (decoded) deps.release?.(decoded)
      // Acknowledged either way: a frame that failed to decode must not starve the stream of credit.
      if (!disposed) deps.ack()
      next = waiting
      waiting = null
    }
    busy = false
  }

  return {
    push(frame: PumpFrame): void {
      if (disposed) return
      if (busy) {
        // The frame it replaces will never be drawn, but core is still owed its ack or its credit
        // would leak one frame at a time until the stream stalled.
        if (waiting) {
          drawn.dropped++
          deps.ack()
        }
        waiting = frame
        return
      }
      void run(frame)
    },
    dispose(): void {
      disposed = true
      waiting = null
    },
    stats: (): { count: number; dropped: number } => ({ ...drawn })
  }
}
