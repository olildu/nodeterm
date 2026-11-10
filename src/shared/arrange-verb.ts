/**
 * The `arrange` canvas-control verb's vocabulary, in the one place all three of its readers can
 * import: the renderer's layout transforms (`renderer/state/workspace.ts`), the request parser and
 * the generated agent docs (`core/canvas-control-core.ts`). Core cannot import the renderer, and a
 * layout list typed once per reader is how the docs come to advertise a word the parser refuses.
 */

/** How a set of sibling nodes is packed. */
export const ARRANGE_LAYOUTS = ['grid', 'row', 'column'] as const
export type ArrangeLayout = (typeof ARRANGE_LAYOUTS)[number]

/**
 * What a group frame's own contents can be laid out as: the three packs, or lineage bands. Lineage
 * exists only here because it is a question about a CONTAINER ("who opened whom, among the things
 * in this frame"), which an id list cannot ask.
 */
export const GROUP_ARRANGE_LAYOUTS = [...ARRANGE_LAYOUTS, 'lineage'] as const
export type GroupArrangeLayout = (typeof GROUP_ARRANGE_LAYOUTS)[number]

/**
 * What the TOP LEVEL of the canvas can be laid out as, through `arrange --group top`: `tidy` is the
 * Tidy canvas command itself (every top-level unit packed, each orchestrator at the top-left of the
 * team it opened), `lineage` its bands. The id-list packs are not offered here — `--nodes` already
 * says them, and a top-level grid that ignores lineage is exactly what Tidy no longer does.
 */
export const TOP_ARRANGE_LAYOUTS = ['tidy', 'lineage'] as const
export type TopArrangeLayout = (typeof TOP_ARRANGE_LAYOUTS)[number]

/** The space every packing leaves between two items when the caller names none, in px. */
export const ARRANGE_GAP_DEFAULT = 40

/**
 * The widest `arrange --gap` accepted, in px: ten times the default. Wider than that is not
 * spacing, it is two separate layouts, and a typo (`--gap 4000` for `40`) should come back as a
 * refusal rather than as a canvas scattered across a screen and a half. Above it the call is
 * REFUSED by name, never clamped — a clamped gap is a layout the caller did not ask for and cannot
 * see in the reply.
 */
export const ARRANGE_GAP_MAX = 400

/**
 * `--gap` as a number of px, or the sentence that refuses it. A whole number from 0 (items
 * touching) to `ARRANGE_GAP_MAX`; absent = `undefined`, which every transform reads as its
 * `ARRANGE_GAP_DEFAULT`. A negative gap is refused rather than read as "overlap a little": every
 * packing here promises no overlap.
 */
export function parseArrangeGap(raw: string | undefined): { gap: number | undefined } | { error: string } {
  if (raw === undefined) return { gap: undefined }
  const s = raw.trim()
  if (!/^\d+$/.test(s)) {
    return { error: `arrange: --gap must be a whole number of pixels from 0 to ${ARRANGE_GAP_MAX} (got "${raw}")` }
  }
  const gap = Number(s)
  if (gap > ARRANGE_GAP_MAX) {
    return { error: `arrange: --gap ${gap} is wider than the ${ARRANGE_GAP_MAX} px maximum — nothing was arranged` }
  }
  return { gap }
}

/**
 * `--group` values that name the canvas's top level instead of a frame — the same words `move`
 * reads as "out of every frame", so the two verbs agree about what `top` means.
 */
export function isTopLevelGroupArg(group: string | undefined): boolean {
  const g = group?.trim()
  return g === 'top' || g === 'none' || g === 'ungrouped'
}

/**
 * The shape gate for `arrange`'s flags, or `null` when the request is well-formed. Whether the
 * frame exists, has children or has any lineage is the canvas's to answer (`groupArrangeRefusal`);
 * this refuses only what no canvas could act on.
 *
 * The two forms are exclusive on purpose: `--group` names a frame and means "its direct children",
 * so a request carrying both has two answers to "which nodes", and picking one silently is the
 * kind of half-honoured flag an agent cannot detect from the reply.
 *
 * Strictness differs by form, deliberately. `--group` is new, so an unknown `--layout` is refused
 * by name. `--nodes` has always fallen back to `grid` on an unknown word, and callers in the field
 * may lean on that — it stays, with ONE exception: `lineage`, which would otherwise be accepted
 * and quietly delivered as a grid.
 */
export function arrangeArgsRefusal(args: Record<string, string>): string | null {
  const hasNodes = !!args.nodes
  const hasGroup = !!args.group
  if (!hasNodes && !hasGroup) return 'arrange requires --nodes <id,id>, --group <frameId> or --group top'
  if (hasNodes && hasGroup) {
    return 'arrange takes --nodes <id,id> or --group <frameId>, not both — name the frame to arrange its own items, or list sibling nodes'
  }
  // Every form packs with a gap, so `--gap` is checked once, before the forms split.
  const gap = parseArrangeGap(args.gap)
  if ('error' in gap) return gap.error
  const layout = args.layout
  if (hasGroup && isTopLevelGroupArg(args.group)) {
    if (layout && !(TOP_ARRANGE_LAYOUTS as readonly string[]).includes(layout)) {
      return `arrange --group top: --layout must be ${TOP_ARRANGE_LAYOUTS.join('|')}`
    }
    return null
  }
  if (hasGroup && layout && !(GROUP_ARRANGE_LAYOUTS as readonly string[]).includes(layout)) {
    return `arrange --group: --layout must be ${GROUP_ARRANGE_LAYOUTS.join('|')}`
  }
  if (hasNodes && layout === 'lineage') {
    return 'arrange: --layout lineage needs --group <frameId> — it lays out one frame\'s own items by who opened whom'
  }
  return null
}

/**
 * The `--gap` paragraph, with its numbers taken from the constants `parseArrangeGap` checks. Part
 * of `arrangeGroupGuidanceLines`, so it lands in both generated bodies with the rest of `arrange`.
 */
export function arrangeGapGuidanceLines(): string[] {
  return [
    `- \`--gap <px>\` (every \`arrange\` form) is the space left between two packed items: a whole number`,
    `  from 0 (touching) to ${ARRANGE_GAP_MAX}; omitted, it is ${ARRANGE_GAP_DEFAULT}. Above ${ARRANGE_GAP_MAX} the call is refused, not`,
    '  clamped. It is applied exactly, grid snapping on or off. It is NOT a frame\'s inner padding: a',
    '  frame still keeps its margin around what it holds.'
  ]
}

/**
 * The agent-facing description of `arrange --group`, rendered into BOTH generated bodies (the
 * SKILL.md and the marker block) so the two cannot describe different products, with the layout
 * list taken from the constant the parser checks.
 */
export function arrangeGroupGuidanceLines(): string[] {
  return [
    `- \`arrange --group <frameId> [--layout ${GROUP_ARRANGE_LAYOUTS.join('|')}] [--cols N] [--gap px]\` — organize a frame by`,
    '  naming IT instead of listing its children: lays out the frame\'s direct children (a frame nested',
    '  inside moves as one unit), then resizes the frame — and every frame around it — to hold them, so',
    '  nothing overflows. The frame\'s top-left stays where it is. `--layout lineage` stacks one row per',
    '  level of who opened whom among those children; it is refused, with the reason, when no opened-by',
    '  or `--after` connection joins two of them. Pass `--nodes` or `--group`, never both. This is the',
    '  one call to make after `group`, or after opening stations into a frame.',
    `- \`arrange --group top [--layout ${TOP_ARRANGE_LAYOUTS.join('|')}] [--gap px]\` — tidy the WHOLE canvas, exactly as the`,
    '  user\'s Tidy canvas command does: every top-level node and frame (a frame moves as one unit) is',
    '  packed without overlap, and each orchestrator is placed first, at the top-left of the nodes and',
    '  frames it opened, with the team it opened packed directly to its right (opened-by only; an',
    '  `--after` wait does not move anything). Nodes nobody opened are packed after the teams.',
    '  `--layout lineage` instead stacks one row per level of opened-by and `--after`. Call it once',
    '  after spawning teams, not after every open.',
    ...arrangeGapGuidanceLines()
  ]
}
