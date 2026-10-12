/**
 * Frame pacing for the stream's encode loop.
 *
 * The spacing is measured from when the PREVIOUS encode STARTED, not from when its frame was sent:
 * measuring from the send made every cycle `interval + encode time` (about 21-25 ms at a 60 fps cap,
 * i.e. a 40-47 fps ceiling with a 60 Hz source) because the wait and the encode ran back to back.
 * The interval also gets a little slack, since a 60 Hz source jitters by a millisecond or two and a
 * strict 16.7 ms spacing would drop every other frame that arrives a hair early.
 */
export const PACING_SLACK_MS = 1.5

/** Milliseconds to wait before the next encode may start (0 = go now). */
export function encodeWait(lastStartAt: number, now: number, maxFps: number): number {
  if (!(maxFps > 0)) return 0
  const interval = Math.max(0, 1000 / maxFps - PACING_SLACK_MS)
  return Math.max(0, lastStartAt + interval - now)
}
