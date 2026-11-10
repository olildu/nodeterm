// Issue #1145: the tab menu's move between a project's folder and app data. What these pin is the
// ORDER — the folder copy goes only after the app-data save landed, the folder is probed before the
// canvas is pointed at it — and that a failed save puts the flag back.
import { describe, expect, it } from 'vitest'
import { moveProjectToAppData, moveProjectToFolder, type ProjectStorageMoveDeps } from './projectStorageMove'
import type { PrepareFolderStorageResult, ProjectStorageKind, ReleaseFolderFilesResult } from '@shared/project-storage'

function harness(opts: {
  saves?: boolean[]
  release?: ReleaseFolderFilesResult[]
  prepare?: PrepareFolderStorageResult
  confirm?: boolean
  storage?: ProjectStorageKind
} = {}) {
  const log: string[] = []
  const saves = [...(opts.saves ?? [true])]
  const releases = [...(opts.release ?? [{ ok: true, removed: ['/r/.nodeterm/project.json'], kept: [] }])]
  const notices: Array<{ kind: string; text: string }> = []
  const deps: ProjectStorageMoveDeps = {
    setStoreInAppData: (_id, on) => { log.push(`flag:${on}`) },
    persist: async () => { log.push('save'); return saves.shift() ?? true },
    release: async (_id, removeTracked) => { log.push(`release:${removeTracked}`); return releases.shift()! },
    prepare: async () => { log.push('prepare'); return opts.prepare ?? { ok: true } },
    confirm: async () => { log.push('confirm'); return opts.confirm ?? false },
    storage: async () => { log.push('storage'); return opts.storage ?? 'folder' },
    notice: (kind, text) => { notices.push({ kind, text }) }
  }
  return { deps, log, notices }
}

describe('moveProjectToAppData', () => {
  it('saves into app data BEFORE releasing the folder files', async () => {
    const h = harness()
    await moveProjectToAppData('p1', h.deps)
    expect(h.log).toEqual(['flag:true', 'save', 'release:false'])
    expect(h.notices).toEqual([{ kind: 'info', text: 'Canvas stored in app data. Nothing of it is left in the folder.' }])
  })

  it('a failed save puts the flag back and removes nothing from the folder', async () => {
    const h = harness({ saves: [false] })
    await moveProjectToAppData('p1', h.deps)
    expect(h.log).toEqual(['flag:true', 'save', 'flag:false'])
    expect(h.notices[0].kind).toBe('error')
  })

  it('asks before deleting files git tracks, and keeps them on no', async () => {
    const h = harness({ release: [{ ok: true, removed: [], kept: ['/r/.nodeterm/project.json'] }], confirm: false })
    await moveProjectToAppData('p1', h.deps)
    expect(h.log).toEqual(['flag:true', 'save', 'release:false', 'confirm'])
    expect(h.notices[0].text).toContain('Kept in the folder: .nodeterm/project.json')
  })

  it('deletes them on yes', async () => {
    const h = harness({
      release: [
        { ok: true, removed: [], kept: ['/r/.nodeterm/project.json'] },
        { ok: true, removed: ['/r/.nodeterm/project.json'], kept: [] }
      ],
      confirm: true
    })
    await moveProjectToAppData('p1', h.deps)
    expect(h.log).toEqual(['flag:true', 'save', 'release:false', 'confirm', 'release:true'])
    expect(h.notices[0].text).toBe('Canvas stored in app data. Nothing of it is left in the folder.')
  })
})

describe('moveProjectToFolder', () => {
  it('probes the folder BEFORE pointing the canvas at it', async () => {
    const h = harness()
    await moveProjectToFolder('p1', h.deps)
    expect(h.log).toEqual(['prepare', 'flag:false', 'save', 'storage'])
    expect(h.notices).toEqual([{ kind: 'info', text: 'Canvas stored in the folder, in .nodeterm/project.json.' }])
  })

  it('a save that landed without the folder file: the canvas stays in app data, and it says so', async () => {
    const h = harness({ storage: 'appData' })
    await moveProjectToFolder('p1', h.deps)
    expect(h.log).toEqual(['prepare', 'flag:false', 'save', 'storage', 'flag:true', 'save'])
    expect(h.notices).toEqual([
      { kind: 'error', text: 'The canvas could not be written to the folder, so it stays in app data.' }
    ])
  })

  it('an occupied folder changes nothing and says why', async () => {
    const h = harness({ prepare: { ok: false, reason: 'occupied' } })
    await moveProjectToFolder('p1', h.deps)
    expect(h.log).toEqual(['prepare'])
    expect(h.notices[0]).toMatchObject({ kind: 'error' })
    expect(h.notices[0].text).toContain('already has a .nodeterm/project.json')
  })

  it('a failed save puts the flag back', async () => {
    const h = harness({ saves: [false] })
    await moveProjectToFolder('p1', h.deps)
    expect(h.log).toEqual(['prepare', 'flag:false', 'save', 'flag:true'])
  })
})
