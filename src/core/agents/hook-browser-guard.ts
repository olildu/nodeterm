// The hook server's browser guard: belt-and-braces in front of the bearer.
//
// The hook server listens on 127.0.0.1 and on a 0600 unix socket, and every route sits behind the
// `x-nodeterm-hook-token` bearer. That bearer is the real gate and stays the real gate. What this
// adds is a second, independent refusal for the one caller class that can reach a loopback port
// without being a process of ours: a web page in the user's browser.
//
//  - A cross-origin page cannot read our replies, and a custom header forces a preflight we never
//    answer — but a page that has DNS-rebound its own name to 127.0.0.1 is same-origin with us, and
//    then only the unguessable bearer (and the ephemeral port) stood in its way.
//  - Every browser sends `Origin` on a POST (fetch, XHR, form, sendBeacon), and sends the PAGE's
//    host name in `Host`. None of our clients send `Origin`, and all of them send a loopback name.
//
// MEASURED (2026-10-23), every client that posts to this server, both transports:
//   curl --unix-socket … http://localhost/…        Host: localhost        (managed hook scripts,
//                                                                          nodeterm.sh, context.sh,
//                                                                          the failover probe, the
//                                                                          remote tunnel probe)
//   curl --unix-socket … http://localhost:0/…      Host: localhost:0      (codex launcher)
//   curl http://127.0.0.1:<port>/…                 Host: 127.0.0.1:<port> (TCP, and the SSH
//                                                                          loopback-TCP fallback,
//                                                                          whose port is the HOST's)
//   node http.request({socketPath})                Host: localhost        (codex relay daemon,
//                                                                          endpoint owner probe)
//   node http.request({hostname:'127.0.0.1',port}) Host: 127.0.0.1:<port>
//   node fetch (undici)                            Host: 127.0.0.1:<port>, sec-fetch-mode: cors,
//                                                  no Origin                (tests)
//   Bun 1.3.14 fetch (opencode's runtime), unix and TCP: Host localhost / 127.0.0.1:<port>, no Origin
// No client sends Origin. The SSH reverse tunnel forwards bytes, so a host-side curl's Host header
// arrives here unchanged.
//
// A request with NO Host header is not refused: Node already answers 400 to an HTTP/1.1 request
// without one (`requireHostHeader`), so only an HTTP/1.0 client can get here without it, and no
// browser sends a request without a Host.

import type { IncomingHttpHeaders } from 'http'

/** The Host names we answer to. A port, when present, may be any port: the SSH loopback-TCP
 *  fallback arrives with the HOST's listener port, and the codex launcher's socket URL uses 0. */
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i

export function isLoopbackHostHeader(host: string): boolean {
  return LOOPBACK_HOST.test(host)
}

/** Why this request is refused before the bearer is looked at, or null to let it through. */
export function browserRequestRefusal(headers: IncomingHttpHeaders): string | null {
  if (headers.origin !== undefined) {
    return 'hook-endpoint-refused: requests carrying an Origin header (a browser) are not accepted.'
  }
  const host = headers.host
  if (host !== undefined && !isLoopbackHostHeader(host)) {
    return 'hook-endpoint-refused: the Host header is not a loopback name.'
  }
  return null
}
