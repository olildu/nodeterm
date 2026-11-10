import { describe, it, expect } from 'vitest'
import { authBootMessages } from './auth-boot-messages'
import { resolveConfig } from './config'
import { parseTrustedNets } from './proxy-trust'

describe('authBootMessages', () => {
  it('says nothing for a plain password deployment', () => {
    expect(authBootMessages(resolveConfig({}, []))).toEqual({ errors: [], notices: [] })
    expect(authBootMessages(resolveConfig({ NODETERM_SERVER_PASSWORD: 'long-enough' }, []))).toEqual({
      errors: [],
      notices: []
    })
  })

  it('S2: refused header trust is an ERROR line naming the env var, the header and the proxy setting', () => {
    const m = authBootMessages(resolveConfig({ NODETERM_TRUST_PROXY_HEADER: 'X-Forwarded-User' }, []))
    expect(m.errors).toHaveLength(1)
    expect(m.errors[0]).toMatch(/Proxy header trust is OFF/)
    expect(m.errors[0]).toMatch(/NODETERM_TRUST_PROXY_SECRET=<secret>/)
    expect(m.errors[0]).toMatch(/X-Nodeterm-Proxy-Secret: <secret>/)
    expect(m.errors[0]).toMatch(/openssl rand -hex 32/)
    expect(m.notices).toEqual([])
  })

  it('header trust with a secret is announced; without one (non-loopback nets) it warns about every host on the nets', () => {
    const secret = 'z'.repeat(40)
    const withSecret = authBootMessages({
      trustProxy: { header: 'X-U', nets: parseTrustedNets('127.0.0.1'), secret }
    })
    expect(withSecret.notices[0]).toMatch(/ENABLED/)
    expect(withSecret.notices[0]).not.toContain(secret)
    const bare = authBootMessages({ trustProxy: { header: 'X-U', nets: parseTrustedNets('10.0.0.0/8') } })
    expect(bare.notices[0]).toMatch(/without a secret/)
    expect(bare.notices[0]).toMatch(/NODETERM_TRUST_PROXY_SECRET/)
  })

  it('S8: a seeded password under 8 characters is an error line, never a refusal, never echoed', () => {
    const config = resolveConfig({ NODETERM_SERVER_PASSWORD: 'hunter2' }, [])
    expect(config.passwordSeed).toBe('hunter2') // still used
    const m = authBootMessages(config)
    expect(m.errors).toHaveLength(1)
    expect(m.errors[0]).toMatch(/shorter than 8/)
    expect(m.errors[0]).not.toContain('hunter2')
  })
})
