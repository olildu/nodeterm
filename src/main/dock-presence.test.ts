import { describe, expect, it, vi } from 'vitest'
import { ensureRegularDockPresence, type DockPresenceApp } from './dock-presence'

function fakeApp(visible: boolean | 'throws' | 'no-dock'): DockPresenceApp & {
  setActivationPolicy: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
} {
  const setActivationPolicy = vi.fn()
  const show = vi.fn(() => Promise.resolve())
  const dock =
    visible === 'no-dock'
      ? undefined
      : {
          isVisible: () => {
            if (visible === 'throws') throw new Error('boom')
            return visible
          },
          show
        }
  return { setActivationPolicy, dock, show }
}

describe('ensureRegularDockPresence', () => {
  it('leaves an app that is already in the Dock alone (issue #1305: show() duplicates the tile)', () => {
    const app = fakeApp(true)
    expect(ensureRegularDockPresence(app, 'darwin')).toBe(false)
    expect(app.setActivationPolicy).not.toHaveBeenCalled()
    expect(app.show).not.toHaveBeenCalled()
  })

  it('restores the Dock presence when macOS dropped it', () => {
    const app = fakeApp(false)
    expect(ensureRegularDockPresence(app, 'darwin')).toBe(true)
    expect(app.setActivationPolicy).toHaveBeenCalledWith('regular')
    expect(app.show).toHaveBeenCalledTimes(1)
  })

  it('restores it when the visibility read fails (a failed read is not evidence of a tile)', () => {
    const app = fakeApp('throws')
    expect(ensureRegularDockPresence(app, 'darwin')).toBe(true)
    expect(app.show).toHaveBeenCalledTimes(1)
  })

  it('still asserts the policy when there is no dock API', () => {
    const app = fakeApp('no-dock')
    expect(ensureRegularDockPresence(app, 'darwin')).toBe(true)
    expect(app.setActivationPolicy).toHaveBeenCalledWith('regular')
  })

  it('does nothing off macOS', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const app = fakeApp(false)
      expect(ensureRegularDockPresence(app, platform)).toBe(false)
      expect(app.setActivationPolicy).not.toHaveBeenCalled()
      expect(app.show).not.toHaveBeenCalled()
    }
  })

  it('swallows a rejected show()', async () => {
    const app = fakeApp(false)
    app.show.mockImplementation(() => Promise.reject(new Error('no')))
    expect(ensureRegularDockPresence(app, 'darwin')).toBe(true)
    await Promise.resolve()
  })
})
