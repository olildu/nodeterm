/**
 * Issue #385 — a project whose `.nodeterm/project.json` the user deleted stayed crossed out
 * forever. The placeholder is minted at load when the ref can't be read, a save deliberately
 * emits a header-only ref for it (never a file), and `openFolderProject` reuses the entry by cwd
 * while `reopenProject` clears only `closed` — so nothing ever cleared `unavailable` for a local
 * project and the state sustained itself.
 *
 * The decision must rest on EVIDENCE: clearing the flag lets the next save write the placeholder's
 * empty canvas, which would destroy a file that is present but momentarily unreadable.
 */
import { describe, expect, it } from 'vitest'
import { unavailableRecovery } from './projectOpen'

describe('unavailableRecovery', () => {
  const stuck = { unavailable: true }

  it('clears the placeholder when the project file is genuinely gone (the #385 case)', () => {
    expect(unavailableRecovery(stuck, 'absent')).toBe('clear')
  })

  it('rehydrates instead of clearing when the file is back — an empty canvas must not be saved over it', () => {
    expect(unavailableRecovery(stuck, 'present')).toBe('rehydrate')
  })

  it('changes NOTHING when the read merely failed — absence is never inferred from an error', () => {
    expect(unavailableRecovery(stuck, 'unreadable')).toBe('keep')
  })

  it('leaves a healthy project alone whatever the file says', () => {
    expect(unavailableRecovery({}, 'absent')).toBe('keep')
    expect(unavailableRecovery({ unavailable: false }, 'absent')).toBe('keep')
  })

  it('never rehydrates a project stored in app data from its folder (#1145)', () => {
    // Whatever the folder holds is a stale copy or a teammate's canvas, never this project's.
    const appData = { unavailable: true, storeInAppData: true }
    expect(unavailableRecovery(appData, 'present')).toBe('clear')
    expect(unavailableRecovery(appData, 'absent')).toBe('clear')
    expect(unavailableRecovery(appData, 'unreadable')).toBe('clear')
    expect(unavailableRecovery({ storeInAppData: true }, 'present')).toBe('keep')
  })

  it('never judges a REMOTE project from a local stat — its file lives on the host', () => {
    expect(unavailableRecovery({ unavailable: true, ssh: { server: {} } }, 'absent')).toBe('keep')
  })
})
