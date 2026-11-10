import { useMemo } from 'react'
import type React from 'react'
import { useSettings } from '../state/settings'
import { resolveTerminalTheme } from '../terminal/themes'
import { isLiquidGlass } from './appTheme'
import { GLASS_READABLE_TICK, glassTint, resolveGlassSlider, type GlassTint } from './glassContrast'
import { useGlassA11y } from './useGlassA11y'

/**
 * Glass for one terminal view (a canvas node, or the kanban card modal — both are views of a
 * session and must look alike): xterm paints no background and the view supplies a translucent
 * tint of ITS effective theme — project override included — at the alpha that keeps its foreground
 * at 4.5:1 over any backdrop (glassContrast.ts). `vars` are the inline custom properties the
 * `.term-node--glass` / `.kanban-modal__termwrap--glass` rules read; null when not Liquid Glass.
 * `readableFloor` keeps the tint at or right of the Readable tick: for a view with no backdrop
 * filter of its own (the card modal), where the tint alone must hold the contrast.
 */
export function useTerminalGlass(terminalTheme: string, readableFloor = false): {
  glass: boolean
  tint: GlassTint | null
  vars: React.CSSProperties | null
} {
  const glass = isLiquidGlass(useSettings((s) => s.settings.appTheme))
  const slider = resolveGlassSlider(useSettings((s) => s.settings.glassTint))
  const glassSlider = readableFloor ? Math.max(slider, GLASS_READABLE_TICK) : slider
  const glassA11y = useGlassA11y()
  const tint = useMemo(
    () => (glass ? glassTint(resolveTerminalTheme(terminalTheme).theme, glassSlider, glassA11y) : null),
    [glass, glassSlider, glassA11y, terminalTheme]
  )
  const vars = useMemo(
    () =>
      tint
        ? ({
            '--term-glass-bg': tint.background,
            '--term-glass-header-bg': tint.header,
            '--term-glass-chip-wash': tint.chipWash,
            '--term-glass-fg': tint.foreground,
            ...(tint.backdrop && { '--term-glass-backdrop': tint.backdrop })
          } as React.CSSProperties)
        : null,
    [tint]
  )
  return { glass, tint, vars }
}
