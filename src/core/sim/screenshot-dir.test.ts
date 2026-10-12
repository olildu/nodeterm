import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { testTmpDir } from '../test-tmp'
import { prepareScreenshotParent } from './screenshot-dir'

const ops = { realpath: (p: string) => fsp.realpath(p), mkdir: (p: string, o: { recursive: true }) => fsp.mkdir(p, o) }

describe('prepareScreenshotParent', () => {
  it('creates the missing folders of a screenshot path inside the project', async () => {
    const proj = fs.realpathSync(testTmpDir('simshot-'))
    await prepareScreenshotParent(proj, '.maestro/shots/home.png', ops)
    expect(fs.statSync(path.join(proj, '.maestro', 'shots')).isDirectory()).toBe(true)
    expect(fs.existsSync(path.join(proj, '.maestro', 'shots', 'home.png'))).toBe(false)
  })

  it('does nothing for a folder that exists, an absolute path inside, or no project', async () => {
    const proj = fs.realpathSync(testTmpDir('simshot-'))
    fs.mkdirSync(path.join(proj, 'a'))
    await prepareScreenshotParent(proj, 'a/x.png', ops)
    await prepareScreenshotParent(proj, path.join(proj, 'b', 'x.png'), ops)
    expect(fs.existsSync(path.join(proj, 'b'))).toBe(true)
    await prepareScreenshotParent(undefined, 'zzz/x.png', ops)
    expect(fs.readdirSync(proj).sort()).toEqual(['a', 'b'])
  })

  it('never creates a folder outside the project: `..`, an absolute path elsewhere', async () => {
    const root = fs.realpathSync(testTmpDir('simshot-'))
    const proj = path.join(root, 'proj')
    fs.mkdirSync(proj)
    await prepareScreenshotParent(proj, '../outside/x.png', ops)
    await prepareScreenshotParent(proj, path.join(root, 'elsewhere', 'x.png'), ops)
    expect(fs.readdirSync(root)).toEqual(['proj'])
  })

  it('does not follow a symlink that leads out of the project to make folders there', async () => {
    const root = fs.realpathSync(testTmpDir('simshot-'))
    const proj = path.join(root, 'proj')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(proj)
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(proj, 'shots')) // a committed symlink out of the repo
    await prepareScreenshotParent(proj, 'shots/deep/er/x.png', ops)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('does follow a symlink that stays inside the project', async () => {
    const proj = fs.realpathSync(testTmpDir('simshot-'))
    fs.mkdirSync(path.join(proj, 'real'))
    fs.symlinkSync(path.join(proj, 'real'), path.join(proj, 'link'))
    await prepareScreenshotParent(proj, 'link/new/x.png', ops)
    expect(fs.statSync(path.join(proj, 'real', 'new')).isDirectory()).toBe(true)
  })

  it('swallows an unresolvable project root rather than throwing', async () => {
    await expect(prepareScreenshotParent('/definitely/not/here', 'a/x.png', ops)).resolves.toBeUndefined()
  })
})
