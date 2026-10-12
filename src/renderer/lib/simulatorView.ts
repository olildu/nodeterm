import { bootingTitle, deviceTerm } from './simPlatform'
import {
  simPlatformOf,
  SIM_SCALE_DEFAULT,
  SIM_SCALE_MIN,
  type SimAvailability,
  type SimErrorCode,
  type SimStatus,
  type SimViewLevel
} from '@shared/sim'

/**
 * What the simulator node shows, as a pure function of facts. The component only renders the
 * verdict, so every state in the brief (no device, shut down, helper missing / not macOS / no
 * Xcode, connecting, live, error with Reconnect) is one `switch` here and one test row.
 */

export type SimAction = 'pick' | 'boot' | 'reconnect' | null

export interface SimView {
  kind: 'unavailable' | 'pick' | 'connecting' | 'shutdown' | 'live' | 'error'
  title: string
  detail?: string
  action: SimAction
  /** A non-fatal sentence to show over a live or connecting screen. */
  notice?: string
}

const ERROR_COPY: Record<SimErrorCode, { title: string; detail: string }> = {
  unsupported: {
    title: 'Not available here',
    detail: 'The simulator node runs in the desktop app on macOS, with Xcode installed.'
  },
  'no-helper': {
    title: 'Simulator helper missing',
    detail:
      'This build does not include sim-helper. From a source checkout on macOS run `npm run build:sim-helper`, then restart.'
  },
  'no-xcode': {
    title: 'Xcode not found',
    detail:
      'The Simulator frameworks could not be loaded. Install Xcode (or the command line tools) and select it with `xcode-select`.'
  },
  'already-attached': {
    title: 'Another app is driving this device',
    detail: 'Close the other nodeterm window or tool that controls this simulator, then reconnect.'
  },
  'device-not-found': {
    title: 'Device not found',
    detail: 'This simulator is not available on this computer any more. Pick another device.'
  },
  'no-android-sdk': {
    title: 'Android SDK not found',
    detail:
      'Install Android Studio (or the SDK command-line tools) and create an emulator. nodeterm looks at ANDROID_SDK_ROOT, ANDROID_HOME and the default SDK location.'
  },
  'boot-failed': { title: 'The emulator did not start', detail: 'Boot it again, or start it from Android Studio.' },
  'spawn-failed': { title: 'Could not start the helper', detail: 'The simulator helper would not start.' },
  'helper-exited': { title: 'The simulator helper stopped', detail: 'It ended unexpectedly.' },
  'setup-failed': { title: 'Setting up the simulator', detail: 'The device is not ready yet.' },
  'stream-failed': { title: 'Screen capture hiccup', detail: 'The screen stream reported an error.' }
}

/** Errors where Reconnect cannot help until something outside the app changes. */
const NO_RECONNECT: ReadonlySet<SimErrorCode> = new Set(['unsupported', 'no-helper', 'no-xcode', 'no-android-sdk'])

export function simView(input: {
  availability: SimAvailability | null
  udid: string | undefined
  status: SimStatus | null
}): SimView {
  const { availability, udid, status } = input
  if (availability && !availability.ok) {
    const copy = ERROR_COPY[availability.code]
    return { kind: 'unavailable', title: copy.title, detail: availability.message || copy.detail, action: null }
  }
  if (!udid) {
    return {
      kind: 'pick',
      title: 'Choose a device',
      detail:
        availability?.ok && availability.platforms?.android
          ? availability.platforms.ios
            ? 'Pick an iOS simulator or an Android emulator to show in this node.'
            : 'Pick an Android emulator to show in this node.'
          : 'Pick an iOS simulator to show in this node.',
      action: 'pick'
    }
  }
  if (!status) return { kind: 'connecting', title: 'Connecting…', action: null }
  switch (status.phase) {
    case 'live':
      return {
        kind: 'live',
        title: status.device?.name ?? 'Simulator',
        action: null,
        ...(status.error ? { notice: status.error.message } : {})
      }
    case 'shutdown':
      return {
        kind: 'shutdown',
        title: 'Device shut down',
        // A failed boot (android-helper's boot-failed) says why; Boot is still the way forward.
        detail: status.error?.message ?? `${status.device?.name ?? `This ${deviceTerm(simPlatformOf(udid))}`} is not running.`,
        action: 'boot'
      }
    case 'connecting':
      // A boot in progress says so: an Android cold boot takes ~20 s, and "Connecting…" for that
      // long reads as a hang.
      if (status.device?.state === 'Booting') {
        const android = simPlatformOf(udid) === 'android'
        return {
          kind: 'connecting',
          title: bootingTitle(simPlatformOf(udid)),
          ...(android ? { detail: 'A cold boot takes about 20 seconds.' } : {}),
          action: null,
          ...(status.error ? { notice: status.error.message } : {})
        }
      }
      return {
        kind: 'connecting',
        title: 'Connecting…',
        action: null,
        ...(status.error ? { notice: status.error.message } : {})
      }
    case 'error': {
      const code = status.error?.code ?? 'helper-exited'
      const copy = ERROR_COPY[code]
      return {
        kind: 'error',
        title: copy.title,
        detail: status.error?.message || copy.detail,
        action: code === 'device-not-found' ? 'pick' : NO_RECONNECT.has(code) ? null : 'reconnect'
      }
    }
  }
}

/**
 * How hard the node wants the stream pushed (`SimViewLevel`, shared/sim.ts): off when the node is
 * offscreen, collapsed, or the page is hidden; a trickle when the window is merely unfocused.
 */
export function viewLevel(input: {
  onScreen: boolean
  collapsed: boolean
  documentHidden: boolean
  windowFocused: boolean
}): SimViewLevel {
  if (!input.onScreen || input.collapsed || input.documentHidden) return 'off'
  return input.windowFocused ? 'active' : 'background'
}

/** Stream resolution for the size the node is drawn at: ~1 device pixel per screen pixel, no more. */
export function desiredStreamScale(cssWidth: number, dpr: number, devicePixelWidth: number): number {
  if (!(cssWidth > 0 && dpr > 0 && devicePixelWidth > 0)) return SIM_SCALE_DEFAULT
  const want = (cssWidth * dpr) / devicePixelWidth
  // Quantized so a resize drag does not re-configure the encoder on every frame.
  const q = Math.ceil(want * 10) / 10
  return Math.min(1, Math.max(SIM_SCALE_MIN, q))
}

/** Why the Add rows are disabled, or undefined when a simulator node can be added. */
export function simulatorUnavailableReason(input: { browser: boolean; relay: boolean; mac: boolean }): string | undefined {
  if (input.browser) return 'Simulators and emulators run in the desktop app on macOS — not in a browser tab'
  if (input.relay) return 'A team tab shows the host’s canvas — add the simulator on the host'
  if (!input.mac) return 'Simulator and emulator nodes run in the desktop app on macOS'
  return undefined
}
