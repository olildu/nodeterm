/**
 * Source-level parity: every `node.new*` command in the registry has a handler in Canvas.tsx.
 *
 * `CommandHandlers` is a `Partial<Record<CommandId, …>>` (deliberately — most registry commands
 * are owned by local listeners or by the main process, not by the canvas dispatcher), so the
 * compiler can never tell you a create command shipped with no handler. It would simply be a
 * remappable row in Settings whose chord does nothing, with the user's own binding as the only
 * evidence. Same discipline as `hook-verified-parity.test.ts`: read the source, assert the key.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { COMMAND_DEFINITIONS } from '@shared/keybindings'

const canvasSource = readFileSync(join(__dirname, 'Canvas.tsx'), 'utf8')

describe('Canvas keybinding handler parity', () => {
  const createIds = COMMAND_DEFINITIONS.map((d) => d.id).filter((id) => id.startsWith('node.new'))
  // Ships unbound like the creates, so it has the same failure mode: a remappable row whose chord
  // does nothing. `node.newSticky` etc. are matched by the prefix; this one is named outright.
  const checkedIds = [...createIds, 'node.nextNeedingYou']

  it('finds the create commands to check (guards against an empty sweep)', () => {
    expect(createIds.length).toBeGreaterThanOrEqual(13)
  })

  // `includes` + a message rather than `toContain`: a miss on a 12k-line file would otherwise
  // print the whole source as the diff and bury the one fact the failure carries.
  it.each(checkedIds)('%s has a handler entry in Canvas.tsx', (id) => {
    expect(
      canvasSource.includes(`'${id}':`),
      `Canvas.tsx has no '${id}' handler — the handlers map is Partial, so nothing else catches this`
    ).toBe(true)
  })
})
