import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  WHITEBOARD_SCENE_MAX_BYTES,
  appWhiteboardsDir,
  carryWhiteboards,
  projectWhiteboardsDir,
  readWhiteboard,
  saveWhiteboard
} from './whiteboards'

const scene = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'a' }] })
// Bytes that utf-8 text encoding would mangle (0x89 'PNG' header, a NUL, high bytes).
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80])
const png = pngBytes.toString('base64')

/** The written path of a successful save (the tests above the compare-and-set block do not care
 *  about revisions). */
const pathOf = (r: Awaited<ReturnType<typeof saveWhiteboard>>): string | null => (r && r.ok ? r.path : null)

let root: string
let userDataDir: string
let projectCwd: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nt-whiteboards-'))
  userDataDir = join(root, 'userData')
  projectCwd = join(root, 'project')
  await fs.mkdir(projectCwd, { recursive: true })
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('saveWhiteboard / readWhiteboard', () => {
  it('writes beside project.json and reads the scene and picture back, picture byte-exact', async () => {
    const path = await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene, png)
    expect(pathOf(path)).toBe(join(projectWhiteboardsDir(projectCwd), 'whiteboard-1.excalidraw'))
    const read = await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1')
    expect(read).toMatchObject({ scene, fromSource: false })
    expect(Buffer.from(read!.thumbnailBase64!, 'base64').equals(pngBytes)).toBe(true)
    expect(read!.updatedAt).toBeGreaterThan(0)
  })

  it('uses the app folder for a project with no local cwd (cwd-less canvas, SSH project)', async () => {
    const path = await saveWhiteboard({ userDataDir }, 'whiteboard-1', scene)
    expect(pathOf(path)).toBe(join(appWhiteboardsDir(userDataDir), 'whiteboard-1.excalidraw'))
    expect((await readWhiteboard({ userDataDir }, 'whiteboard-1'))?.scene).toBe(scene)
  })

  it('never resurrects a deleted project folder; the board lands in the app folder instead', async () => {
    await rm(projectCwd, { recursive: true, force: true })
    const path = await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene)
    expect(pathOf(path)).toBe(join(appWhiteboardsDir(userDataDir), 'whiteboard-1.excalidraw'))
    await expect(fs.stat(projectCwd)).rejects.toThrow()
  })

  it('falls back to the app folder when the project folder will not take the file', async () => {
    await fs.writeFile(join(projectCwd, '.nodeterm'), 'not a directory')
    const path = await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene)
    expect(pathOf(path)).toBe(join(appWhiteboardsDir(userDataDir), 'whiteboard-1.excalidraw'))
    // ...and a read finds it there, since the project folder has no board.
    expect((await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1'))?.scene).toBe(scene)
  })

  it('refuses any id that could name a path, for both write and read', async () => {
    for (const bad of ['../escape', 'a/b', 'a\\b', '..', '', '.', 42 as unknown as string]) {
      expect(await saveWhiteboard({ projectCwd, userDataDir }, bad, scene)).toBeNull()
      expect(await readWhiteboard({ projectCwd, userDataDir }, bad)).toBeNull()
    }
    expect(await fs.readdir(root)).toEqual(['project'])
  })

  it('refuses a scene over the cap rather than truncating it', async () => {
    const big = 'x'.repeat(WHITEBOARD_SCENE_MAX_BYTES + 1)
    expect(await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', big)).toBeNull()
  })

  it('a copied node reads its source until it saves its own board', async () => {
    await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-orig', scene, png)
    const copy = await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-copy', 'whiteboard-orig')
    expect(copy).toMatchObject({ scene, fromSource: true })

    const edited = JSON.stringify({ type: 'excalidraw', elements: [] })
    await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-copy', edited)
    expect(await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-copy', 'whiteboard-orig')).toMatchObject({
      scene: edited,
      fromSource: false
    })
    // The source is untouched by the copy's save.
    expect((await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-orig'))?.scene).toBe(scene)
  })

  it('ignores an unsafe source id instead of following it', async () => {
    expect(await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', '../../etc/passwd')).toBeNull()
  })

  it('an empty picture means the board was cleared: the old picture is removed, not kept', async () => {
    await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene, png)
    await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene, '')
    expect((await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1'))?.thumbnailBase64).toBeUndefined()
  })

  it('a picture-only read (a board at rest) skips the scene but keeps the picture and revision', async () => {
    await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene, png)
    const rest = await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', undefined, false)
    expect(rest?.scene).toBeUndefined()
    expect(rest?.thumbnailBase64).toBe(png)
    expect(rest?.updatedAt).toBeGreaterThan(0)
  })

  it.skipIf(process.platform === 'win32')(
    'never follows a symlinked board file (a crafted repo cannot point a board at another file)',
    async () => {
      const secret = join(root, 'secret.txt')
      await fs.writeFile(secret, 'private key material')
      const dir = projectWhiteboardsDir(projectCwd)
      await fs.mkdir(dir, { recursive: true })
      await fs.symlink(secret, join(dir, 'whiteboard-evil.excalidraw'))
      await fs.symlink(secret, join(dir, 'whiteboard-evil.png'))
      expect(await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-evil')).toBeNull()
    }
  )

  it('answers null for a board that was never saved (a new, empty board)', async () => {
    expect(await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-new')).toBeNull()
  })
})

// `.nodeterm/` is git-shared, so a cloned repository can commit `.nodeterm/whiteboards` (or
// `.nodeterm` itself) as a symlink to anywhere on this machine. The file-level no-follow read above
// does not cover that: every path component before the file name is still followed.
describe.skipIf(process.platform === 'win32')('the project folder is bound by its real path', () => {
  let outside: string
  beforeEach(async () => {
    outside = join(root, 'outside')
    await fs.mkdir(outside)
  })

  it('a .nodeterm/whiteboards symlink out of the project: nothing is written through it', async () => {
    await fs.mkdir(join(projectCwd, '.nodeterm'))
    await fs.symlink(outside, projectWhiteboardsDir(projectCwd))
    const path = await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene, png)
    expect(pathOf(path)).toBe(join(appWhiteboardsDir(userDataDir), 'whiteboard-1.excalidraw'))
    expect(await fs.readdir(outside)).toEqual([])
  })

  it('a .nodeterm symlink out of the project: no folder is created on the other side', async () => {
    await fs.symlink(outside, join(projectCwd, '.nodeterm'))
    const path = await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene, png)
    expect(pathOf(path)).toBe(join(appWhiteboardsDir(userDataDir), 'whiteboard-1.excalidraw'))
    expect(await fs.readdir(outside)).toEqual([])
  })

  it('a read never follows a symlinked folder out of the project', async () => {
    await fs.writeFile(join(outside, 'whiteboard-x.excalidraw'), scene)
    await fs.writeFile(join(outside, 'whiteboard-x.png'), pngBytes)
    await fs.mkdir(join(projectCwd, '.nodeterm'))
    await fs.symlink(outside, projectWhiteboardsDir(projectCwd))
    expect(await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-x')).toBeNull()
    // ...and neither does a copy's read of its source through the same folder.
    expect(await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-y', 'whiteboard-x')).toBeNull()
  })

  it('a symlink that stays inside the project is followed', async () => {
    await fs.mkdir(join(projectCwd, 'boards'))
    await fs.mkdir(join(projectCwd, '.nodeterm'))
    await fs.symlink(join(projectCwd, 'boards'), projectWhiteboardsDir(projectCwd))
    expect(await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene)).not.toBeNull()
    expect(await fs.readFile(join(projectCwd, 'boards', 'whiteboard-1.excalidraw'), 'utf8')).toBe(scene)
    expect((await readWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1'))?.scene).toBe(scene)
  })

  it('a project folder opened through a symlink still keeps its boards in the project', async () => {
    const linked = join(root, 'linked-project')
    await fs.symlink(projectCwd, linked)
    expect(await saveWhiteboard({ projectCwd: linked, userDataDir }, 'whiteboard-1', scene)).not.toBeNull()
    expect(await fs.readFile(join(projectWhiteboardsDir(projectCwd), 'whiteboard-1.excalidraw'), 'utf8')).toBe(scene)
    expect(await fs.readdir(join(root, 'userData')).catch(() => [])).toEqual([])
  })
})

// A board can be open in two places at once: two Server Edition tabs, the desktop and a browser on
// one folder, two Editors of a hosted team. Each save names the revision its editor last read or
// wrote, and the core refuses a save whose revision is no longer the one on disk — instead of the
// later writer silently replacing the earlier writer's whole board.
describe('compare-and-set: a save made against a stale revision is refused', () => {
  const sceneOf = (tag: string) => JSON.stringify({ type: 'excalidraw', elements: [{ id: tag }] })
  const onDisk = () => fs.readFile(join(projectWhiteboardsDir(projectCwd), 'whiteboard-1.excalidraw'), 'utf8')

  it('the second of two editors that opened the same board cannot overwrite the first', async () => {
    const loc = { projectCwd, userDataDir }
    await saveWhiteboard(loc, 'whiteboard-1', sceneOf('start'))
    const a = await readWhiteboard(loc, 'whiteboard-1')
    const b = await readWhiteboard(loc, 'whiteboard-1')
    expect(a?.rev).toBeTruthy()
    expect(a?.rev).toBe(b?.rev)

    const savedB = await saveWhiteboard(loc, 'whiteboard-1', sceneOf('b'), undefined, b!.rev)
    expect(savedB).toMatchObject({ ok: true })
    const savedA = await saveWhiteboard(loc, 'whiteboard-1', sceneOf('a'), undefined, a!.rev)
    expect(savedA).toMatchObject({ ok: false, conflict: true, currentRev: (savedB as { rev: string }).rev })
    expect(await onDisk()).toBe(sceneOf('b'))
  })

  it('a save returns the new revision, and saving again against it succeeds', async () => {
    const loc = { projectCwd, userDataDir }
    const first = await saveWhiteboard(loc, 'whiteboard-1', sceneOf('1'), undefined, null)
    expect(first).toMatchObject({ ok: true })
    const rev = (first as { rev: string }).rev
    expect((await readWhiteboard(loc, 'whiteboard-1'))?.rev).toBe(rev)
    expect(await saveWhiteboard(loc, 'whiteboard-1', sceneOf('2'), undefined, rev)).toMatchObject({ ok: true })
    expect(await onDisk()).toBe(sceneOf('2'))
  })

  it('a null revision means "I have no board of my own": one that appeared meanwhile is kept', async () => {
    const loc = { projectCwd, userDataDir }
    await saveWhiteboard(loc, 'whiteboard-1', sceneOf('theirs'))
    expect(await saveWhiteboard(loc, 'whiteboard-1', sceneOf('mine'), undefined, null)).toMatchObject({
      ok: false,
      conflict: true
    })
    expect(await onDisk()).toBe(sceneOf('theirs'))
  })

  it('the revision changes on every write, even a same-size rewrite in the same millisecond', async () => {
    const loc = { projectCwd, userDataDir }
    const revs = new Set<string>()
    for (const tag of ['aa', 'bb', 'cc']) {
      const saved = await saveWhiteboard(loc, 'whiteboard-1', sceneOf(tag))
      revs.add((saved as { rev: string }).rev)
    }
    expect(revs.size).toBe(3)
  })

  it('two saves racing in one core are serialized: exactly one of them wins', async () => {
    const loc = { projectCwd, userDataDir }
    const start = await saveWhiteboard(loc, 'whiteboard-1', sceneOf('start'))
    const rev = (start as { rev: string }).rev
    const results = await Promise.all([
      saveWhiteboard(loc, 'whiteboard-1', sceneOf('x'), undefined, rev),
      saveWhiteboard(loc, 'whiteboard-1', sceneOf('y'), undefined, rev)
    ])
    expect(results.filter((r) => r && 'ok' in r && r.ok)).toHaveLength(1)
    expect(results.filter((r) => r && 'conflict' in r)).toHaveLength(1)
  })

  it('no revision at all (an older caller) keeps the unconditional write', async () => {
    const loc = { projectCwd, userDataDir }
    await saveWhiteboard(loc, 'whiteboard-1', sceneOf('one'))
    expect(await saveWhiteboard(loc, 'whiteboard-1', sceneOf('two'))).toMatchObject({ ok: true })
    expect(await onDisk()).toBe(sceneOf('two'))
  })
})

// A folder project can keep its canvas in app data (issue #1145) so that nothing is written into
// the folder. Its boards then live in the project's own app-data root (`appDataProjectRoot` in
// workspace-store.ts), and the folder's boards — drawn before the move — are only ever READ.
describe('a folder project kept in app data', () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = join(userDataDir, 'project-files', 'project-p1')
  })

  it("writes into the project's app-data root, creating it, and nothing into the folder", async () => {
    const loc = { projectCwd: appRoot, createRoot: true, readOnlyRoot: projectCwd, userDataDir }
    const saved = await saveWhiteboard(loc, 'whiteboard-1', scene, png)
    expect(pathOf(saved)).toBe(join(projectWhiteboardsDir(appRoot), 'whiteboard-1.excalidraw'))
    expect(await fs.readdir(projectCwd)).toEqual([])
    expect((await readWhiteboard(loc, 'whiteboard-1'))?.scene).toBe(scene)
  })

  it('a board drawn in the folder before the move still opens, and its next save lands in app data', async () => {
    await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene, png)
    const loc = { projectCwd: appRoot, createRoot: true, readOnlyRoot: projectCwd, userDataDir }

    const before = await readWhiteboard(loc, 'whiteboard-1')
    expect(before).toMatchObject({ scene, fromSource: false })
    const edited = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'b' }] })
    // Saved against the folder file's revision: the compare-and-set sees the same board the read did.
    expect(await saveWhiteboard(loc, 'whiteboard-1', edited, png, before!.rev)).toMatchObject({ ok: true })

    expect((await readWhiteboard(loc, 'whiteboard-1'))?.scene).toBe(edited)
    expect(await fs.readFile(join(projectWhiteboardsDir(projectCwd), 'whiteboard-1.excalidraw'), 'utf8')).toBe(scene)
  })

  it('never writes into the read-only root, even when the app-data root will not take the board', async () => {
    await fs.mkdir(userDataDir, { recursive: true })
    await fs.writeFile(join(userDataDir, 'project-files'), 'not a directory')
    const loc = { projectCwd: appRoot, createRoot: true, readOnlyRoot: projectCwd, userDataDir }
    const saved = await saveWhiteboard(loc, 'whiteboard-1', scene)
    expect(pathOf(saved)).toBe(join(appWhiteboardsDir(userDataDir), 'whiteboard-1.excalidraw'))
    expect(await fs.readdir(projectCwd)).toEqual([])
  })

  it('reads every place a save can land before the read-only root, so a save is never shadowed', async () => {
    // The folder still holds the board as it was before the move…
    await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene)
    // …and the app-data root cannot take the edit, so it falls back to the app folder.
    await fs.mkdir(userDataDir, { recursive: true })
    await fs.writeFile(join(userDataDir, 'project-files'), 'not a directory')
    const loc = { projectCwd: appRoot, createRoot: true, readOnlyRoot: projectCwd, userDataDir }
    const edited = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'b' }] })
    await saveWhiteboard(loc, 'whiteboard-1', edited)
    expect((await readWhiteboard(loc, 'whiteboard-1'))?.scene).toBe(edited)
  })
})

// The move of a folder project's canvas from app data back into its folder (issue #1145) takes the
// boards drawn or edited in app data along: the folder is read first afterwards, and its older file
// of the same board would otherwise hide the newer one.
describe('carryWhiteboards', () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = join(userDataDir, 'project-files', 'project-p1')
  })
  const inFolder = (name: string) => join(projectWhiteboardsDir(projectCwd), name)

  it("copies every board into the folder, replacing the folder's older file, picture byte-exact", async () => {
    const edited = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'edited' }] })
    await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene)
    await saveWhiteboard({ projectCwd: appRoot, createRoot: true, userDataDir }, 'whiteboard-1', edited, png)
    await saveWhiteboard({ projectCwd: appRoot, createRoot: true, userDataDir }, 'whiteboard-2', scene)

    await carryWhiteboards(appRoot, projectCwd)

    expect(await fs.readFile(inFolder('whiteboard-1.excalidraw'), 'utf8')).toBe(edited)
    expect((await fs.readFile(inFolder('whiteboard-1.png'))).equals(pngBytes)).toBe(true)
    expect(await fs.readFile(inFolder('whiteboard-2.excalidraw'), 'utf8')).toBe(scene)
    // The app-data copies stay: nothing is deleted on either side.
    expect(await fs.readFile(join(projectWhiteboardsDir(appRoot), 'whiteboard-1.excalidraw'), 'utf8')).toBe(edited)
  })

  it("a carried board with no picture drops the folder's old picture rather than show it", async () => {
    await saveWhiteboard({ projectCwd, userDataDir }, 'whiteboard-1', scene, png)
    await saveWhiteboard({ projectCwd: appRoot, createRoot: true, userDataDir }, 'whiteboard-1', scene, '')
    await carryWhiteboards(appRoot, projectCwd)
    await expect(fs.stat(inFolder('whiteboard-1.png'))).rejects.toThrow()
  })

  it('does nothing, and creates nothing in the folder, when there is no board to carry', async () => {
    await carryWhiteboards(appRoot, projectCwd)
    expect(await fs.readdir(projectCwd)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('never carries a symlink, and never writes through one', async () => {
    const secret = join(root, 'secret.txt')
    await fs.writeFile(secret, 'private key material')
    const from = projectWhiteboardsDir(appRoot)
    await fs.mkdir(from, { recursive: true })
    await fs.symlink(secret, join(from, 'whiteboard-evil.excalidraw'))
    await carryWhiteboards(appRoot, projectCwd)
    await expect(fs.stat(inFolder('whiteboard-evil.excalidraw'))).rejects.toThrow()

    const outside = join(root, 'outside')
    await fs.mkdir(outside)
    await saveWhiteboard({ projectCwd: appRoot, createRoot: true, userDataDir }, 'whiteboard-1', scene)
    await fs.mkdir(join(projectCwd, '.nodeterm'), { recursive: true })
    await fs.symlink(outside, projectWhiteboardsDir(projectCwd))
    await carryWhiteboards(appRoot, projectCwd)
    expect(await fs.readdir(outside)).toEqual([])
  })
})
