/**
 * Saved board views: named filter sets stored in `project.kanban.views`, so a team shares how it
 * looks at its board ("Mine", "Review queue", "Bugs only").
 *
 * What a view carries is DELIBERATELY narrow — `viewQuery` is the only builder, and it reads only
 * the source, label, assignee and column filters:
 *  - never the Running / Needs you / Unread chips: they filter on second-by-second agent state, and
 *    a view that restored them would show a board that is wrong before anyone looked at it;
 *  - never display preferences (showing closed columns) and never the ACTIVE view: those are one
 *    person's, and live in localStorage (`state/kanbanDisplay.ts`).
 *
 * The list is git-shared, hand-editable input, so `sanitizeViews` runs inside `sanitizeKanban` on
 * every load and save seam. It repairs rather than invents, keeps query fields it does not know
 * (a newer build's filter must survive an older teammate's save), and returns a clean list BY
 * IDENTITY so a well-formed file is never rewritten.
 */
import type { KanbanSavedView, KanbanViewQuery, ProjectKanban } from './types'
import { isRecord } from './is-record'

export const KANBAN_VIEW_SOURCES: ReadonlyArray<NonNullable<KanbanViewQuery['source']>> = [
  'all',
  'github',
  'pulls',
  'sessions'
]
export const VIEW_NAME_MAX = 60
export const KANBAN_VIEWS_MAX = 50
const ID_MAX = 128
const ITEM_MAX = 200
const LIST_MAX = 200

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/** A shown name: control characters out, trimmed, bounded. '' = no usable name. */
function cleanName(name: string): string {
  return name.replace(CONTROL, ' ').trim().slice(0, VIEW_NAME_MAX).trim()
}

const LIST_FIELDS = ['labels', 'assignees', 'columns'] as const

/** The filters a view saves, from the board's filter state. Anything else it is handed — the
 *  live-state chips above all — is ignored by construction. Defaults are omitted. */
export function viewQuery(filters: {
  source: KanbanViewQuery['source']
  labels: readonly string[]
  assignees: readonly string[]
  columns: readonly string[]
}): KanbanViewQuery {
  const q: KanbanViewQuery = {}
  if (filters.source && filters.source !== 'all') q.source = filters.source
  for (const f of LIST_FIELDS) if (filters[f].length) q[f] = [...filters[f]]
  return q
}

/** Do two queries select the same cards? List order and absent-vs-empty do not matter. */
export function sameViewQuery(a: KanbanViewQuery, b: KanbanViewQuery): boolean {
  if ((a.source ?? 'all') !== (b.source ?? 'all')) return false
  return LIST_FIELDS.every((f) => {
    const x = [...(a[f] ?? [])].sort()
    const y = [...(b[f] ?? [])].sort()
    return x.length === y.length && x.every((v, i) => v === y[i])
  })
}

function sanitizeQuery(q: Record<string, unknown>): KanbanViewQuery {
  let changed = false
  const out: Record<string, unknown> = { ...q }
  if ('source' in q && !KANBAN_VIEW_SOURCES.includes(q.source as never)) {
    delete out.source
    changed = true
  }
  for (const f of LIST_FIELDS) {
    if (!(f in q)) continue
    const v = q[f]
    if (!Array.isArray(v)) {
      delete out[f]
      changed = true
      continue
    }
    const kept = v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= ITEM_MAX).slice(0, LIST_MAX)
    if (kept.length !== v.length) {
      if (kept.length) out[f] = kept
      else delete out[f]
      changed = true
    }
  }
  return (changed ? out : q) as KanbanViewQuery
}

/** Admit a views list from a file (see the module note). */
export function sanitizeViews(x: unknown): KanbanSavedView[] | undefined {
  if (!Array.isArray(x)) return undefined
  let changed = false
  const out: KanbanSavedView[] = []
  const seen = new Set<string>()
  for (const v of x) {
    if (out.length >= KANBAN_VIEWS_MAX) {
      changed = true
      break
    }
    if (
      !isRecord(v) ||
      typeof v.id !== 'string' || !v.id || v.id.length > ID_MAX || seen.has(v.id) ||
      typeof v.name !== 'string' || !cleanName(v.name) ||
      !isRecord(v.query)
    ) {
      changed = true
      continue
    }
    seen.add(v.id)
    const name = cleanName(v.name)
    const query = sanitizeQuery(v.query)
    if (name !== v.name || query !== v.query) {
      out.push({ ...(v as unknown as KanbanSavedView), name, query })
      changed = true
    } else {
      out.push(v as unknown as KanbanSavedView)
    }
  }
  if (!changed) return x as KanbanSavedView[]
  return out.length ? out : undefined
}

const views = (k: ProjectKanban): KanbanSavedView[] => (Array.isArray(k.views) ? k.views : [])

function withViews(k: ProjectKanban, list: KanbanSavedView[]): ProjectKanban {
  if (list.length) return { ...k, views: list }
  const { views: _gone, ...rest } = k
  return rest
}

/** Save the current filters as a new view. `id` null = refused (no usable name, or at the cap) and
 *  the board is returned unchanged. */
export function saveView(
  k: ProjectKanban,
  name: string,
  query: KanbanViewQuery
): { k: ProjectKanban; id: string | null } {
  const clean = cleanName(name)
  if (!clean || views(k).length >= KANBAN_VIEWS_MAX) return { k, id: null }
  const id = `kview-${Math.random().toString(36).slice(2, 10)}`
  return { k: withViews(k, [...views(k), { id, name: clean, query }]), id }
}

export function renameView(k: ProjectKanban, id: string, name: string): ProjectKanban {
  const clean = cleanName(name)
  if (!clean || !views(k).some((v) => v.id === id)) return k
  return withViews(k, views(k).map((v) => (v.id === id ? { ...v, name: clean } : v)))
}

export function updateView(k: ProjectKanban, id: string, query: KanbanViewQuery): ProjectKanban {
  if (!views(k).some((v) => v.id === id)) return k
  return withViews(k, views(k).map((v) => (v.id === id ? { ...v, query } : v)))
}

export function deleteView(k: ProjectKanban, id: string): ProjectKanban {
  if (!views(k).some((v) => v.id === id)) return k
  return withViews(k, views(k).filter((v) => v.id !== id))
}
