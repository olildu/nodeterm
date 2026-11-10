// Where a folder project's canvas is stored (issue #1145): in the folder
// (`<cwd>/.nodeterm/project.json`, git-shareable — the default) or in app data
// (`userData/inline-projects/<id>.json`, nothing written into the folder). See the folder-data-ref
// kind in core/workspace-files.ts and `Project.storeInAppData`.

/** The global default for folder projects added from now on. */
export type NewProjectStorage = 'folder' | 'appData'

export const NEW_PROJECT_STORAGE_DEFAULT: NewProjectStorage = 'folder'

export function isNewProjectStorage(v: unknown): v is NewProjectStorage {
  return v === 'folder' || v === 'appData'
}

/**
 * Where the store has a project's canvas right now: `'folder'` (a folder ref), `'appData'` (a
 * folder project kept in app data), `'none'` (no such project, or neither kind). Asked after a
 * move's save, because a save that lands can still leave the canvas where it was: a move into the
 * folder whose folder write fails stays in app data (see `WorkspaceStore.saveNow`).
 */
export type ProjectStorageKind = 'folder' | 'appData' | 'none'

/**
 * After a project's canvas has moved into app data: its folder files, removed or kept.
 * `kept` lists the files git tracks (or that could not be checked): deleting one shows up as a
 * change in the user's repo, so it is only done when the caller confirms with `removeTracked`.
 */
export type ReleaseFolderFilesResult =
  | { ok: true; removed: string[]; kept: string[] }
  | { ok: false; reason: 'not-app-data' | 'not-saved' }

/**
 * Before a project's canvas moves back into its folder: the folder must not already hold a canvas
 * or settings of its own (the next save would overwrite them), and an unreadable file is never
 * taken for an absent one.
 */
export type PrepareFolderStorageResult =
  | { ok: true }
  | { ok: false; reason: 'not-app-data' | 'occupied' | 'unreadable' | 'settings-occupied' | 'settings-unreadable' }

export const PREPARE_FOLDER_STORAGE_REFUSALS: Record<Exclude<PrepareFolderStorageResult, { ok: true }>['reason'], string> = {
  'not-app-data': 'This project already stores its canvas in its folder.',
  occupied:
    'The folder already has a .nodeterm/project.json. Delete it first, or use “Open folder…” to open that canvas instead.',
  unreadable: 'The folder’s .nodeterm/project.json could not be read, so nothing was changed.',
  'settings-occupied':
    'The folder already has a .nodeterm/settings.json. Delete it first so this project’s own settings are not lost.',
  'settings-unreadable': 'The folder’s .nodeterm/settings.json could not be read or written, so nothing was changed.'
}
