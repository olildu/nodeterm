// Keeping nodeterm a REGULAR Dock app on macOS without re-registering it with the Dock.
//
// The Notch HUD is a `focusable:false` (non-activating) panel. If such a panel is the only window
// ordered front, macOS can re-evaluate the app as having no regular window and drop its Dock tile
// (the original "Dock icon disappears once the HUD opens" bug), so the app re-asserts its Dock
// presence when the HUD is created and shown and whenever the main window is shown.
//
// That re-assert used to run unconditionally, on the claim that it was idempotent. It is not:
// Electron's `app.dock.show()` calls `TransformProcessType(kProcessTransformToForegroundApplication)`
// every time, and transforming an app that is ALREADY a foreground app can leave the Dock showing
// it twice — the pinned tile without a running dot, plus a second tile in the "recent apps" section
// that is the one actually running (issue #1305). Clicking the pinned tile then asks LaunchServices
// to open the app again, which reads to the user as "it opens a new instance".
//
// So the re-assert now acts only when the app has really lost its Dock presence.
// `app.dock.isVisible()` answers exactly that: Electron reports it from the current
// `NSRunningApplication` activation policy (`== Regular`).

/** The slice of Electron's `app` this needs; structural so the decision tests without Electron. */
export interface DockPresenceApp {
  setActivationPolicy(policy: 'regular'): void
  dock?: {
    isVisible(): boolean
    show(): unknown
  }
}

/** Returns true when it asked macOS to restore the Dock presence, false when it left it alone. */
export function ensureRegularDockPresence(app: DockPresenceApp, platform: NodeJS.Platform): boolean {
  if (platform !== 'darwin') return false
  const dock = app.dock
  // No dock API (older Electron): keep the old behaviour of asserting the policy once.
  let visible = false
  try {
    visible = dock?.isVisible() === true
  } catch {
    // A read that fails is no evidence the tile is there; fall through and restore it.
  }
  if (visible) return false
  try {
    app.setActivationPolicy('regular')
  } catch {
    /* older Electron / transient — ignore */
  }
  // `dock.show()` returns a Promise in recent Electron; swallow it either way.
  try {
    void Promise.resolve(dock?.show()).catch(() => {})
  } catch {
    /* ignore */
  }
  return true
}
