import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { isAerialWallpaper, nextShuffleClip, normalizeWallpaper, parseAerialId } from '@shared/wallpaper'
import { CANVAS_COVERED_ATTR } from '../lib/canvasCovered'
import { WINDOW_ACTIVITY_ATTR } from '../lib/windowActivity'
import { useSettings } from '../state/settings'
import { useWallpaperBackground, wallpaperLayers } from '../state/wallpaper'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const motionQuery = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION) : null

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const q = motionQuery()
      q?.addEventListener('change', onChange)
      return () => q?.removeEventListener('change', onChange)
    },
    () => motionQuery()?.matches ?? false
  )
}

/**
 * An aerial wallpaper (`aerial:` / `aerial-shuffle:`): the aerial's thumbnail still with a muted
 * `<video>` over it. Renders nothing for any other wallpaper.
 *
 * Canvas layer (`board` false): a `position: fixed` layer rendered as the SIBLING right before
 * `.canvas-root`, which then paints no background of its own. It has `z-index: auto`, so it creates
 * no stacking context and everything inside `.canvas-root` paints over it exactly as it painted over
 * the root's own background — the stacking of every panel, portal and the tab bar is identical to a
 * still wallpaper's. The layer carries the still (and the `--canvas-bg` colour under it), so a clip
 * that is loading, failed, or never existed leaves the still on screen, never black.
 *
 * Board layer (`board` true, Liquid Glass only): fixed to the viewport at `z-index: -1` inside the
 * kanban overlay, which is a stacking context already (fixed, z 25) and paints the still itself.
 * The board picks its OWN clip and starts it from the beginning; it does not continue the canvas
 * layer's clip or position (the canvas layer is paused while a board covers it).
 *
 * The clips are nt-media: URLs core minted from its own manifest scan (`wallpaper.aerialClips`).
 * A single aerial loops; a shuffle asks core again when a clip ends (macOS downloads more over time)
 * and plays a random other one. A clip that fails to load is skipped once for another clip; with
 * none left, the still shows. Under Reduce Motion the video is mounted but never played: its first
 * frame is a full-resolution still, where the thumbnail is a 214×130 PNG.
 *
 * Paused whenever nobody is looking: the window is hidden or unfocused (`data-nt-window="idle"`,
 * the same gate that freezes every CSS animation — a decoding 4K clip keeps the GPU busy like one),
 * and the canvas layer also while a board covers the canvas.
 */
export function AerialWallpaper({ board = false }: { board?: boolean }): React.JSX.Element | null {
  const w = normalizeWallpaper(useSettings((s) => s.settings.desktopWallpaper))
  const id = w.kind === 'preset' && parseAerialId(w.id) ? w.id : null
  const shuffle = !!id && parseAerialId(id)!.shuffle
  const reduced = useReducedMotion()
  const still = useWallpaperBackground()
  const [clip, setClip] = useState<{ id: string; src: string } | null>(null)
  const ref = useRef<HTMLVideoElement>(null)
  // The last clip list core answered, and the clips that failed to load this episode.
  const clipsRef = useRef<string[]>([])
  const failedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!id) return
    let live = true
    failedRef.current = new Set()
    window.nodeTerminal.wallpaper
      .aerialClips({ kind: 'preset', id })
      .then((clips) => {
        clipsRef.current = clips
        const src = nextShuffleClip(clips, null)
        if (live) setClip(src ? { id, src } : null)
      })
      .catch(() => live && setClip(null))
    return () => {
      live = false
      setClip(null)
    }
  }, [id])

  const src = clip?.id === id ? clip.src : null

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement
    const sync = (): void => {
      const away = document.hidden || root.getAttribute(WINDOW_ACTIVITY_ATTR) === 'idle'
      if (reduced || away || (!board && root.hasAttribute(CANVAS_COVERED_ATTR))) el.pause()
      else void el.play().catch(() => {})
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    const watch = new MutationObserver(sync)
    watch.observe(root, {
      attributes: true,
      attributeFilter: board ? [WINDOW_ACTIVITY_ATTR] : [WINDOW_ACTIVITY_ATTR, CANVAS_COVERED_ATTR]
    })
    return () => {
      document.removeEventListener('visibilitychange', sync)
      watch.disconnect()
    }
  }, [src, board, reduced])

  // Release the decoder when the clip changes or the layer goes: a detached <video> keeps its
  // media resource (and a hardware HEVC decoder) until its src is dropped and it reloads.
  useEffect(() => {
    const el = ref.current
    return () => {
      if (!el) return
      el.pause()
      el.removeAttribute('src')
      el.load()
    }
  }, [src])

  const layerStyle = useMemo<React.CSSProperties | undefined>(
    () => (board ? undefined : still ? wallpaperLayers(still) : { backgroundColor: 'var(--canvas-bg)' }),
    [board, still]
  )

  if (!id) return null

  /** Move on from `from` (ended, or failed): the next clip core lists, else the still. */
  const advance = (from: string, failed: boolean): void => {
    const playing = id
    if (failed) failedRef.current.add(from)
    void window.nodeTerminal.wallpaper
      .aerialClips({ kind: 'preset', id: playing })
      .catch(() => clipsRef.current)
      .then((clips) => {
        clipsRef.current = clips
        const usable = clips.filter((c) => !failedRef.current.has(c))
        const next = nextShuffleClip(usable, from)
        if (next === from && ref.current) {
          ref.current.currentTime = 0
          void ref.current.play().catch(() => {})
        } else {
          setClip((c) => (c?.id === playing ? (next ? { id: playing, src: next } : null) : c))
        }
      })
  }

  return (
    <div
      className={board ? 'aerial-wallpaper aerial-wallpaper--board' : 'aerial-wallpaper'}
      style={layerStyle}
      aria-hidden
    >
      {src && (
        <video
          ref={ref}
          key={src}
          src={src}
          tabIndex={-1}
          muted
          autoPlay={!reduced}
          preload="auto"
          playsInline
          loop={!shuffle}
          onEnded={shuffle ? () => advance(src, false) : undefined}
          onError={() => (shuffle ? advance(src, true) : setClip(null))}
        />
      )}
    </div>
  )
}

/** Whether the setting names an aerial, for callers that only need to know (the canvas root). */
export function useIsAerialWallpaper(): boolean {
  return isAerialWallpaper(useSettings((s) => s.settings.desktopWallpaper))
}
