/** A whiteboard as read back from its side file (core/whiteboards.ts). */
export interface WhiteboardFile {
  /** The `.excalidraw` JSON, as written; absent when the read asked for the picture only. */
  scene?: string
  /** The PNG the node shows at rest, base64; absent when none was saved. */
  thumbnailBase64?: string
  /** Epoch ms of the scene's last write. Display only: two writes can share one. */
  updatedAt: number
  /**
   * The scene file's revision (an opaque token that changes on every write). A save names the
   * revision its editor last read or wrote, and is refused when the file has moved on since. Absent
   * from a host on an older build — a save then carries none and is not checked.
   */
  rev?: string
  /** True when this came from the source board because the node has none of its own yet. */
  fromSource: boolean
}

/**
 * What a save answered. `null` (outside this type) still means "refused or could not be written".
 * A conflict means the board on disk is not the revision this editor started from: another editor
 * (a second tab, another machine on the same folder, a teammate, a `git pull`) wrote it meanwhile,
 * and nothing was written. `currentRev` is the revision now on disk (null: there is no board of
 * this node's own any more), so the editor can choose to overwrite it knowingly.
 */
export type WhiteboardSaveResult =
  | { ok: true; path: string; rev: string }
  | { ok: false; conflict: true; currentRev: string | null }
