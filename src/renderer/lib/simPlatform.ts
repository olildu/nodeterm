import {
  simPlatformOf,
  type SimAvailability,
  type SimButton,
  type SimDeviceEntry,
  type SimEdge,
  type SimPlatform
} from '@shared/sim'
import { cornerRadiusFraction, edgeFor, type Box, type Point } from './simPointer'

/**
 * What differs between an iOS simulator and an Android emulator in the Simulator node. Pure, so
 * the platform switch is one tested table instead of `udid.startsWith('android:')` sprinkled
 * through the component.
 *
 * The rule for the frame: nothing here may assume an iPhone. A Nexus 7 is a 1200x1920 TABLET at
 * 320 dpi (600x960 points, aspect 1.6, square corners); a Pixel phone is tall with rounded corners
 * and a punch-hole the emulator draws itself. So the shape comes from the device's REPORTED point
 * size plus the platform, never from iPhone numbers.
 */

/** Which helper drives this node: the device's own report wins, else the id's prefix, else iOS. */
export function nodePlatform(udid: string | undefined, device?: { platform?: SimPlatform } | null): SimPlatform {
  if (device?.platform) return device.platform
  return udid ? simPlatformOf(udid) : 'ios'
}

/** The device's own word for itself: Xcode has simulators, the Android SDK has emulators. */
export function deviceTerm(platform: SimPlatform): 'simulator' | 'emulator' {
  return platform === 'android' ? 'emulator' : 'simulator'
}

/**
 * Hardware buttons in the header, in display order. iOS keeps the set it always had; Android gets
 * the navigation bar (back / home / recents) and the side buttons. Every name is in SIM_BUTTONS,
 * and each helper refuses the names it has no meaning for, so a wrong row could only no-op.
 */
export const PLATFORM_BUTTONS: Record<SimPlatform, ReadonlyArray<{ name: SimButton; title: string }>> = {
  ios: [
    { name: 'home', title: 'Home' },
    { name: 'lock', title: 'Lock' },
    { name: 'voldown', title: 'Volume down' },
    { name: 'volup', title: 'Volume up' },
    { name: 'siri', title: 'Siri' }
  ],
  android: [
    { name: 'back', title: 'Back' },
    { name: 'home', title: 'Home' },
    { name: 'recents', title: 'Recent apps' },
    { name: 'voldown', title: 'Volume down' },
    { name: 'volup', title: 'Volume up' },
    { name: 'power', title: 'Power' }
  ]
}

/**
 * Layout until the device reports its size: a typical phone of that platform in points (iPhone 15,
 * Pixel 7). Only used for the first frames of a connect; the reported size replaces it.
 */
export function fallbackDeviceBox(platform: SimPlatform): Box {
  return platform === 'android' ? { width: 411, height: 914 } : { width: 393, height: 852 }
}

/**
 * The screen's corner radius as a fraction of its width. iOS keeps its measured rule. Android: the
 * emulator's framebuffer is a plain rectangle (no skin is drawn headless), so rounding is only a
 * hint of a modern tall phone; a tablet or a 16:9 phone gets almost square corners, because
 * rounding those by a phone amount would clip real UI (the status bar, a FAB) at the corners.
 */
export function screenCornerFraction(platform: SimPlatform, device: Box): number {
  if (platform === 'ios') return cornerRadiusFraction(device)
  if (!(device.width > 0 && device.height > 0)) return 0.04
  const aspect = Math.max(device.width, device.height) / Math.min(device.width, device.height)
  return aspect > 2 ? 0.05 : 0.012
}

/**
 * The `edge` flag on a touch-down. It tells the iOS helper a touch is a system edge gesture (the
 * home-indicator swipe needs it); Android has no such flag — its gesture navigation reads raw edge
 * touches itself — so nothing is sent there.
 */
export function touchEdge(platform: SimPlatform, p: Point, device: Box): SimEdge | undefined {
  return platform === 'ios' ? edgeFor(p, device) : undefined
}

/** "Booting emulator…" / "Booting simulator…": an AVD cold boot takes ~20 s, so say what is happening. */
export function bootingTitle(platform: SimPlatform): string {
  return `Booting ${deviceTerm(platform)}…`
}

export type PickerRow =
  | { kind: 'label'; label: string }
  | { kind: 'device'; device: SimDeviceEntry; label: string; current: boolean }
  | { kind: 'empty'; label: string }

/**
 * The device picker's rows. iOS-only hosts get the flat list they always had; once an Android
 * emulator is in the list, each platform gets its own labelled section (iOS first), so two
 * "Pixel"-ish names can never be confused across platforms.
 */
export function pickerRows(input: {
  devices: SimDeviceEntry[]
  current: string | undefined
  error?: string
  availability: SimAvailability | null
}): PickerRow[] {
  const { devices, current, error, availability } = input
  if (devices.length === 0) {
    const android = availability?.ok === true && availability.platforms?.android === true
    const ios = !(availability?.ok === true && availability.platforms && !availability.platforms.ios)
    const none = android && ios
      ? 'No iOS simulators or Android emulators found'
      : android
        ? 'No Android emulators found'
        : 'No iOS simulators found'
    return [{ kind: 'empty', label: error || none }]
  }
  const row = (d: SimDeviceEntry): PickerRow => ({
    kind: 'device',
    device: d,
    current: d.udid === current,
    label: `${d.udid === current ? '✓ ' : ''}${d.name} · ${d.runtime}${d.booted ? ' · running' : ''}`
  })
  const platformOf = (d: SimDeviceEntry): SimPlatform => d.platform ?? simPlatformOf(d.udid)
  const ios = devices.filter((d) => platformOf(d) === 'ios')
  const android = devices.filter((d) => platformOf(d) === 'android')
  if (android.length === 0) return ios.map(row)
  return [
    ...(ios.length ? [{ kind: 'label' as const, label: 'iOS simulators' }, ...ios.map(row)] : []),
    { kind: 'label', label: 'Android emulators' },
    ...android.map(row)
  ]
}
