// Persistence of the transcript index. The path-explicit helpers are exercised directly; the
// refresh loop runs against a LINKED account's config dir in a temp dir. Its other root,
// `~/.claude/projects`, is the run's private home (test/setup/home-sandbox.ts), never the real one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { fakePlatform } from './platform-fake'
import { loadPersistedIndex, persistIndex } from './transcript-index'
import type { TranscriptIndexEntry } from './transcript-index-core'

const entry = (id: string, text: string): TranscriptIndexEntry => ({
  sessionId: id,
  transcriptPath: `/p/${id}.jsonl`,
  cwd: '/c',
  mtime: 1,
  title: id,
  text
})

function errWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code })
}

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nt-transcript-index-'))
  file = join(dir, 'transcript-index.json')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('persistIndex', () => {
  it('round-trips through loadPersistedIndex', async () => {
    const index = [entry('a', 'alpha'), entry('b', 'beta')]
    expect(await persistIndex(file, index)).toBe(true)
    expect(loadPersistedIndex(file)).toEqual(index)
  })

  it('a failure between the temp write and the rename leaves the old index intact', async () => {
    // The bare writeFile this replaced truncated the target first, so dying mid-write left
    // unparseable JSON → an empty index → a ~779 MB, ~3.2 s cold rescan on the next launch.
    const old = [entry('a', 'old text')]
    expect(await persistIndex(file, old)).toBe(true)
    const before = await readFile(file, 'utf8')

    let tempWritten = false
    vi.spyOn(fs, 'rename').mockImplementation((async (from: string) => {
      // The temp really was written in full before the "crash" — the failure is between the two.
      tempWritten = (await readFile(from, 'utf8')).includes('new text')
      throw errWithCode('EIO')
    }) as unknown as typeof fs.rename)

    expect(await persistIndex(file, [entry('a', 'new text'), entry('b', 'more')])).toBe(false)
    expect(tempWritten).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(loadPersistedIndex(file)).toEqual(old)
    // writeFileAtomic removes its own temp on a failure it survives.
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'writes the file 0600 — it holds transcript text (POSIX mode bits; Windows has none to check)',
    async () => {
      await writeFile(file, '[]', { mode: 0o644 }) // the old 0644 file is replaced, not chmod-inherited
      expect(await persistIndex(file, [entry('a', 'x')])).toBe(true)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
  )
})

describe('loadPersistedIndex', () => {
  it('reads missing, truncated or non-array files as an empty index', async () => {
    expect(loadPersistedIndex(file)).toEqual([])
    await writeFile(file, '[{"sessionId":"a","tran')
    expect(loadPersistedIndex(file)).toEqual([])
    await writeFile(file, '{"not":"an array"}')
    expect(loadPersistedIndex(file)).toEqual([])
  })
})

describe('the refresh loop', () => {
  const SID = '0123abcd-0000-4000-8000-00000000000a'
  let cfg: string
  let indexFile: string
  let mod: typeof import('./transcript-index')
  let core: typeof import('./platform')

  /** Writes of the index file's temp: one per persist attempt, landed or not. */
  let indexWrites: string[]
  beforeEach(async () => {
    vi.resetModules() // fresh module state: entries, dirty, the in-flight refresh
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) // the 5-minute timer stays inert
    const platform = fakePlatform()
    core = await import('./platform') // the instance the freshly imported index module will read
    core.initPlatform(platform)
    indexFile = join(platform.userDataDir, 'transcript-index.json')
    cfg = join(dir, 'claude-cfg')
    await fs.mkdir(join(cfg, 'projects', '-proj'), { recursive: true })
    await writeFile(join(cfg, 'projects', '-proj', `${SID}.jsonl`), '{"type":"user","cwd":"/c"}\n')
    indexWrites = []
    const realWriteFile = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation((async (target: string, ...rest: unknown[]) => {
      if (String(target).includes('transcript-index.json')) indexWrites.push(String(target))
      return (realWriteFile as (...a: unknown[]) => Promise<void>)(target, ...rest)
    }) as unknown as typeof fs.writeFile)
    mod = await import('./transcript-index')
  })
  afterEach(() => {
    vi.useRealTimers()
    core.resetPlatformForTests()
  })
  const accounts = () => [{ id: 'linked1', label: 'L', createdAt: 1, configDir: cfg }]

  it('a refresh that changed nothing does not rewrite the index', async () => {
    mod.initTranscriptIndex(accounts)
    await mod.refreshTranscriptIndex()
    expect(indexWrites).toHaveLength(1)
    const ino = (await stat(indexFile)).ino
    await mod.refreshTranscriptIndex()
    await mod.refreshTranscriptIndex()
    expect(indexWrites).toHaveLength(1)
    expect((await stat(indexFile)).ino).toBe(ino)
  })

  it('a write that failed stays owed and is retried on the next refresh, then not again', async () => {
    let failNext = true
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation((async (from: string, to: string) => {
      if (failNext && String(to).endsWith('transcript-index.json')) {
        failNext = false
        throw errWithCode('EIO')
      }
      return realRename(from, to)
    }) as unknown as typeof fs.rename)
    mod.initTranscriptIndex(accounts)
    await mod.refreshTranscriptIndex()
    expect(indexWrites).toHaveLength(1)
    expect(loadPersistedIndex(indexFile)).toEqual([])
    // Nothing on disk changed, but the index the file is missing is still owed to it.
    await mod.refreshTranscriptIndex()
    expect(indexWrites).toHaveLength(2)
    expect(loadPersistedIndex(indexFile).map((e) => e.sessionId)).toEqual([SID])
    await mod.refreshTranscriptIndex()
    expect(indexWrites).toHaveLength(2)
  })

  it('a refresh asked for while one is running joins it instead of scanning again', async () => {
    const root = join(cfg, 'projects')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const realReaddir = fs.readdir.bind(fs)
    let rootScans = 0
    vi.spyOn(fs, 'readdir').mockImplementation((async (p: string, ...rest: unknown[]) => {
      if (String(p) === root) {
        rootScans++
        await gate
      }
      return (realReaddir as (...a: unknown[]) => Promise<unknown>)(p, ...rest)
    }) as unknown as typeof fs.readdir)
    mod.initTranscriptIndex(accounts) // starts the launch refresh, held at the linked root
    await vi.waitFor(() => expect(rootScans).toBe(1))
    const a = mod.refreshTranscriptIndex()
    const b = mod.refreshTranscriptIndex()
    vi.advanceTimersByTime(5 * 60 * 1000) // the interval firing mid-scan joins it too
    release()
    await Promise.all([a, b])
    expect(rootScans).toBe(1)
    expect(indexWrites).toHaveLength(1)
  })
})
