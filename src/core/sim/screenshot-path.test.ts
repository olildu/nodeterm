import { describe, expect, it } from 'vitest'
import { resolveSimScreenshotPath } from './screenshot-path'

// A tiny fake fs: `links` maps a path to what realpath resolves it to; `dirs` exist.
function fs(dirs: string[], links: Record<string, string> = {}, symTargets: string[] = []) {
  const real = (p: string) => links[p] ?? p
  return {
    realpath: async (p: string) => {
      if (links[p]) return links[p]
      const r = real(p)
      if (!dirs.includes(r) && !dirs.includes(p)) throw new Error('ENOENT')
      return r
    },
    mkdir: async (p: string) => void dirs.push(p.replace('/tmp', '/private/tmp')),
    lstat: async (p: string) => {
      if (symTargets.includes(p)) return { isSymbolicLink: () => true }
      throw new Error('ENOENT')
    }
  }
}
const ROOTS = ['/var/T', '/tmp']

describe('resolveSimScreenshotPath', () => {
  it('accepts a project path and a temp path', async () => {
    const f = fs(['/work', '/var/T', '/private/tmp'], { '/tmp': '/private/tmp' })
    expect(await resolveSimScreenshotPath('/work', ROOTS, 'a.png', f)).toEqual({ ok: true, abs: '/work/a.png' })
    expect(await resolveSimScreenshotPath('/work', ROOTS, '/var/T/x.png', f)).toEqual({ ok: true, abs: '/var/T/x.png' })
    expect(await resolveSimScreenshotPath('/work', ROOTS, '/tmp/x.png', f)).toMatchObject({ ok: true, abs: '/private/tmp/x.png' })
  })
  it('refuses elsewhere, traversal and symlink escapes', async () => {
    const f = fs(['/work', '/var/T', '/etc'], { '/work/link': '/etc' }, ['/work/b.png'])
    expect(await resolveSimScreenshotPath('/work', ROOTS, '/etc/x.png', f)).toMatchObject({ ok: false })
    expect(await resolveSimScreenshotPath('/work', ROOTS, '../etc/x.png', f)).toMatchObject({ ok: false })
    expect(await resolveSimScreenshotPath('/work', ROOTS, 'link/x.png', f)).toMatchObject({ ok: false })
    expect(await resolveSimScreenshotPath('/work', ROOTS, 'b.png', f)).toMatchObject({ ok: false })
  })
  it('works with no project folder', async () => {
    const f = fs(['/var/T'])
    expect(await resolveSimScreenshotPath(undefined, ROOTS, '/var/T/x.png', f)).toMatchObject({ ok: true })
    expect(await resolveSimScreenshotPath(undefined, ROOTS, '/home/x.png', f)).toMatchObject({ ok: false })
  })
})
