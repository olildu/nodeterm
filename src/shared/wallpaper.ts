/**
 * Desktop wallpaper behind the canvas (the "Liquid Glass" appearance).
 *
 * Opt-in: the default is `{ kind: 'none' }`, which draws the canvas exactly as before. The value is
 * hand-editable settings.json, so every reader goes through `normalizeWallpaper` and an
 * unrecognised shape degrades to `none`, never to something else.
 *
 * Three kinds of source:
 *  - `gradient:<name>` presets are pure CSS (below), so they work on every platform and in the
 *    Server Edition with no image file at all.
 *  - `mac:<path under /System/Library/Desktop Pictures>` presets are the stock macOS stills, read
 *    from disk at runtime and NEVER bundled (they are Apple's). Converted to JPEG by `sips` in
 *    core, since Chromium cannot decode HEIC.
 *  - `win:<path under %WINDIR%\\Web\\Wallpaper>` presets are the stock Windows stills, read and
 *    converted the same way through Electron's `nativeImage` (desktop only).
 *  - `aerial:<asset UUID>` / `aerial-shuffle:<category UUID>` presets are the macOS Aerial videos
 *    macOS itself has downloaded (one clip looped, or a category shuffled), read from
 *    `~/Library/Application Support/com.apple.wallpaper/aerials` at runtime and never bundled or
 *    downloaded by us. Core resolves the UUID against a fresh manifest scan; the still behind the
 *    video (and the fallback when nothing can play) is the asset's thumbnail.
 *  - `image` is a picture the user chose, COPIED into `<userData>/wallpapers/` on import so moving
 *    the original does not break it. `path` names that copy; core refuses to read anything else.
 */
export type DesktopWallpaper =
  | { kind: 'none' }
  | { kind: 'preset'; id: string }
  | { kind: 'image'; path: string }

export const NO_WALLPAPER: DesktopWallpaper = { kind: 'none' }

export interface GradientWallpaper {
  id: string
  label: string
  css: string
}

/** Built-in gradient presets — the cross-platform set (Linux, Windows, Server Edition). */
export const GRADIENT_WALLPAPERS: readonly GradientWallpaper[] = [
  {
    id: 'gradient:dusk',
    label: 'Dusk',
    css: 'linear-gradient(165deg, #1d2b64 0%, #6a3d8f 52%, #f4a6b8 100%)'
  },
  {
    id: 'gradient:aurora',
    label: 'Aurora',
    css:
      'radial-gradient(ellipse at 22% 18%, rgba(61, 220, 151, 0.75) 0%, transparent 48%), ' +
      'radial-gradient(ellipse at 78% 30%, rgba(90, 120, 255, 0.7) 0%, transparent 52%), ' +
      'linear-gradient(180deg, #0b1026 0%, #172a4f 100%)'
  },
  {
    id: 'gradient:ocean',
    label: 'Ocean',
    css: 'linear-gradient(160deg, #00c6ff 0%, #0072ff 55%, #002a5c 100%)'
  },
  {
    id: 'gradient:sunrise',
    label: 'Sunrise',
    css: 'linear-gradient(180deg, #ffe29f 0%, #ffa99f 48%, #ff719a 100%)'
  },
  {
    id: 'gradient:meadow',
    label: 'Meadow',
    css: 'linear-gradient(170deg, #f1fbd8 0%, #a8e063 50%, #3f8f2a 100%)'
  },
  {
    id: 'gradient:graphite',
    label: 'Graphite',
    css: 'linear-gradient(160deg, #4b4b52 0%, #1c1c20 100%)'
  }
]

export function gradientCss(id: string): string | undefined {
  return GRADIENT_WALLPAPERS.find((g) => g.id === id)?.css
}

/** A macOS still as the picker shows it. `thumb` is a data: URL, or null when it could not be made. */
export interface WallpaperStill {
  id: string
  label: string
  thumb: string | null
}

export interface WallpaperApi {
  /** The macOS stills found on the machine that owns the files (empty off macOS). */
  listStills(): Promise<WallpaperStill[]>
  /** A data: URL for a still or an imported image; null when it cannot be read (degrade to none). */
  load(wallpaper: DesktopWallpaper): Promise<string | null>
  /** Copy (converting HEIC) a picked image into the wallpaper cache; resolves the value to store. */
  importImage(sourcePath: string): Promise<DesktopWallpaper>
  /** The aerial tiles: one shuffle per category, then each downloaded aerial. Empty off macOS and in
   *  the Server Edition. `thumb` is an nt-media: URL. */
  listAerials(): Promise<WallpaperStill[]>
  /** nt-media: URLs of the downloaded clips an aerial wallpaper plays, re-scanned on every call
   *  (macOS downloads more over time); empty when none can play — the still then shows. */
  aerialClips(wallpaper: DesktopWallpaper): Promise<string[]>
}

const MAX_FIELD = 4096

export const AERIAL_PREFIX = 'aerial:'
export const AERIAL_SHUFFLE_PREFIX = 'aerial-shuffle:'
/** Apple's asset and category ids are upper-case UUIDs; accept either case, nothing else. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isAerialUuid(s: string): boolean {
  return UUID.test(s)
}

/** Does this (hand-editable) setting name an aerial wallpaper? */
export function isAerialWallpaper(raw: unknown): boolean {
  const w = normalizeWallpaper(raw)
  return w.kind === 'preset' && parseAerialId(w.id) !== null
}

/** The UUID an aerial id names and whether it is a shuffle, or null for any other id. */
export function parseAerialId(id: string): { uuid: string; shuffle: boolean } | null {
  const shuffle = id.startsWith(AERIAL_SHUFFLE_PREFIX)
  if (!shuffle && !id.startsWith(AERIAL_PREFIX)) return null
  const uuid = id.slice(shuffle ? AERIAL_SHUFFLE_PREFIX.length : AERIAL_PREFIX.length)
  return isAerialUuid(uuid) ? { uuid, shuffle } : null
}

/**
 * The shuffle's next clip: a random one, never `current` again while there is any other. A single
 * clip (or none) is simply itself.
 */
export function nextShuffleClip(
  clips: readonly string[],
  current: string | null,
  random: () => number = Math.random
): string | null {
  const pool = clips.length > 1 ? clips.filter((c) => c !== current) : clips
  return pool.length ? pool[Math.floor(random() * pool.length) % pool.length] : null
}

/** Re-validate a hand-editable value. Anything unrecognised is `none`. */
export function normalizeWallpaper(v: unknown): DesktopWallpaper {
  if (!v || typeof v !== 'object') return NO_WALLPAPER
  const o = v as Record<string, unknown>
  if (o.kind === 'preset' && typeof o.id === 'string' && o.id.length > 0 && o.id.length < MAX_FIELD) {
    if (o.id.startsWith('gradient:') && !gradientCss(o.id)) return NO_WALLPAPER
    // `mac:` / `win:` name a system still; core re-resolves it against its OWN fresh scan, so an id
    // from the other OS (a settings.json synced across machines) simply loads nothing there.
    // `aerial:` / `aerial-shuffle:` likewise, and only with a UUID after the prefix.
    const aerial = o.id.startsWith(AERIAL_PREFIX) || o.id.startsWith(AERIAL_SHUFFLE_PREFIX)
    if (aerial && !parseAerialId(o.id)) return NO_WALLPAPER
    if (!aerial && !o.id.startsWith('gradient:') && !o.id.startsWith('mac:') && !o.id.startsWith('win:')) {
      return NO_WALLPAPER
    }
    return { kind: 'preset', id: o.id }
  }
  if (o.kind === 'image' && typeof o.path === 'string' && o.path.length > 0 && o.path.length < MAX_FIELD) {
    return { kind: 'image', path: o.path }
  }
  return NO_WALLPAPER
}

/**
 * What Liquid Glass picks when it is chosen with no wallpaper, so glass never sits over plain
 * black: the first system still (the macOS scan already orders Sonoma Horizon first; Windows lists
 * its stock stills when the desktop shell can convert them), else the first gradient — the answer
 * on Linux and the Server Edition, where the list is empty.
 */
export function defaultWallpaper(stills: readonly { id: string }[]): DesktopWallpaper {
  return stills[0] ? { kind: 'preset', id: stills[0].id } : { kind: 'preset', id: GRADIENT_WALLPAPERS[0].id }
}

export function sameWallpaper(a: DesktopWallpaper, b: DesktopWallpaper): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'preset') return a.id === (b as { id: string }).id
  if (a.kind === 'image') return a.path === (b as { path: string }).path
  return true
}

/**
 * The user's most recent imported image (`settings.recentWallpaperImage`), kept across a switch to
 * a preset so browsing presets never destroys it: the "Your image" tile stays and the cache prune
 * keeps its file. Hand-editable, so it is re-validated like the wallpaper itself.
 */
export function recentWallpaperImage(v: unknown): DesktopWallpaper | null {
  const w = normalizeWallpaper({ kind: 'image', path: v })
  return w.kind === 'image' ? w : null
}

/** The settings patch for choosing `next` while `current` is on screen: an image being chosen, or
 *  one being left, becomes the recent image. */
export function wallpaperChoice(
  current: DesktopWallpaper,
  next: DesktopWallpaper
): { desktopWallpaper: DesktopWallpaper; recentWallpaperImage?: string } {
  const image = next.kind === 'image' ? next : current.kind === 'image' ? current : null
  return image ? { desktopWallpaper: next, recentWallpaperImage: image.path } : { desktopWallpaper: next }
}

/** What a saved settings change must keep in the wallpaper cache: the choice and the recent image. */
export function wallpapersToKeep(s: { desktopWallpaper?: unknown; recentWallpaperImage?: unknown }): unknown[] {
  return [s.desktopWallpaper, recentWallpaperImage(s.recentWallpaperImage)]
}
