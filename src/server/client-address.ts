// Which CLIENT a login attempt is charged to (security audit 2026-10, S4).
//
// The login lockout used to be one global counter, so a stranger's five wrong passwords locked the
// owner out too. It is per client now (auth.ts), and a client is an address — which, behind the
// reverse proxy the Server Edition is documented to run behind, is NOT the TCP peer: every request
// arrives from the proxy, and keying on the peer would make the per-client lock global again.
//
// The rule, kept deliberately small:
//  - When the TCP peer is a FORWARDER — loopback, a private / CGNAT / link-local / ULA address (a
//    same-host nginx, a Docker network's Traefik, a Tailscale proxy), or inside the header-trust
//    nets — the client is the LAST `X-Forwarded-For` entry: the one that forwarder appended. Only
//    that one: every entry to its left was written by whoever sent the request to the proxy, i.e.
//    possibly the attacker.
//  - Any other peer is the client itself, and `X-Forwarded-For` is ignored.
//  - IPv6 clients are keyed by their /64 (one subscriber's allocation), IPv4 by the address.
//
// What it costs, stated: a process that can reach the server FROM a forwarder address (a local
// user, a container on the same network) can choose the bucket it is charged to — evading its own
// per-client lock (the global ceiling still applies) or locking a chosen address's bucket. A chain
// of two proxies (a CDN in front of the local proxy) buckets clients by the CDN's edge address.
// Neither reopens S1: the budget per bucket and the global ceiling still hold.
import { isTrustedAddress, parsePeerAddress, parseTrustedNets, type TrustProxyConfig } from './proxy-trust'

const FORWARDER_NETS = parseTrustedNets(
  '127.0.0.0/8, ::1/128, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16, fc00::/7, fe80::/10'
)

function keyOf(bytes: Uint8Array): string {
  if (bytes.length === 4) return `v4:${Array.from(bytes).join('.')}`
  let hex = ''
  for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return `v6:${hex}/64`
}

/** One `X-Forwarded-For` entry → an address, tolerating a port (`1.2.3.4:5678`, `[::1]:80`). */
function entryAddress(entry: string): Uint8Array | null {
  const e = entry.trim()
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(e)
  if (bracketed) return parsePeerAddress(bracketed[1])
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(e)
  if (v4WithPort) return parsePeerAddress(v4WithPort[1])
  return parsePeerAddress(e)
}

/**
 * The rate-limit key of the client behind this request (see the header). `peer` is the TCP peer
 * address, `forwardedFor` the raw `X-Forwarded-For` header.
 */
export function loginClientKey(
  peer: string | undefined,
  forwardedFor: string | string[] | undefined,
  trust?: TrustProxyConfig
): string {
  const peerBytes = parsePeerAddress(peer)
  if (!peerBytes) return 'unknown'
  const forwarder =
    isTrustedAddress(peer, FORWARDER_NETS) || (trust !== undefined && isTrustedAddress(peer, trust.nets))
  if (forwarder && typeof forwardedFor === 'string' && forwardedFor.trim() !== '') {
    const entries = forwardedFor.split(',')
    const last = entryAddress(entries[entries.length - 1])
    if (last) return keyOf(last)
  }
  return keyOf(peerBytes)
}
