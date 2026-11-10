/**
 * The largest client→server frame the Server Edition accepts (8 MiB) — see `WS_MAX_PAYLOAD` in
 * src/server/ws.ts for why. Shared so the browser can refuse a payload BEFORE sending it: `ws`
 * closes the whole connection (code 1009) on an oversized frame, not just the one message.
 */
export const WS_CLIENT_FRAME_MAX = 8 * 1024 * 1024

/** Room for the RPC envelope around the args (`{"t":"req","id":…,"method":…}`). */
const ENVELOPE_HEADROOM = 4 * 1024

/** Whether an RPC request carrying `args` fits in one Server Edition frame, measured as UTF-8. */
export function fitsOneWsFrame(args: readonly unknown[]): boolean {
  return new TextEncoder().encode(JSON.stringify(args)).length + ENVELOPE_HEADROOM <= WS_CLIENT_FRAME_MAX
}
