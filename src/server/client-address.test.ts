import { describe, it, expect } from 'vitest'
import { loginClientKey } from './client-address'
import { parseTrustedNets } from './proxy-trust'

describe('loginClientKey (S4: which client a login attempt is charged to)', () => {
  it('a public peer is the client, and its X-Forwarded-For is ignored (a client can write anything there)', () => {
    expect(loginClientKey('203.0.113.9', undefined)).toBe('v4:203.0.113.9')
    expect(loginClientKey('203.0.113.9', '198.51.100.1')).toBe('v4:203.0.113.9')
    expect(loginClientKey('::ffff:203.0.113.9', undefined)).toBe('v4:203.0.113.9')
  })

  it('behind a forwarder (loopback, private, CGNAT, ULA) the client is the LAST X-Forwarded-For entry', () => {
    for (const proxy of ['127.0.0.1', '::1', '10.0.1.7', '172.18.0.2', '192.168.1.1', '100.100.1.1', 'fd7a:115c::1']) {
      expect(loginClientKey(proxy, '198.51.100.1')).toBe('v4:198.51.100.1')
    }
    // Only the entry the proxy appended counts: the left ones came from whoever called the proxy.
    expect(loginClientKey('127.0.0.1', '1.1.1.1, 2.2.2.2, 198.51.100.1')).toBe('v4:198.51.100.1')
    // Ports and brackets, as some proxies write them.
    expect(loginClientKey('127.0.0.1', '198.51.100.1:51234')).toBe('v4:198.51.100.1')
    expect(loginClientKey('127.0.0.1', '[2001:db8:1:2:3:4:5:6]:443')).toBe('v6:20010db800010002/64')
  })

  it('no (or garbage) X-Forwarded-For from a forwarder → the forwarder itself', () => {
    expect(loginClientKey('127.0.0.1', undefined)).toBe('v4:127.0.0.1')
    expect(loginClientKey('127.0.0.1', '  ')).toBe('v4:127.0.0.1')
    expect(loginClientKey('127.0.0.1', 'not-an-ip')).toBe('v4:127.0.0.1')
  })

  it('IPv6 clients are keyed by their /64', () => {
    expect(loginClientKey('2001:db8:1:2::9', undefined)).toBe('v6:20010db800010002/64')
    expect(loginClientKey('2001:db8:1:2:ffff::1', undefined)).toBe('v6:20010db800010002/64')
    expect(loginClientKey('2001:db8:1:3::9', undefined)).not.toBe(loginClientKey('2001:db8:1:2::9', undefined))
  })

  it('a header-trust net counts as a forwarder even when it is public', () => {
    const trust = { header: 'X-U', nets: parseTrustedNets('203.0.113.0/24') }
    expect(loginClientKey('203.0.113.9', '198.51.100.1', trust)).toBe('v4:198.51.100.1')
    expect(loginClientKey('198.51.100.7', '1.2.3.4', trust)).toBe('v4:198.51.100.7')
  })

  it('an unreadable peer shares one bucket rather than escaping the limit', () => {
    expect(loginClientKey(undefined, '198.51.100.1')).toBe('unknown')
    expect(loginClientKey('garbage', undefined)).toBe('unknown')
  })
})
