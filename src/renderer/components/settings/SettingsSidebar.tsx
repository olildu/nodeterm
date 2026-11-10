import { useMemo } from 'react'
import { cn } from '@renderer/ui/cn'
import { Input } from '@renderer/ui/Input'
import { visibleSettingsGroups, type SettingsGroup, type SettingsSectionId } from './nav'
import { matchesQuery } from './search'
import { SectionIcon } from './SettingsIcons'
import { ProjectGlyph } from '../ProjectGlyph'
import { isBrowserRuntime } from '@renderer/bridge/runtime'

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

export function SettingsSidebar({
  activeSectionId,
  query,
  onSelect,
  onQueryChange,
  onClose,
  extraGroups
}: {
  activeSectionId: SettingsSectionId
  query: string
  onSelect: (id: SettingsSectionId) => void
  onQueryChange: (q: string) => void
  onClose: () => void
  /** Groups appended after the static nav — e.g. the render-time "Projects" group, which the
   *  caller builds from live project state (kept out of the sidebar so it needs no store
   *  subscription of its own). */
  extraGroups?: SettingsGroup[]
}): React.JSX.Element {
  const hasQuery = query.trim() !== ''
  const GROUPS = useMemo(
    () => [...visibleSettingsGroups(isMac, isBrowserRuntime()), ...(extraGroups ?? [])],
    [extraGroups]
  )
  return (
    <aside className="flex w-[256px] shrink-0 flex-col border-r border-border bg-panel">
      <div
        className="flex items-center px-3 pb-2 pt-14"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to app"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="flex items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-1 text-sm font-medium text-muted outline-none transition-colors hover:bg-fill-weak hover:text-text"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8.5 3.5 5 7l3.5 3.5" />
          </svg>
          Back to app
        </button>
      </div>

      <div className="px-3 pb-3">
        <div className="relative">
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-2"
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <circle cx="6" cy="6" r="4" />
            <path d="M9.2 9.2 12 12" />
          </svg>
          <Input
            className="h-8 w-full pl-8"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search settings"
            aria-label="Search settings"
          />
        </div>
      </div>

      <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {GROUPS.map((group) => (
          <div key={group.id} className="space-y-0.5">
            <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-2">
              {group.title}
            </p>
            {group.sections.map((s) => {
              const isActive = activeSectionId === s.id
              const dimmed = hasQuery && !matchesQuery(query, { title: s.title })
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSelect(s.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    // settings-nav-row: Liquid Glass restyles the row fills (styles.css glass block).
                    'settings-nav-row group flex w-full items-center gap-2.5 rounded-lg border-0 px-3 py-2 text-left text-[13px] outline-none transition-colors',
                    isActive
                      ? 'bg-white/[0.09] font-medium text-text ring-1 ring-inset ring-white/10'
                      : 'bg-panel text-muted hover:bg-white/[0.05] hover:text-text',
                    dimmed && 'opacity-35'
                  )}
                >
                  <span
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center transition-colors',
                      isActive ? 'text-text' : 'text-muted-2 group-hover:text-muted'
                    )}
                  >
                    {s.color ? (
                      // A project section — the row's own color/icon (see nav.ts'
                      // `projectsSettingsGroup`), instead of the generic folder glyph every
                      // project section used to share.
                      <ProjectGlyph
                        icon={s.icon}
                        color={s.color}
                        name={s.title}
                        variant="monogram"
                        size={16}
                        className="flex size-4 items-center justify-center rounded-[3px] text-[9px] font-semibold uppercase text-white"
                      />
                    ) : (
                      <SectionIcon id={s.id} />
                    )}
                  </span>
                  <span className="truncate">{s.title}</span>
                </button>
              )
            })}
          </div>
        ))}
      </nav>
    </aside>
  )
}
