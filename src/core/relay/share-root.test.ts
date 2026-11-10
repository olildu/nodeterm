// Security audit F4: a project whose folder is the disk root or the home directory (or contains it)
// would hand every relay peer every file under it, `~/.ssh` included.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SHARE_ROOT_REFUSAL, shareRootProblem } from './share-root'

const id = (p: string): string => p

describe('shareRootProblem', () => {
  const home = '/home/ada'
  const dataDir = '/home/ada/.config/node-terminal'
  const ask = (cwd: string | undefined) => shareRootProblem(cwd, { home, dataDir, realpath: id })
  it('refuses the disk root, the home directory and every ancestor of it', () => {
    expect(ask('/')).toBe(SHARE_ROOT_REFUSAL.root)
    expect(ask('/home/ada')).toBe(SHARE_ROOT_REFUSAL.home)
    expect(ask('/home/ada/')).toBe(SHARE_ROOT_REFUSAL.home)
    expect(ask('/home')).toBe(SHARE_ROOT_REFUSAL.homeAncestor)
  })
  it('refuses the app data dir and its ancestors below the home', () => {
    expect(ask('/home/ada/.config')).toBe(SHARE_ROOT_REFUSAL.dataDir)
    expect(ask(dataDir)).toBe(SHARE_ROOT_REFUSAL.dataDir)
  })
  it('allows an ordinary project folder, a sibling of the home, and no folder at all', () => {
    expect(ask('/home/ada/code/app')).toBeNull()
    expect(ask('/home/adam')).toBeNull()
    expect(ask('/srv/app')).toBeNull()
    expect(ask(undefined)).toBeNull()
    expect(ask('relative/dir')).toBeNull()
  })
  // POSIX symlinks; on Windows a directory symlink needs privileges the CI runner may not have.
  it.skipIf(process.platform === 'win32')('compares REAL paths: a symlink to the home directory is the home directory', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'share-root-')))
    try {
      const realHome = path.join(tmp, 'home')
      fs.mkdirSync(realHome)
      fs.symlinkSync(realHome, path.join(tmp, 'link'))
      expect(shareRootProblem(path.join(tmp, 'link'), { home: realHome })).toBe(SHARE_ROOT_REFUSAL.home)
      expect(shareRootProblem(realHome, { home: path.join(tmp, 'link') })).toBe(SHARE_ROOT_REFUSAL.home)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
