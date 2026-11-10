// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AnnouncementBanner } from './AnnouncementBanner'
import { useEntitlement } from '../state/entitlement'
import type { Announcement } from '@shared/types'

// The real store subscribes to the license bridge when it is created; the banner only reads the bit.
vi.mock('../state/entitlement', async () => {
  const { create } = await import('zustand')
  return { useEntitlement: create(() => ({ isPremium: false })) }
})

const msg = (id: string): Announcement => ({ id, title: id, level: 'info' })

afterEach(() => {
  useEntitlement.setState({ isPremium: false })
  localStorage.clear()
  vi.unstubAllGlobals()
})

// Main asks the feed with the current plan; the banner has to ask again when the plan changes, or a
// "try Pro" message aimed at free users stays up for six hours after the user has paid.
it('re-asks the feed when the plan changes and drops the message the new plan does not get', async () => {
  const fetch = vi.fn().mockResolvedValueOnce([msg('Try Pro')]).mockResolvedValueOnce([])
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { announcements: { fetch } }
  const el = document.createElement('div')
  const root = createRoot(el)
  try {
    await act(async () => root.render(<AnnouncementBanner />))
    expect(el.textContent).toContain('Try Pro')

    await act(async () => useEntitlement.setState({ isPremium: true }))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(el.textContent).not.toContain('Try Pro')
  } finally {
    await act(async () => root.unmount())
  }
})

it('shows the new plan’s message in place of the old one', async () => {
  const fetch = vi.fn().mockResolvedValueOnce([msg('Try Pro')]).mockResolvedValueOnce([msg('Thanks for paying')])
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { announcements: { fetch } }
  const el = document.createElement('div')
  const root = createRoot(el)
  try {
    await act(async () => root.render(<AnnouncementBanner />))
    await act(async () => useEntitlement.setState({ isPremium: true }))
    expect(el.textContent).toContain('Thanks for paying')
    expect(el.textContent).not.toContain('Try Pro')
  } finally {
    await act(async () => root.unmount())
  }
})
