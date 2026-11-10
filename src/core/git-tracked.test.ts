import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { gitTracksFile } from './git-tracked'

// The answer decides whether a file in the user's repo is deleted without asking, so the case that
// matters most is the one that is NOT a clean yes/no: it must come back 'unknown' (= ask first).
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-git-tracked-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('gitTracksFile', () => {
  it('true for a tracked file, false for an untracked one in the same repository', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    await fs.writeFile(path.join(dir, 'tracked.json'), '{}')
    await fs.writeFile(path.join(dir, 'loose.json'), '{}')
    execFileSync('git', ['add', 'tracked.json'], { cwd: dir })
    expect(await gitTracksFile(dir, path.join(dir, 'tracked.json'))).toBe(true)
    expect(await gitTracksFile(dir, path.join(dir, 'loose.json'))).toBe(false)
  })

  it('false in a folder that is not a repository at all', async () => {
    await fs.writeFile(path.join(dir, 'a.json'), '{}')
    // GIT_CEILING_DIRECTORIES keeps git from finding a repository ABOVE the temp dir.
    const prev = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir)
    try {
      expect(await gitTracksFile(dir, path.join(dir, 'a.json'))).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = prev
    }
  })

  it("'unknown' when git could not be asked (here: the folder does not exist)", async () => {
    expect(await gitTracksFile(path.join(dir, 'gone'), path.join(dir, 'gone', 'a.json'))).toBe('unknown')
  })
})
