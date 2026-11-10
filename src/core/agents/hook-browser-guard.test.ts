// The hook server's browser guard, as a pure decision. The real-transport proof that every client
// we ship still passes it lives in hook-server.browser-guard.test.ts.
import { describe, it, expect } from 'vitest'
import { browserRequestRefusal, isLoopbackHostHeader } from './hook-browser-guard'

describe('isLoopbackHostHeader', () => {
  it('accepts every Host our clients send (measured: curl, node http, node fetch, Bun fetch)', () => {
    for (const host of [
      '127.0.0.1:41253', // curl / node http / fetch to the TCP listener
      '127.0.0.1:52011', // the SSH loopback-TCP fallback: the HOST's port, not ours
      'localhost', // curl --unix-socket http://localhost/…, node http.request({socketPath})
      'localhost:0', // the codex launcher: http://localhost:${NODETERM_HOOK_PORT-0} over the socket
      'localhost:34357', // curl / fetch to http://localhost:<port>
      'LOCALHOST:80',
      '127.0.0.1',
      '[::1]',
      '[::1]:8080'
    ]) {
      expect(isLoopbackHostHeader(host), host).toBe(true)
    }
  })

  it('refuses every name a page could have the browser send (DNS rebinding) or a near miss', () => {
    for (const host of [
      'evil.example',
      'evil.example:41253',
      '127.0.0.1.evil.example',
      '127.0.0.1.evil.example:41253',
      'localhost.evil.example',
      'localhost.',
      'evil-localhost',
      'localhost:abc',
      'localhost:',
      'localhost:123456',
      '127.0.0.1:41253 ',
      ' 127.0.0.1',
      '127.0.0.2',
      '0.0.0.0:41253',
      '[::1]x',
      '[::2]:80',
      '::1',
      '',
      'localhost\r\nX: y'
    ]) {
      expect(isLoopbackHostHeader(host), JSON.stringify(host)).toBe(false)
    }
  })
})

describe('browserRequestRefusal', () => {
  it('passes the header sets our clients send', () => {
    expect(browserRequestRefusal({ host: '127.0.0.1:41253' })).toBeNull()
    expect(browserRequestRefusal({ host: 'localhost' })).toBeNull()
    // Node's own fetch (undici) sends sec-fetch-mode, never an Origin: it must keep passing.
    expect(browserRequestRefusal({ host: '127.0.0.1:1', 'sec-fetch-mode': 'cors' })).toBeNull()
  })

  it('a request with no Host header at all is not refused (no browser can send one)', () => {
    expect(browserRequestRefusal({})).toBeNull()
  })

  it('refuses ANY Origin header, whatever its value, before the Host is even looked at', () => {
    for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1:41253', 'http://localhost', '']) {
      expect(browserRequestRefusal({ host: '127.0.0.1:41253', origin }), origin).toMatch(/origin/i)
    }
    // Node joins a repeated Origin header with ', ' — still an Origin.
    expect(browserRequestRefusal({ host: '127.0.0.1:41253', origin: 'https://a.example, https://b.example' })).toMatch(/origin/i)
  })

  it('refuses a non-loopback Host', () => {
    expect(browserRequestRefusal({ host: 'evil.example:41253' })).toMatch(/host/i)
  })
})
