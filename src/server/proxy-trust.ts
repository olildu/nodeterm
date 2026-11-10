// Reverse-proxy SSO header trust (issue #29, Option B).
//
// A deployment that fronts the Server Edition with an SSO reverse proxy (Cloudflare
// Access, Tailscale, oauth2-proxy…) already authenticates every request; the proxy
// asserts the identity in a request header. When configured, a request is treated as
// authenticated iff its TCP peer address is inside the trusted networks AND it carries
// the configured header with a non-empty value AND — when a proxy secret is configured —
// the `X-Nodeterm-Proxy-Secret` header equal to it. The identity header's CONTENT is
// deliberately not validated (no JWT verification).
//
// Why the secret (security audit 2026-10, S2): the trusted-network boundary is a statement
// about WHO can be the TCP peer, and on loopback the answer is "every process on this host" —
// every Unix account, every container on the host network, every sandboxed agent. With the
// default loopback nets the header alone made any of them the server's owner. So a peer on
// loopback is never header-trusted without the secret: `resolveConfig` turns header trust OFF
// for loopback nets with no secret (and says so at boot), and `proxyAuthDecision` refuses a
// loopback peer without one, so a config built any other way cannot reopen it.
//
// Everything here is pure (no node:http import) so it unit-tests without sockets.
import crypto from 'crypto'

export interface TrustedNet {
  /** 4 bytes (IPv4) or 16 bytes (IPv6). */
  bytes: Uint8Array
  prefix: number
}

export interface TrustProxyConfig {
  /** Header name asserting the authenticated identity, e.g. Cf-Access-Authenticated-User-Email. */
  header: string
  nets: TrustedNet[]
  /**
   * The shared secret the proxy sends in {@link PROXY_SECRET_HEADER} on every request (HTTP and the
   * WebSocket upgrade). Set from `NODETERM_TRUST_PROXY_SECRET` only — never a CLI flag, because argv
   * is readable by every local user. Never logged. Required when the nets cover loopback.
   */
  secret?: string
}

/** Default trusted networks: loopback only — the recommended same-host proxy deployment. */
export const DEFAULT_TRUSTED_NETS_SPEC = '127.0.0.0/8, ::1/128'

/** The request header the proxy carries the shared secret in (lower-case: Node's header map). */
export const PROXY_SECRET_HEADER = 'x-nodeterm-proxy-secret'

/** A secret shorter than this is refused at boot: every request is a guess and nothing rate-limits
 *  header trust, so the secret has to be long enough not to be guessable. */
export const MIN_PROXY_SECRET_LENGTH = 32

function parseIPv4(s: string): Uint8Array | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null
    const n = Number(parts[i])
    if (n > 255) return null
    out[i] = n
  }
  return out
}

function parseIPv6(s: string): Uint8Array | null {
  // Handle a trailing IPv4 tail (::ffff:1.2.3.4) by converting it to two hex groups.
  const v4Tail = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (v4Tail) {
    const v4 = parseIPv4(v4Tail[2])
    if (!v4) return null
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    s = v4Tail[1] + hi + ':' + lo
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const groups = (part: string): string[] => (part === '' ? [] : part.split(':'))
  const head = groups(halves[0])
  const tail = halves.length === 2 ? groups(halves[1]) : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(all[i])) return null
    const n = parseInt(all[i], 16)
    out[i * 2] = n >> 8
    out[i * 2 + 1] = n & 0xff
  }
  return out
}

function parseAddress(s: string): Uint8Array | null {
  return s.includes(':') ? parseIPv6(s) : parseIPv4(s)
}

/**
 * Parse a comma-separated list of IPs / CIDRs (IPv4 + IPv6) into trusted nets.
 * Throws on any unparseable entry: a typo in the trust config must fail the boot,
 * not silently narrow (or widen) trust.
 */
export function parseTrustedNets(spec: string): TrustedNet[] {
  const entries = spec
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '')
  if (entries.length === 0) throw new Error('trusted-nets list is empty')
  return entries.map((entry) => {
    const slash = entry.indexOf('/')
    const addrPart = slash === -1 ? entry : entry.slice(0, slash)
    const bytes = parseAddress(addrPart)
    if (!bytes) throw new Error(`unparseable trusted-net entry "${entry}"`)
    const maxPrefix = bytes.length * 8
    let prefix = maxPrefix
    if (slash !== -1) {
      const p = entry.slice(slash + 1)
      if (!/^\d{1,3}$/.test(p) || Number(p) > maxPrefix) {
        throw new Error(`unparseable trusted-net entry "${entry}"`)
      }
      prefix = Number(p)
    }
    return { bytes, prefix }
  })
}

/** Collapse an IPv4-mapped IPv6 address (::ffff:a.b.c.d) to its 4-byte IPv4 form. */
function normalize(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 16) return bytes
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return bytes
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return bytes
  return bytes.slice(12)
}

function matchesNet(addr: Uint8Array, net: TrustedNet): boolean {
  if (addr.length !== net.bytes.length) return false
  const fullBytes = net.prefix >> 3
  for (let i = 0; i < fullBytes; i++) if (addr[i] !== net.bytes[i]) return false
  const rem = net.prefix & 7
  if (rem === 0) return true
  const mask = (0xff << (8 - rem)) & 0xff
  return (addr[fullBytes] & mask) === (net.bytes[fullBytes] & mask)
}

/** Human-readable form of the parsed nets for the boot-time warning log. */
export function describeTrustedNets(nets: TrustedNet[]): string {
  return nets
    .map((net) => {
      if (net.bytes.length === 4) return `${Array.from(net.bytes).join('.')}/${net.prefix}`
      const groups: string[] = []
      for (let i = 0; i < 16; i += 2) {
        groups.push(((net.bytes[i] << 8) | net.bytes[i + 1]).toString(16))
      }
      return `${groups.join(':')}/${net.prefix}`
    })
    .join(', ')
}

const LOOPBACK_V4: TrustedNet = { bytes: new Uint8Array([127, 0, 0, 0]), prefix: 8 }
const LOOPBACK_V6 = (() => {
  const b = new Uint8Array(16)
  b[15] = 1
  return b
})()

/**
 * Does any of these nets hold a loopback address (127.0.0.0/8 or ::1)? A net that merely CONTAINS
 * loopback (0.0.0.0/0, ::/0) counts: it trusts every local process just the same.
 */
export function netsCoverLoopback(nets: TrustedNet[]): boolean {
  return nets.some((net) => {
    if (net.bytes.length === 4) {
      // Two IPv4 prefixes overlap iff they agree on the shorter prefix's bits.
      const shorter = Math.min(net.prefix, LOOPBACK_V4.prefix)
      return matchesNet(LOOPBACK_V4.bytes, { bytes: net.bytes, prefix: shorter })
    }
    return matchesNet(LOOPBACK_V6, net)
  })
}

/** Is this peer address a loopback address (127.0.0.0/8, ::1, or ::ffff:127.x)? */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  const parsed = parseAddress(addr)
  if (!parsed) return false
  const norm = normalize(parsed)
  return norm.length === 4 ? norm[0] === 127 : matchesNet(norm, { bytes: LOOPBACK_V6, prefix: 128 })
}

/** Parse a peer address into bytes, an IPv4-mapped IPv6 address collapsed to IPv4. Null on garbage. */
export function parsePeerAddress(addr: string | undefined): Uint8Array | null {
  if (!addr) return null
  const parsed = parseAddress(addr)
  return parsed ? normalize(parsed) : null
}

/** Constant-time equality of two strings (hash first, so the lengths do not leak either). */
function secretMatches(candidate: string, secret: string): boolean {
  const a = crypto.createHash('sha256').update(candidate, 'utf8').digest()
  const b = crypto.createHash('sha256').update(secret, 'utf8').digest()
  return crypto.timingSafeEqual(a, b)
}

/** Is this socket peer address inside any of the trusted nets? Garbage/missing → false. */
export function isTrustedAddress(addr: string | undefined, nets: TrustedNet[]): boolean {
  if (!addr) return false
  const parsed = parseAddress(addr)
  if (!parsed) return false
  const norm = normalize(parsed)
  return nets.some((net) => matchesNet(norm, net))
}

/**
 * Why a request is or is not header-trusted:
 *  - `trusted`: trusted peer, identity header present, and the secret (when configured) matches;
 *  - `none`: not a header-trust request at all (peer outside the nets, or no identity header);
 *  - `bad-secret`: a trusted peer sent the identity header but not the configured secret — the
 *    case worth a (throttled, value-free) log line, since it usually means the proxy is missing
 *    its `X-Nodeterm-Proxy-Secret` setting;
 *  - `loopback-needs-secret`: a loopback peer, and no secret is configured at all (see the header).
 * Every answer but `trusted` falls through to the normal cookie/login path.
 */
export type ProxyAuthDecision = 'trusted' | 'none' | 'bad-secret' | 'loopback-needs-secret'

/**
 * The one auth decision. `headers` is Node's lowercased header map; a repeated header (array
 * value) is ambiguous and rejected — fail closed.
 */
export function proxyAuthDecision(
  trust: TrustProxyConfig,
  headers: Record<string, string | string[] | undefined>,
  remoteAddress: string | undefined
): ProxyAuthDecision {
  if (!isTrustedAddress(remoteAddress, trust.nets)) return 'none'
  const value = headers[trust.header.toLowerCase()]
  if (typeof value !== 'string' || value.trim() === '') return 'none'
  if (trust.secret === undefined || trust.secret === '') {
    return isLoopbackAddress(remoteAddress) ? 'loopback-needs-secret' : 'trusted'
  }
  const presented = headers[PROXY_SECRET_HEADER]
  if (typeof presented !== 'string' || !secretMatches(presented, trust.secret)) return 'bad-secret'
  return 'trusted'
}

/** {@link proxyAuthDecision} as a yes/no. */
export function proxyAuthAllowed(
  trust: TrustProxyConfig,
  headers: Record<string, string | string[] | undefined>,
  remoteAddress: string | undefined
): boolean {
  return proxyAuthDecision(trust, headers, remoteAddress) === 'trusted'
}

const REFUSED_LOG_EVERY_MS = 60_000
let lastRefusedLog = 0

/**
 * Log — at most once a minute, and never with any header VALUE — that a trusted peer sent the
 * identity header but header trust was refused. Without it an operator whose proxy forgot the
 * secret only sees the login page and no reason.
 */
export function noteProxyRefusal(decision: ProxyAuthDecision, now = Date.now()): void {
  if (decision !== 'bad-secret' && decision !== 'loopback-needs-secret') return
  if (now - lastRefusedLog < REFUSED_LOG_EVERY_MS) return
  lastRefusedLog = now
  console.warn(
    decision === 'bad-secret'
      ? `[nodeterm-server] a request from a trusted proxy address carried the identity header but no matching ${PROXY_SECRET_HEADER} header; it was treated as signed out. Check that your proxy sends the secret on every request, WebSocket upgrades included.`
      : `[nodeterm-server] a loopback request carried the identity header, but header trust from loopback needs NODETERM_TRUST_PROXY_SECRET; it was treated as signed out.`
  )
}

/** Test seam: forget when the refusal line was last logged. */
export function _resetProxyRefusalLogForTest(): void {
  lastRefusedLog = 0
}
