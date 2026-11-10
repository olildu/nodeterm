// Moving a folder project's canvas between its folder and app data (issue #1145), from the tab
// menu. Each direction is a save plus one core step, and the ORDER is the safety:
//
//  - Into app data: flag → save (the canvas lands in `userData/inline-projects/<id>.json`) → THEN
//    `releaseFolderFiles` removes the folder's `.nodeterm` files. The core refuses that step unless
//    the data file demonstrably holds the canvas, and keeps any file git tracks until the user
//    says otherwise — deleting it is a change in their repo.
//  - Into the folder: `prepareFolderStorage` first (refuses a folder that already holds a canvas or
//    settings, which the save would overwrite — the "Set folder…" probe-before-bind rule) → flag →
//    save → ask the store where the canvas is. A save can land while its folder write did not; the
//    store then keeps the project in app data, and so does this (flag back, saved again). The store
//    deletes the app-data copy only after the folder file has landed.
//
// Pure of React and the stores; Canvas passes the levers.
import {
  PREPARE_FOLDER_STORAGE_REFUSALS,
  type PrepareFolderStorageResult,
  type ProjectStorageKind,
  type ReleaseFolderFilesResult
} from '@shared/project-storage'

export interface ProjectStorageMoveDeps {
  setStoreInAppData(projectId: string, on: boolean): void
  /** Saves the workspace; resolves false when the save did not land. */
  persist(): Promise<boolean>
  release(projectId: string, removeTracked: boolean): Promise<ReleaseFolderFilesResult>
  prepare(projectId: string): Promise<PrepareFolderStorageResult>
  /** Where the store has the canvas now; asked after the move into the folder has saved. */
  storage(projectId: string): Promise<ProjectStorageKind>
  confirm(message: string, confirmLabel: string): Promise<boolean>
  notice(kind: 'info' | 'error', text: string): void
}

const baseName = (file: string): string => file.split(/[\\/]/).slice(-2).join('/')

export async function moveProjectToAppData(projectId: string, deps: ProjectStorageMoveDeps): Promise<void> {
  deps.setStoreInAppData(projectId, true)
  if (!(await deps.persist())) {
    // The canvas did not reach app data. Put the flag back so the folder stays the record, and
    // remove nothing from it.
    deps.setStoreInAppData(projectId, false)
    deps.notice('error', 'The canvas could not be saved to app data, so it stays in the folder.')
    return
  }
  let res = await deps.release(projectId, false)
  if (!res.ok) {
    deps.notice('error', 'The canvas is in app data, but its folder files were left in place.')
    return
  }
  if (res.kept.length) {
    const list = res.kept.map(baseName).join(', ')
    const remove = await deps.confirm(
      `The canvas is now stored in app data. Git tracks ${list} in this folder, so deleting ` +
        `${res.kept.length > 1 ? 'them' : 'it'} shows up as a change in the repository. Delete anyway?`,
      'Delete'
    )
    if (remove) res = await deps.release(projectId, true)
  }
  const kept = res.ok ? res.kept : []
  deps.notice(
    'info',
    kept.length
      ? `Canvas stored in app data. Kept in the folder: ${kept.map(baseName).join(', ')}.`
      : 'Canvas stored in app data. Nothing of it is left in the folder.'
  )
}

const FOLDER_WRITE_FAILED = 'The canvas could not be written to the folder, so it stays in app data.'

export async function moveProjectToFolder(projectId: string, deps: ProjectStorageMoveDeps): Promise<void> {
  const ready = await deps.prepare(projectId)
  if (!ready.ok) {
    deps.notice('error', PREPARE_FOLDER_STORAGE_REFUSALS[ready.reason])
    return
  }
  deps.setStoreInAppData(projectId, false)
  if (!(await deps.persist())) {
    deps.setStoreInAppData(projectId, true)
    deps.notice('error', FOLDER_WRITE_FAILED)
    return
  }
  let where: ProjectStorageKind | 'unknown'
  try {
    where = await deps.storage(projectId)
  } catch {
    where = 'unknown'
  }
  if (where === 'appData') {
    // The save landed, the folder write in it did not (a read-only or unmounted folder): the store
    // kept the canvas in app data. Say so, and put the flag back so the next save does not keep
    // retrying a move the user was told failed.
    deps.setStoreInAppData(projectId, true)
    await deps.persist()
    deps.notice('error', FOLDER_WRITE_FAILED)
    return
  }
  if (where !== 'folder') {
    deps.notice('error', 'The canvas was saved, but nodeterm could not confirm it is now in the folder.')
    return
  }
  deps.notice('info', 'Canvas stored in the folder, in .nodeterm/project.json.')
}
