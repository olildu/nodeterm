import { describe, it, expect } from 'vitest'
import {
  parseTrustedNets,
  isTrustedAddress,
  proxyAuthAllowed,
  describeTrustedNets,
  DEFAULT_TRUSTED_NETS_SPEC,
  PROXY_SECRET_HEADER,
  netsCoverLoopback,
  proxyAuthDecision,
  type TrustProxyConfig
} from './proxy-trust'

describe('parseTrustedNets', () => {
  it('parses IPv4 addresses and CIDRs', () => {
    const nets = parseTrustedNets('127.0.0.1, 10.0.0.0/8')
    expect(nets).toHaveLength(2)
    expect(isTrustedAddress('127.0.0.1', nets)).toBe(true)
    expect(isTrustedAddress('10.20.30.40', nets)).toBe(true)
    expect(isTrustedAddress('11.0.0.1', nets)).toBe(false)
  })

  it('parses IPv6 addresses and CIDRs', () => {
    const nets = parseTrustedNets('::1, fd00::/8')
    expect(isTrustedAddress('::1', nets)).toBe(true)
    expect(isTrustedAddress('fd12:3456::1', nets)).toBe(true)
    expect(isTrustedAddress('fe80::1', nets)).toBe(false)
  })

  it('throws on an unparseable entry (fail closed at boot)', () => {
    expect(() => parseTrustedNets('10.0.0.0/8, not-an-ip')).toThrow(/not-an-ip/)
    expect(() => parseTrustedNets('10.0.0.0/33')).toThrow(/10\.0\.0\.0\/33/)
    expect(() => parseTrustedNets('::1/129')).toThrow(/::1\/129/)
    expect(() => parseTrustedNets('')).toThrow(/empty/i)
    expect(() => parseTrustedNets(' , ')).toThrow(/empty/i)
  })

  it('default spec covers loopback only', () => {
    const nets = parseTrustedNets(DEFAULT_TRUSTED_NETS_SPEC)
    expect(isTrustedAddress('127.0.0.1', nets)).toBe(true)
    expect(isTrustedAddress('127.255.255.254', nets)).toBe(true)
    expect(isTrustedAddress('::1', nets)).toBe(true)
    expect(isTrustedAddress('10.0.0.1', nets)).toBe(false)
    expect(isTrustedAddress('fd00::1', nets)).toBe(false)
  })
})

describe('isTrustedAddress', () => {
  it('normalizes IPv4-mapped IPv6 peers (::ffff:a.b.c.d) against IPv4 nets', () => {
    const nets = parseTrustedNets('127.0.0.0/8')
    expect(isTrustedAddress('::ffff:127.0.0.1', nets)).toBe(true)
    expect(isTrustedAddress('::ffff:10.0.0.1', nets)).toBe(false)
  })

  it('respects non-octet-aligned prefixes', () => {
    const nets = parseTrustedNets('192.168.4.0/22')
    expect(isTrustedAddress('192.168.7.255', nets)).toBe(true)
    expect(isTrustedAddress('192.168.8.0', nets)).toBe(false)
  })

  it('rejects garbage or missing peer addresses', () => {
    const nets = parseTrustedNets('127.0.0.0/8')
    expect(isTrustedAddress(undefined, nets)).toBe(false)
    expect(isTrustedAddress('', nets)).toBe(false)
    expect(isTrustedAddress('bogus', nets)).toBe(false)
  })

  it('an IPv4 peer never matches an IPv6 net and vice versa', () => {
    expect(isTrustedAddress('127.0.0.1', parseTrustedNets('::1'))).toBe(false)
    expect(isTrustedAddress('::1', parseTrustedNets('127.0.0.0/8'))).toBe(false)
  })
})

describe('proxyAuthAllowed', () => {
  // Loopback nets carry a secret (a loopback config without one is refused at boot AND here —
  // see the S2 block below), so the plain trusted-peer cases run with the secret header present.
  const SECRET = 's'.repeat(40)
  const trust: TrustProxyConfig = {
    header: 'Cf-Access-Authenticated-User-Email',
    nets: parseTrustedNets('127.0.0.0/8'),
    secret: SECRET
  }
  const sec = { [PROXY_SECRET_HEADER]: SECRET }

  it('allows a trusted peer carrying a non-empty header (case-insensitive name)', () => {
    expect(
      proxyAuthAllowed(trust, { ...sec, 'cf-access-authenticated-user-email': 'dev@corp.com' }, '127.0.0.1')
    ).toBe(true)
  })

  it('rejects when the header is missing or empty', () => {
    expect(proxyAuthAllowed(trust, { ...sec }, '127.0.0.1')).toBe(false)
    expect(
      proxyAuthAllowed(trust, { ...sec, 'cf-access-authenticated-user-email': '' }, '127.0.0.1')
    ).toBe(false)
    expect(
      proxyAuthAllowed(trust, { ...sec, 'cf-access-authenticated-user-email': '   ' }, '127.0.0.1')
    ).toBe(false)
  })

  it('rejects a peer outside the trusted nets even with the header', () => {
    expect(
      proxyAuthAllowed(trust, { ...sec, 'cf-access-authenticated-user-email': 'dev@corp.com' }, '10.0.0.5')
    ).toBe(false)
  })

  it('rejects a repeated header (array value) — ambiguous, so fail closed', () => {
    expect(
      proxyAuthAllowed(
        trust,
        { ...sec, 'cf-access-authenticated-user-email': ['a@x.com', 'b@x.com'] as unknown as string },
        '127.0.0.1'
      )
    ).toBe(false)
  })
})

describe('describeTrustedNets', () => {
  it('round-trips both families readably', () => {
    expect(describeTrustedNets(parseTrustedNets('127.0.0.0/8, 10.1.2.3'))).toBe(
      '127.0.0.0/8, 10.1.2.3/32'
    )
    expect(describeTrustedNets(parseTrustedNets('::1'))).toBe('0:0:0:0:0:0:0:1/128')
  })
})

// S2 (security audit 2026-10): on loopback every local process — every Unix account, container on
// the host network, sandboxed agent — is "a peer in the trusted nets", so the identity header alone
// made any of them the server's owner. A shared secret the proxy adds is what tells them apart.
describe('proxy secret (S2)', () => {
  const HDR = 'X-Forwarded-User'
  const SECRET = 'a1b2c3d4'.repeat(5)

  it('netsCoverLoopback: true for any net that holds a loopback address, IPv4 or IPv6', () => {
    expect(netsCoverLoopback(parseTrustedNets(DEFAULT_TRUSTED_NETS_SPEC))).toBe(true)
    expect(netsCoverLoopback(parseTrustedNets('127.0.0.1'))).toBe(true)
    expect(netsCoverLoopback(parseTrustedNets('127.9.0.0/16'))).toBe(true)
    expect(netsCoverLoopback(parseTrustedNets('::1'))).toBe(true)
    // Wider nets that CONTAIN loopback count too — 0.0.0.0/0 trusts every local process as well.
    expect(netsCoverLoopback(parseTrustedNets('0.0.0.0/0'))).toBe(true)
    expect(netsCoverLoopback(parseTrustedNets('96.0.0.0/3'))).toBe(true)
    expect(netsCoverLoopback(parseTrustedNets('::/0'))).toBe(true)
    expect(netsCoverLoopback(parseTrustedNets('10.0.0.0/8, 192.168.0.0/16'))).toBe(false)
    expect(netsCoverLoopback(parseTrustedNets('128.0.0.0/1'))).toBe(false)
    expect(netsCoverLoopback(parseTrustedNets('fd00::/8, ::2'))).toBe(false)
  })

  it('with a secret: the header counts only when X-Nodeterm-Proxy-Secret matches exactly', () => {
    const trust: TrustProxyConfig = { header: HDR, nets: parseTrustedNets('10.0.0.0/8'), secret: SECRET }
    const id = { 'x-forwarded-user': 'dev' }
    expect(proxyAuthDecision(trust, { ...id, [PROXY_SECRET_HEADER]: SECRET }, '10.1.2.3')).toBe('trusted')
    expect(proxyAuthDecision(trust, { ...id }, '10.1.2.3')).toBe('bad-secret')
    expect(proxyAuthDecision(trust, { ...id, [PROXY_SECRET_HEADER]: SECRET + 'x' }, '10.1.2.3')).toBe('bad-secret')
    expect(proxyAuthDecision(trust, { ...id, [PROXY_SECRET_HEADER]: SECRET.slice(1) }, '10.1.2.3')).toBe('bad-secret')
    expect(proxyAuthDecision(trust, { ...id, [PROXY_SECRET_HEADER]: '' }, '10.1.2.3')).toBe('bad-secret')
    // A repeated header is ambiguous: refused, like a repeated identity header.
    expect(
      proxyAuthDecision(trust, { ...id, [PROXY_SECRET_HEADER]: [SECRET, SECRET] as unknown as string }, '10.1.2.3')
    ).toBe('bad-secret')
    // The secret alone, with no identity, is not an identity.
    expect(proxyAuthDecision(trust, { [PROXY_SECRET_HEADER]: SECRET }, '10.1.2.3')).toBe('none')
    // Outside the nets the secret means nothing either.
    expect(proxyAuthDecision(trust, { ...id, [PROXY_SECRET_HEADER]: SECRET }, '11.0.0.1')).toBe('none')
    expect(proxyAuthAllowed(trust, { ...id, [PROXY_SECRET_HEADER]: SECRET }, '10.1.2.3')).toBe(true)
    expect(proxyAuthAllowed(trust, { ...id }, '10.1.2.3')).toBe(false)
  })

  it('without a secret: a LOOPBACK peer is never header-trusted, whatever the nets say', () => {
    // resolveConfig already turns header trust off for loopback nets with no secret; this is the
    // same rule at the decision point, so a config built any other way cannot reopen the hole.
    const wide: TrustProxyConfig = { header: HDR, nets: parseTrustedNets('0.0.0.0/0, ::/0') }
    const id = { 'x-forwarded-user': 'dev' }
    expect(proxyAuthDecision(wide, id, '127.0.0.1')).toBe('loopback-needs-secret')
    expect(proxyAuthDecision(wide, id, '::ffff:127.0.0.1')).toBe('loopback-needs-secret')
    expect(proxyAuthDecision(wide, id, '::1')).toBe('loopback-needs-secret')
    expect(proxyAuthAllowed(wide, id, '127.0.0.1')).toBe(false)
    // A non-loopback peer in the nets keeps today's behaviour (header alone) — the boot warns.
    expect(proxyAuthDecision(wide, id, '10.0.0.7')).toBe('trusted')
  })
})
