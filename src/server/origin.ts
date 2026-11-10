// Same-origin checks for the Server Edition's state-changing entry points: the auth POSTs
// (/auth/login, /auth/logout, /auth/logout-all, /auth/setup) and the WebSocket upgrade.
//
// One rule for both, so they cannot drift (security audit 2026-10, S4):
//  - An `Origin` header, when present, must name this server: its host equals the request's `Host`
//    (what the WebSocket check has always required — so any deployment whose app works passes it),
//    or it equals NODETERM_PUBLIC_ORIGIN when that is set (a proxy that rewrites `Host`).
//    `Origin: null` (sandboxed frames, opaque redirects) and a malformed value are refused.
//  - No `Origin`: browsers always send one on a POST and on a WebSocket handshake, so its absence
//    means a non-browser client (curl, a script, the tests), which a cross-site page cannot be.
//    The one exception is a browser that says so itself: `Sec-Fetch-Site: cross-site` or
//    `same-site` is refused. Absent fetch metadata is allowed — older browsers do not send it.
import type http from 'http'

export function sameOriginRequest(headers: http.IncomingHttpHeaders, publicOrigin?: string): boolean {
  const origin = headers['origin']
  if (typeof origin === 'string' && origin.length > 0) {
    if (origin === 'null') return false
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      return false
    }
    if (publicOrigin !== undefined && url.origin === publicOrigin) return true
    return url.host === headers['host']
  }
  const site = headers['sec-fetch-site']
  return !(site === 'cross-site' || site === 'same-site')
}
