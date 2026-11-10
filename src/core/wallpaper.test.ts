import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { wallpapersToKeep } from '../shared/wallpaper'
import {
  aerialClips,
  cachedImagePath,
  listAerials,
  parseAerialManifest,
  scanAerials,
  setWallpaperMediaUrl,
  importWallpaper,
  listStills,
  loadWallpaper,
  pruneWallpaperCache,
  scanStills,
  setWallpaperHostForTests,
  setWallpaperImageOps,
  sipsImageOps,
  windowsWallpaperRoot,
  type WallpaperImageOps
} from './wallpaper'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

const HASH = 'a'.repeat(40)
let root: string | null = null
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = null
})

function put(rel: string, bytes: number): void {
  const p = path.join(root!, rel)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, Buffer.alloc(bytes))
}

describe('scanStills', () => {
  it('finds >1MB stills incl. .wallpapers/*, skips thumbnails/placeholders, scenic first', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'wp-'))
    put('Mac Blue.heic', 2_000_000)
    put('Sonoma.heic', 2_000_000)
    put('.wallpapers/Sonoma Horizon/Sonoma Horizon.heic', 2_000_000)
    put('.wallpapers/Sonoma Horizon/Sonoma Horizon.madesktop', 2_000_000)
    put('.thumbnails/Big.heic', 2_000_000)
    put('Tiny.heic', 1000)
    put('notes.txt', 2_000_000)
    const list = await scanStills(root)
    expect(list.map((s) => s.label)).toEqual(['Sonoma Horizon', 'Sonoma', 'Mac Blue'])
    expect(list[0].id).toBe('mac:.wallpapers/Sonoma Horizon/Sonoma Horizon.heic')
  })

  it('a missing root is an empty list', async () => {
    expect(await scanStills(path.join(tmpdir(), 'no-such-wallpaper-dir-xyz'))).toEqual([])
  })
})

describe('cachedImagePath (the read jail)', () => {
  const cache = path.resolve('/data/wallpapers')
  it('accepts only a hash-named direct child of the cache dir', () => {
    expect(cachedImagePath(path.join(cache, `${HASH}.jpg`), cache)).toBe(path.join(cache, `${HASH}.jpg`))
    expect(cachedImagePath(path.join(cache, `${HASH}-t.jpg`), cache)).not.toBeNull()
  })
  it.each([
    ['traversal', path.join(cache, '..', `${HASH}.jpg`)],
    ['nested', path.join(cache, 'x', `${HASH}.jpg`)],
    ['non-hash name', path.join(cache, 'id_rsa.jpg')],
    ['wrong extension', path.join(cache, `${HASH}.txt`)],
    ['windows-shaped', `C:\\Users\\me\\${HASH}.jpg`],
    ['empty', '']
  ])('refuses %s', (_label, p) => {
    expect(cachedImagePath(p, cache)).toBeNull()
  })
})

describe('importWallpaper', () => {
  it('refuses a file that is not a supported image', async () => {
    await expect(importWallpaper('/etc/passwd')).rejects.toThrow(/JPEG, PNG, WebP or HEIC/)
    await expect(importWallpaper(42)).rejects.toThrow()
  })
})

describe('pruneWallpaperCache', () => {
  it('removes only unreferenced full-size cache files; keeps the kept, thumbs, temps and foreign files', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'wp-cache-'))
    const keep = `${'a'.repeat(40)}.jpg`
    const stale = `${'b'.repeat(40)}.png`
    const thumb = `${'c'.repeat(40)}-t.jpg`
    const temp = `${'d'.repeat(40)}.jpg.123.1.tmp`
    for (const f of [keep, stale, thumb, temp, 'notes.txt']) put(f, 10)
    await pruneWallpaperCache([{ kind: 'image', path: path.join(root, keep) }, { kind: 'none' }], root)
    expect(readdirSync(root).sort()).toEqual([keep, thumb, temp, 'notes.txt'].sort())
  })

  it('choosing a preset keeps the most recent imported image (visual QA H6)', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'wp-cache-'))
    const recent = `${'e'.repeat(40)}.png`
    const older = `${'f'.repeat(40)}.png`
    for (const f of [recent, older]) put(f, 10)
    const next = { kind: 'preset', id: 'gradient:sunrise' }
    await pruneWallpaperCache(wallpapersToKeep({ desktopWallpaper: next, recentWallpaperImage: path.join(root, recent) }), root)
    expect(readdirSync(root)).toEqual([recent])
  })

  it('a missing cache dir is not an error', async () => {
    await expect(pruneWallpaperCache([], path.join(tmpdir(), 'no-such-wp-cache-xyz'))).resolves.toBeUndefined()
    expect(existsSync(path.join(tmpdir(), 'no-such-wp-cache-xyz'))).toBe(false)
  })
})

describe('Windows stills and image ops', () => {
  let ud: string | null = null
  afterEach(() => {
    setWallpaperHostForTests(null)
    resetPlatformForTests()
    if (ud) rmSync(ud, { recursive: true, force: true })
    ud = null
  })

  /** Fake converter: "converts" by writing a marker JPEG; sizes come from a table. */
  function fakeOps(sizes: Record<string, number | null> = {}, canHeic = false): WallpaperImageOps & {
    converted: string[]
  } {
    const converted: string[] = []
    return {
      id: 'fake',
      canHeic,
      convertUnknownSize: false,
      converted,
      longEdge: async (src) => sizes[path.basename(src)] ?? null,
      toJpeg: async (src, px, out) => {
        converted.push(`${path.basename(src)}@${px}`)
        writeFileSync(out, Buffer.from([0xff, 0xd8, 0xff]))
      }
    }
  }

  function windowsHost(): string {
    root = mkdtempSync(path.join(tmpdir(), 'wp-win-'))
    ud = mkdtempSync(path.join(tmpdir(), 'wp-ud-'))
    initPlatform(fakePlatform({ userDataDir: ud }))
    put('Web/Wallpaper/Windows/img0.jpg', 300_000)
    put('Web/Wallpaper/ThemeA/img20.jpg', 300_000)
    put('Web/Wallpaper/Windows/tiny.jpg', 1000)
    return root
  }

  it('scanStills takes a prefix and a size floor for the Windows tree', async () => {
    const r = windowsHost()
    const list = await scanStills(path.join(r, 'Web', 'Wallpaper'), 2, { prefix: 'win:', minBytes: 200_000 })
    expect(list.map((s) => s.id).sort()).toEqual(['win:ThemeA/img20.jpg', 'win:Windows/img0.jpg'])
  })

  it('the Windows root is %WINDIR%\\Web\\Wallpaper, defaulting to C:\\Windows', () => {
    expect(windowsWallpaperRoot({ WINDIR: 'D:\\Win' })).toBe('D:\\Win\\Web\\Wallpaper')
    expect(windowsWallpaperRoot({})).toBe('C:\\Windows\\Web\\Wallpaper')
  })

  it('win32 with no registered ops lists no stills (nothing to thumbnail with)', async () => {
    windowsHost()
    setWallpaperHostForTests({ platform: 'win32', env: { WINDIR: '/nonexistent' } })
    expect(await listStills()).toEqual([])
  })

  it('linux (the Server Edition) lists nothing and refuses an over-cap or HEIC import, as before', async () => {
    windowsHost()
    setWallpaperHostForTests({ platform: 'linux' })
    expect(await listStills()).toEqual([])
    put('photo.heic', 10)
    await expect(importWallpaper(path.join(root!, 'photo.heic'))).rejects.toThrow(/HEIC images can't be converted/)
    put('ok.png', 10)
    const copied = await importWallpaper(path.join(root!, 'ok.png'))
    expect(copied.kind).toBe('image')
  })

  it('with registered ops: oversized images convert, small ones copy, HEIC is refused without canHeic', async () => {
    const r = windowsHost()
    setWallpaperHostForTests({ platform: 'win32' })
    const ops = fakeOps({ 'big.png': 6000, 'small.png': 1920, 'pic.webp': null })
    setWallpaperImageOps(ops)
    put('big.png', 10)
    put('small.png', 10)
    put('pic.webp', 10)
    put('photo.heic', 10)

    const big = await importWallpaper(path.join(r, 'big.png'))
    expect(big.kind === 'image' && big.path.endsWith('.jpg')).toBe(true)
    expect(ops.converted).toEqual(['big.png@3840'])

    const small = await importWallpaper(path.join(r, 'small.png'))
    expect(small.kind === 'image' && small.path.endsWith('.png')).toBe(true)
    // An unmeasurable WebP is copied, not handed to a decoder that cannot read it.
    const webp = await importWallpaper(path.join(r, 'pic.webp'))
    expect(webp.kind === 'image' && webp.path.endsWith('.webp')).toBe(true)
    expect(ops.converted).toEqual(['big.png@3840'])

    await expect(importWallpaper(path.join(r, 'photo.heic'))).rejects.toThrow(/HEIC/)
    expect(ops.converted).toEqual(['big.png@3840'])
  })

  it('a HEIC converts when the ops can decode it', async () => {
    const r = windowsHost()
    setWallpaperHostForTests({ platform: 'win32' })
    const ops = fakeOps({}, true)
    setWallpaperImageOps(ops)
    put('photo.heic', 10)
    const out = await importWallpaper(path.join(r, 'photo.heic'))
    expect(out.kind === 'image' && out.path.endsWith('.jpg')).toBe(true)
    expect(ops.converted).toEqual(['photo.heic@3840'])
  })

  it('win: stills list with thumbnails and load; an id not in the scan is null (the jail)', async () => {
    const r = windowsHost()
    setWallpaperHostForTests({ platform: 'win32', windowsStillsRoot: path.join(r, 'Web', 'Wallpaper') })
    const ops = fakeOps()
    setWallpaperImageOps(ops)

    const list = await listStills()
    expect(list.map((s) => s.id).sort()).toEqual(['win:ThemeA/img20.jpg', 'win:Windows/img0.jpg'])
    expect(list[0].thumb).toMatch(/^data:image\/jpeg;base64,/)
    expect(ops.converted.sort()).toEqual(['img0.jpg@320', 'img20.jpg@320'])

    expect(await loadWallpaper({ kind: 'preset', id: 'win:Windows/img0.jpg' })).toMatch(/^data:image\/jpeg/)
    expect(await loadWallpaper({ kind: 'preset', id: 'win:Windows/../../secret.jpg' })).toBeNull()
    expect(await loadWallpaper({ kind: 'preset', id: 'mac:Sonoma.heic' })).toBeNull()
  })
})

describe('sipsImageOps', () => {
  it('keeps the historical cache-key id and HEIC/unknown-size semantics (macOS byte-identical)', () => {
    // The id feeds cacheKey: `sips3840` is what every pre-seam macOS cache file was named under.
    expect(sipsImageOps.id).toBe('sips')
    expect(sipsImageOps.canHeic).toBe(true)
    expect(sipsImageOps.convertUnknownSize).toBe(true)
  })
})

describe('macOS aerials', () => {
  const L = 'A33A55D9-EDEA-4596-A850-6C10B54FBBB5' // Landscapes
  const C = '5EF41171-4862-4F93-800C-AD86CE5E6891' // Cities
  const [A1, A2, A3, B1] = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444'
  ]
  const manifest = {
    categories: [
      { id: C, localizedNameKey: 'AerialCategoryCities', preferredOrder: 1 },
      { id: L, localizedNameKey: 'AerialCategoryLandscapes', preferredOrder: 0 },
      { id: 'not-a-uuid', localizedNameKey: 'AerialCategoryBad', preferredOrder: 2 }
    ],
    assets: [
      { id: A1, accessibilityLabel: 'Tahoe Night', categories: [L], includeInShuffle: true, preferredOrder: 5 },
      { id: A2, accessibilityLabel: 'Tahoe Day', categories: [L], includeInShuffle: true, preferredOrder: 1 },
      { id: A3, accessibilityLabel: 'Hidden Gem', categories: [L], includeInShuffle: false, preferredOrder: 3 },
      { id: B1, accessibilityLabel: 'Dubai', categories: [C], includeInShuffle: true, preferredOrder: 2 },
      { id: '../../etc/passwd', accessibilityLabel: 'Evil', categories: [L], includeInShuffle: true, preferredOrder: 0 }
    ]
  }
  const url = (p: string): string => `nt-media://media${p}`
  const fixture = (): string => {
    root = mkdtempSync(path.join(tmpdir(), 'aerials-'))
    put('manifest/entries.json', 0)
    writeFileSync(path.join(root, 'manifest/entries.json'), JSON.stringify(manifest))
    for (const id of [A1, A3, B1]) put(`videos/${id}.mov`, 10)
    put(`videos/${A2}.mov.download`, 10) // a partial download is not a clip
    put('videos/notes.txt', 10)
    for (const id of [A1, A2, A3, B1]) put(`thumbnails/${id}.png`, 10)
    setWallpaperHostForTests({ platform: 'darwin', aerialsRoot: root })
    setWallpaperMediaUrl(url)
    return root
  }
  afterEach(() => setWallpaperHostForTests(null))

  it('parses categories and assets by preferredOrder; malformed ids drop', () => {
    const m = parseAerialManifest(manifest)
    expect(m.categories.map((c) => c.label)).toEqual(['Landscapes', 'Cities'])
    expect(m.assets.map((a) => a.label)).toEqual(['Tahoe Day', 'Dubai', 'Hidden Gem', 'Tahoe Night'])
    expect(parseAerialManifest(null)).toEqual({ categories: [], assets: [] })
  })

  it('scan: only <UUID>.mov regular files count as downloaded', async () => {
    const r = fixture()
    const scan = await scanAerials(r)
    expect([...scan!.downloaded].sort()).toEqual([A1, A3, B1].sort())
    expect(scan!.thumbs.size).toBe(4)
    expect(await scanAerials(path.join(r, 'missing'))).toBeNull()
  })

  it('lists a shuffle per category (still = first by preferredOrder), then each downloaded aerial', async () => {
    const r = fixture()
    const list = await listAerials()
    expect(list.map((t) => [t.id, t.label])).toEqual([
      [`aerial-shuffle:${L}`, 'Shuffle Landscapes'],
      [`aerial-shuffle:${C}`, 'Shuffle Cities'],
      [`aerial:${A3}`, 'Hidden Gem'],
      [`aerial:${A1}`, 'Tahoe Night'],
      [`aerial:${B1}`, 'Dubai']
    ])
    expect(list[0].thumb).toBe(url(path.join(r, 'thumbnails', `${A2}.png`)))
  })

  it('shuffle clips: downloaded AND includeInShuffle, re-scanned per call; single = that clip', async () => {
    const r = fixture()
    const video = (id: string): string => url(path.join(r, 'videos', `${id}.mov`))
    expect(await aerialClips({ kind: 'preset', id: `aerial-shuffle:${L}` })).toEqual([video(A1)])
    expect(await aerialClips({ kind: 'preset', id: `aerial:${A3}` })).toEqual([video(A3)])
    put(`videos/${A2}.mov`, 10) // macOS downloaded another one
    expect(await aerialClips({ kind: 'preset', id: `aerial-shuffle:${L}` })).toEqual([video(A2), video(A1)])
  })

  it('the still is the first member thumbnail; unknown ids load nothing', async () => {
    const r = fixture()
    expect(await loadWallpaper({ kind: 'preset', id: `aerial-shuffle:${C}` })).toBe(
      url(path.join(r, 'thumbnails', `${B1}.png`))
    )
    const unknown = { kind: 'preset', id: 'aerial-shuffle:99999999-9999-4999-8999-999999999999' }
    expect(await loadWallpaper(unknown)).toBeNull()
  })

  it('a shuffle with no includeInShuffle clip downloaded plays its own category before any other', async () => {
    const r = fixture()
    const video = (id: string): string => url(path.join(r, 'videos', `${id}.mov`))
    rmSync(path.join(r, 'videos', `${A1}.mov`)) // Landscapes' only shuffle clip; A3 is not in shuffle
    expect(await aerialClips({ kind: 'preset', id: `aerial-shuffle:${L}` })).toEqual([video(A3)])
  })

  it('with none of its own downloaded, any downloaded aerial plays; nothing at all = empty', async () => {
    const r = fixture()
    const video = (id: string): string => url(path.join(r, 'videos', `${id}.mov`))
    rmSync(path.join(r, 'videos', `${B1}.mov`)) // Cities now has nothing downloaded
    expect(await aerialClips({ kind: 'preset', id: `aerial-shuffle:${C}` })).toEqual([video(A3), video(A1)])
    expect(await aerialClips({ kind: 'preset', id: `aerial:${A2}` })).toEqual([video(A3), video(A1)])
    rmSync(path.join(r, 'videos'), { recursive: true, force: true })
    expect(await aerialClips({ kind: 'preset', id: `aerial-shuffle:${L}` })).toEqual([])
  })

  it('off macOS, or with no media URL minter (the Server Edition), there are no aerials', async () => {
    fixture()
    setWallpaperMediaUrl(null)
    expect(await listAerials()).toEqual([])
    expect(await aerialClips({ kind: 'preset', id: `aerial:${A1}` })).toEqual([])
    setWallpaperHostForTests({ platform: 'linux', aerialsRoot: root! })
    setWallpaperMediaUrl(url)
    expect(await listAerials()).toEqual([])
  })
})
