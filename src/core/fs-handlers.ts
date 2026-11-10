import { homedir } from 'os'
import path from 'path'
import type { CorePlatform } from './platform'
import * as fsOps from './fs-ops'
import { saveUpload } from './uploads'
import { saveCanvasImage } from './canvas-images'
import { readWhiteboard, saveWhiteboard, type WhiteboardLocation } from './whiteboards'
import { clearAlertSound, readAlertSound, saveAlertSound } from './alert-sounds'
import type { AlertSoundKind } from '../shared/alert-sound'
import { IPC } from '../shared/ipc'
import type { DownloadTicket } from '../shared/types'

/**
 * Expand a leading `~` / `~/` against THIS core's home directory — the machine that owns the
 * filesystem, not the viewer. Terminal output names home-relative paths constantly (Claude Code's
 * plan-approval screen prints `~/.claude/plans/<name>.md`), and the renderer cannot resolve them
 * itself: it does not know the core's home, and on the Server Edition it runs on another machine.
 * An SSH project never reaches here — its `sshFs` stack leaves the `~` for the remote shell.
 * `~user` is NOT a home-relative path and stays literal (same rule as the accounts link dialog).
 * The relay's jailed `fs.*` path calls fs-ops directly and is deliberately not routed through this.
 */
export function expandHomePath(p: string, home: string = homedir()): string {
  if (typeof p !== 'string') return p
  return p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : p
}

/** The fs.* + files.quickOpen RPC surface, registered ONCE for every shell (Electron main, the
 *  Server Edition, and — through the Electron platform's handler table — a relay peer). The logic
 *  is already pure in core/fs-ops.ts; this is only the registration.
 *
 *  It lives here, and not in either shell, so the two can never drift: the desktop used to register
 *  these on raw `ipcMain`, which made them unreachable for a peer (a peer has no webContents).
 *  Threat model unchanged: whoever can reach these already has a terminal on this machine. */
export function registerFsHandlers(
  platform: CorePlatform,
  deps: {
    /**
     * Mint an HTTP download ticket for `path` — supplied ONLY by a shell that has an HTTP surface
     * to redeem it on (the Server Edition). Absent everywhere else, and the handler then answers
     * `null` rather than going unregistered: the renderer awaits this to decide whether to offer a
     * download at all, and an unregistered channel would reject instead, which reads as an error
     * rather than as "not offered here".
     */
    issueDownloadTicket?: (path: string) => Promise<DownloadTicket | null>
    /**
     * The project's LOCAL cwd, or undefined for an SSH project / relay tab / cwd-less canvas.
     * Injected rather than taken from the caller because the renderer sends only a `projectId`:
     * the write path is always derived here, from this shell's own workspace index, so a canvas
     * image can never be aimed at a directory the renderer names. (Same discipline as
     * `registerBoardLogHandlers` — see core/board-log-handlers.ts.) Absent ⇒ every project takes
     * the durable app-local fallback, which is a coherent degrade, not a failure.
     */
    localProjectCwd?: (projectId: string) => string | undefined
    /**
     * Where a project's whiteboards go (`WorkspaceStore.whiteboardLocationForProject`), derived the
     * same way from this shell's own index. Not `localProjectCwd`: a folder project kept in app data
     * keeps its boards in its own app-data root rather than in the app's shared folder, where two
     * projects holding the same committed canvas — the same node ids — would share boards. Absent ⇒
     * `localProjectCwd`'s folder.
     */
    whiteboardLocation?: (projectId: string) => Omit<WhiteboardLocation, 'userDataDir'>
  } = {}
): void {
  const home = expandHomePath
  const boardLocation = (projectId: string): WhiteboardLocation => ({
    ...(deps.whiteboardLocation ? deps.whiteboardLocation(projectId) : { projectCwd: deps.localProjectCwd?.(projectId) }),
    userDataDir: platform.userDataDir
  })
  platform.handle(IPC.fsList, (dirPath: string) => fsOps.listDir(home(dirPath)))
  platform.handle(IPC.fsRead, (filePath: string) => fsOps.readText(home(filePath)))
  platform.handle(IPC.fsReadBinary, (filePath: string) => fsOps.readBinary(home(filePath)))
  platform.handle(IPC.fsWrite, (filePath: string, content: string) =>
    fsOps.writeText(home(filePath), content)
  )
  platform.handle(IPC.fsMkdir, (dirPath: string) => fsOps.makeDir(home(dirPath)))
  platform.handle(IPC.fsExists, (p: string) => fsOps.pathExists(home(p)))
  platform.handle(IPC.filesQuickOpen, (cwd: string) => fsOps.listQuickOpenFiles(cwd))
  // Bytes with no path on this machine (a clipboard paste, or a browser client's file) land in
  // the managed uploads dir so the terminal has something to name. See core/uploads.ts.
  platform.handle(IPC.filesSaveUpload, (name: string, dataBase64: string) =>
    saveUpload(platform.userDataDir, name, dataBase64)
  )
  // A canvas image node is persisted, so its bytes go somewhere equally durable — the project's
  // own `.nodeterm/images/` when it has one. See core/canvas-images.ts for the fallbacks.
  platform.handle(
    IPC.filesSaveCanvasImage,
    (projectId: string, name: string, dataBase64: string) =>
      saveCanvasImage({
        projectCwd: deps.localProjectCwd?.(projectId),
        userDataDir: platform.userDataDir,
        name,
        dataBase64
      })
  )
  // A whiteboard's scene + picture: beside project.json when the project has a local cwd (in its
  // app-data root when its canvas is kept there), else in this core's data dir. Addressed by node id
  // only — see core/whiteboards.ts for why a path is never accepted.
  // `expectedRev` is the compare-and-set revision (see `saveWhiteboard`): a stale one is refused.
  platform.handle(
    IPC.filesSaveWhiteboard,
    (projectId: string, nodeId: string, scene: string, thumbnailBase64?: string, expectedRev?: string | null) =>
      saveWhiteboard(boardLocation(projectId), nodeId, scene, thumbnailBase64, expectedRev)
  )
  platform.handle(
    IPC.filesReadWhiteboard,
    (projectId: string, nodeId: string, sourceId?: string, withScene?: boolean) =>
      readWhiteboard(boardLocation(projectId), nodeId, sourceId, withScene !== false)
  )
  // Custom alert sounds (issue #289): bytes in, a FIXED per-kind file under this core's data dir
  // out. Reads and deletes take only a kind, so no caller can aim them at another file. See
  // core/alert-sounds.ts for the validation.
  platform.handle(
    IPC.filesSaveAlertSound,
    (kind: AlertSoundKind, name: string, dataBase64: string) =>
      saveAlertSound(platform.userDataDir, kind, name, dataBase64)
  )
  platform.handle(IPC.filesReadAlertSound, (kind: AlertSoundKind) =>
    readAlertSound(platform.userDataDir, kind)
  )
  platform.handle(IPC.filesClearAlertSound, (kind: AlertSoundKind) =>
    clearAlertSound(platform.userDataDir, kind)
  )
  platform.handle(IPC.filesDownloadTicket, (p: string) =>
    deps.issueDownloadTicket ? deps.issueDownloadTicket(p) : Promise.resolve(null)
  )
}
