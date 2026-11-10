// @vitest-environment jsdom
//
// Settings → Sign-in (Server Edition only, security audit 2026-10 S3): "Sign out" ends this
// browser's session on the server; "Sign out everywhere" is confirmed, then ends every session.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDialogStack } from '../../dialog-stack'
import { SignInSection } from './SignInSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const fetchMock = vi.fn(async () => ({ type: 'opaqueredirect', ok: false, status: 0 }) as Response)
const assign = vi.fn()

beforeEach(() => {
  resetDialogStack()
  fetchMock.mockClear()
  assign.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(window, 'location', { value: { assign }, configurable: true, writable: true })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<SignInSection isActive />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const button = (label: string): HTMLButtonElement => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent === label)
  if (!b) throw new Error(`no button "${label}"`)
  return b as HTMLButtonElement
}

describe('SignInSection', () => {
  it('Sign out posts /auth/logout and goes to the sign-in page', async () => {
    await act(async () => button('Sign out').click())
    expect(fetchMock).toHaveBeenCalledWith('/auth/logout', expect.objectContaining({ method: 'POST' }))
    expect(assign).toHaveBeenCalledWith('/login')
  })

  it('Sign out everywhere asks first; cancel sends nothing, confirm posts /auth/logout-all', async () => {
    await act(async () => button('Sign out everywhere').click())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(document.body.textContent).toMatch(/Sign out every browser\?/)
    await act(async () => button('Cancel').click())
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => button('Sign out everywhere').click())
    const confirm = [...document.querySelectorAll('button')].filter((x) => x.textContent === 'Sign out everywhere').pop()!
    await act(async () => confirm.click())
    expect(fetchMock).toHaveBeenCalledWith('/auth/logout-all', expect.objectContaining({ method: 'POST' }))
    expect(assign).toHaveBeenCalledWith('/login')
  })
})
