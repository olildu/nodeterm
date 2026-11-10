import { describe, it, expect, vi } from 'vitest'
import { signOutBrowser, SIGN_OUT_PATH } from './browserSignOut'

const res = (init: Partial<Response>): Response => ({ ok: false, status: 0, type: 'basic', ...init }) as Response

describe('signOutBrowser', () => {
  it('posts to the right route, same-origin, without following the redirect, then goes to /login', async () => {
    for (const scope of ['this', 'everywhere'] as const) {
      const fetch = vi.fn(async () => res({ type: 'opaqueredirect' }))
      const assign = vi.fn()
      expect(await signOutBrowser(scope, { fetch: fetch as unknown as typeof globalThis.fetch, assign })).toEqual({ ok: true })
      expect(fetch).toHaveBeenCalledWith(SIGN_OUT_PATH[scope], {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'manual'
      })
      expect(assign).toHaveBeenCalledWith('/login')
    }
    expect(SIGN_OUT_PATH).toEqual({ this: '/auth/logout', everywhere: '/auth/logout-all' })
  })

  it('a session already gone (401) still lands on the sign-in page', async () => {
    const assign = vi.fn()
    const r = await signOutBrowser('everywhere', { fetch: (async () => res({ status: 401 })) as unknown as typeof fetch, assign })
    expect(r).toEqual({ ok: true })
    expect(assign).toHaveBeenCalledWith('/login')
  })

  it('a refusal or a network failure stays on the page and says nothing was signed out', async () => {
    const assign = vi.fn()
    const refused = await signOutBrowser('everywhere', { fetch: (async () => res({ status: 403 })) as unknown as typeof fetch, assign })
    expect(refused).toEqual({ ok: false, error: expect.stringMatching(/HTTP 403.*Nothing was signed out/) })
    const down = await signOutBrowser('this', {
      fetch: (async () => {
        throw new TypeError('network')
      }) as unknown as typeof fetch,
      assign
    })
    expect(down).toEqual({ ok: false, error: expect.stringMatching(/Nothing was signed out/) })
    expect(assign).not.toHaveBeenCalled()
  })
})
