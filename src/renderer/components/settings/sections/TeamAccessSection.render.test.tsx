// @vitest-environment jsdom
//
// Settings → Team seats rendered "This section could not be displayed" with React error #185
// (maximum update depth) from zustand 5 on: a selector that derives a NEW array on every call
// never settles under v5's Object.is snapshot check. Rendering the section is the whole test —
// the loop throws during the first commit, for a premium user and a free one alike.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  vi.resetModules()
  // The entitlement store subscribes to license changes the moment it is created.
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    license: { onChange: () => () => {} }
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function renderSection(premium: boolean): Promise<string> {
  const { useEntitlement } = await import('../../../state/entitlement')
  const { useTeamAccess } = await import('../../../state/teamAccess')
  useEntitlement.setState({ isPremium: premium, seats: premium ? 3 : 0 })
  useTeamAccess.getState().addPending('seat-1', 'mate@example.com')
  const { TeamAccessSection } = await import('./TeamAccessSection')
  act(() => root.render(<TeamAccessSection isActive />))
  return host.textContent ?? ''
}

describe('Team seats section', () => {
  it('renders for a Pro user, listing the seat table', async () => {
    const text = await renderSection(true)
    expect(text).toContain('Connected devices')
    expect(text).toContain('mate@example.com')
  })

  it('renders the upgrade pitch for a free user', async () => {
    expect(await renderSection(false)).toContain('Upgrade to Pro')
  })
})
