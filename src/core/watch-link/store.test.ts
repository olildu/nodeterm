import { describe, it, expect, vi } from 'vitest'
import { promises as fsp, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { testTmpDir } from '../test-tmp'
import { renameAtomic, writeFileAtomic } from '../fs-atomic'
import { WatchLinkStore, WatchLinkStoreUnreadable, type WatchLinkRecord } from './store'
import { hashControlPassword } from './password'

// Pass-through spies, so a test can hold one write open (ordering), fail one (chain recovery,
// set-aside failure) or count them (a latched store must not write at all).
vi.mock('../fs-atomic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fs-atomic')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic), renameAtomic: vi.fn(actual.renameAtomic) }
})

const file = () => join(testTmpDir('wl-'), 'watch-links.json')
// Computed once: two `rec()` calls a millisecond apart must still compare equal.
const EXPIRES_AT = Date.now() + 3600_000
const rec = (over: Partial<WatchLinkRecord> = {}): WatchLinkRecord => ({
  linkId: 'AbCdEfGhIjKlMnOpQrStUv', nodeId: 'n1', role: 'viewer', label: 'Ada', title: 'build',
  createdAt: 1, expiresAt: EXPIRES_AT, secret: new Uint8Array(32).fill(7), ...over
})
const seal = (b: Buffer) => Buffer.from(b.toString('hex'))
const unseal = (b: Buffer) => Buffer.from(b.toString(), 'hex')

// The shape of the real desktop seam (src/main/platform-electron.ts): safeStorage encrypts the
// buffer's UTF-8 TEXT and decrypts back to text. Reversing the code points stands in for the cipher;
// what matters is the two UTF-8 conversions, which mangle any byte sequence that is not valid UTF-8.
const reverseText = (s: string) => [...s].reverse().join('')
const electronSeal = (b: Buffer) => Buffer.from(reverseText(b.toString('utf8')), 'utf8')
const electronUnseal = (b: Buffer) => Buffer.from(reverseText(b.toString('utf8')), 'utf8')
// 0x80..0x9f: every byte a lone UTF-8 continuation byte, so `toString('utf8')` replaces each one.
const HIGH_BYTES = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i)

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const rawEntry = (over: Record<string, unknown> = {}) => ({
  linkId: 'AbCdEfGhIjKlMnOpQrStUv', nodeId: 'n1', role: 'viewer', label: 'Ada', title: 'build',
  createdAt: 1, expiresAt: EXPIRES_AT, secret: b64(new Uint8Array(32).fill(7)), sealed: false, ...over
})
const writeLinks = (f: string, links: unknown[], v: unknown = 1) => writeFileSync(f, JSON.stringify({ v, links }))

describe('WatchLinkStore', () => {
  it('round-trips sealed records and writes 0600', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f, seal, unseal })
    expect(await s.save([rec()])).toBe('saved')
    expect(await s.load()).toEqual([rec()])
    expect(readFileSync(f, 'utf8')).not.toContain(Buffer.from(new Uint8Array(32).fill(7)).toString('base64'))
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  it('round-trips a high-byte secret through an Electron-shaped (UTF-8 text) seam', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f, seal: electronSeal, unseal: electronUnseal })
    const r = rec({ secret: HIGH_BYTES })
    expect(await s.save([r])).toBe('saved')
    expect(await new WatchLinkStore({ file: f, seal: electronSeal, unseal: electronUnseal }).load()).toEqual([r])
  })

  it('stores raw secrets where the platform has no seal (Server Edition)', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f })
    expect(await s.save([rec()])).toBe('saved')
    expect(await s.load()).toEqual([rec()])
    expect(await s.save([rec({ secret: HIGH_BYTES })])).toBe('saved')
    expect(await s.load()).toEqual([rec({ secret: HIGH_BYTES })])
  })

  it('writes an empty file and reports memory-only when sealing throws', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f, seal: () => { throw new Error('locked') }, unseal })
    expect(await s.save([rec()])).toBe('memory-only')
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ v: 1, links: [] })
  })

  it('reports a non-seal error while building the file as failed, and leaves the old file intact', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f, seal, unseal })
    expect(await s.save([rec()])).toBe('saved')
    const before = readFileSync(f, 'utf8')
    const broken = { ...rec({ linkId: 'BbCdEfGhIjKlMnOpQrStUv' }), secret: undefined } as unknown as WatchLinkRecord
    expect(await s.save([rec(), broken])).toBe('failed')
    expect(readFileSync(f, 'utf8')).toBe(before)
  })

  it('an unsealable secret is skipped, and a desktop never accepts a raw one', async () => {
    const f = file()
    await new WatchLinkStore({ file: f }).save([rec()]) // raw on disk
    const desktop = new WatchLinkStore({ file: f, seal, unseal: () => { throw new Error('keychain reset') } })
    expect(await desktop.load()).toEqual([])
    const f2 = file()
    await new WatchLinkStore({ file: f2, seal, unseal }).save([rec()])
    expect(await new WatchLinkStore({ file: f2, seal, unseal: () => { throw new Error('reset') } }).load()).toEqual([])
  })

  it('tolerates a missing or corrupt file and drops malformed entries', async () => {
    const f = file()
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([])
    writeFileSync(f, '{nope')
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([])
    writeFileSync(f, JSON.stringify({ v: 1, links: [{ linkId: 'bad', nodeId: 'n', role: 'viewer', secret: 'AA==', sealed: false }] }))
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([])
  })

  it('drops an entry whose node id is not a safe node id', async () => {
    const f = file()
    writeLinks(f, [
      rawEntry({ nodeId: '../x', linkId: 'A1CdEfGhIjKlMnOpQrStUv' }),
      rawEntry({ nodeId: 'a b', linkId: 'A2CdEfGhIjKlMnOpQrStUv' }),
      rawEntry({ nodeId: 'x'.repeat(129), linkId: 'A3CdEfGhIjKlMnOpQrStUv' }),
      rawEntry({ nodeId: 12, linkId: 'A4CdEfGhIjKlMnOpQrStUv' }),
      rawEntry({ nodeId: ['n1'], linkId: 'A5CdEfGhIjKlMnOpQrStUv' }),
      rawEntry()
    ])
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([rec()])
  })

  it('drops a secret of the wrong length, sealed and unsealed', async () => {
    // Each bad entry is otherwise valid, so nothing but the length check can reject it.
    const f = file()
    writeLinks(f, [rawEntry({ linkId: 'ShortRawGhIjKlMnOpQrSt', secret: b64(new Uint8Array(1).fill(7)) }), rawEntry()])
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([rec()])

    const f2 = file()
    const sealB64 = (bytes: Uint8Array) => seal(Buffer.from(b64(bytes), 'utf8')).toString('base64')
    writeLinks(f2, [
      rawEntry({ linkId: 'ShortSealIjKlMnOpQrStUv'.slice(0, 22), secret: sealB64(new Uint8Array(31).fill(7)), sealed: true }),
      rawEntry({ linkId: 'LongSealhIjKlMnOpQrStUv'.slice(0, 22), secret: sealB64(new Uint8Array(33).fill(7)), sealed: true }),
      rawEntry({ secret: sealB64(new Uint8Array(32).fill(7)), sealed: true })
    ])
    expect(await new WatchLinkStore({ file: f2, seal, unseal }).load()).toEqual([rec()])
  })

  it('returns at most 200 entries', async () => {
    const f = file()
    const id = (i: number) => `L${String(i).padStart(21, '0')}`
    writeLinks(f, Array.from({ length: 250 }, (_, i) => rawEntry({ linkId: id(i) })))
    const loaded = await new WatchLinkStore({ file: f }).load()
    expect(loaded).toHaveLength(200)
    expect(loaded[199].linkId).toBe(id(199))
  })

  it('sets an unparseable file aside and stays writable', async () => {
    const f = file()
    writeFileSync(f, '{nope')
    const s = new WatchLinkStore({ file: f })
    expect(await s.load()).toEqual([])
    expect(existsSync(f)).toBe(false)
    const aside = readdirSync(dirname(f)).filter((n) => n.startsWith('watch-links.json.corrupt-'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dirname(f), aside[0]), 'utf8')).toBe('{nope')
    expect(await s.save([rec()])).toBe('saved')
    expect(await s.load()).toEqual([rec()])
  })

  it('sets aside JSON that is not an object ([] or null) and stays writable', async () => {
    for (const body of ['[]', 'null']) {
      const f = file()
      writeFileSync(f, body)
      const s = new WatchLinkStore({ file: f })
      expect(await s.load()).toEqual([])
      expect(existsSync(f)).toBe(false)
      const aside = readdirSync(dirname(f)).filter((n) => n.startsWith('watch-links.json.corrupt-'))
      expect(aside).toHaveLength(1)
      expect(readFileSync(join(dirname(f), aside[0]), 'utf8')).toBe(body)
      expect(await s.save([rec()])).toBe('saved')
      expect(await s.load()).toEqual([rec()])
    }
  })

  describe('never writes over a file it could not read', () => {
    const expectLatched = async (s: WatchLinkStore, f: string, before: string) => {
      const writes = vi.mocked(writeFileAtomic).mock.calls.length
      expect(await s.save([])).toBe('failed')
      expect(await s.save([rec()])).toBe('failed')
      expect(vi.mocked(writeFileAtomic).mock.calls.length).toBe(writes)
      expect(readFileSync(f, 'utf8')).toBe(before)
    }

    it('a read error other than ENOENT rejects and latches the store', async () => {
      const f = file()
      expect(await new WatchLinkStore({ file: f }).save([rec()])).toBe('saved')
      const before = readFileSync(f, 'utf8')
      const eio = Object.assign(new Error('EIO: i/o error, open'), { code: 'EIO' })
      const open = vi.spyOn(fsp, 'open').mockRejectedValueOnce(eio)
      const s = new WatchLinkStore({ file: f })
      await expect(s.load()).rejects.toBeInstanceOf(WatchLinkStoreUnreadable)
      open.mockRestore()
      await expectLatched(s, f, before)
    })

    it('a path that cannot be read as a file (a directory) rejects', async () => {
      const f = file()
      mkdirSync(f)
      const s = new WatchLinkStore({ file: f })
      await expect(s.load()).rejects.toBeInstanceOf(WatchLinkStoreUnreadable)
      expect(await s.save([rec()])).toBe('failed')
      expect(statSync(f).isDirectory()).toBe(true)
    })

    it('a file larger than 1 MiB rejects and latches the store', async () => {
      const f = file()
      writeLinks(f, [rawEntry({ pad: 'x'.repeat(1024 * 1024) })])
      const before = readFileSync(f, 'utf8')
      const s = new WatchLinkStore({ file: f })
      await expect(s.load()).rejects.toBeInstanceOf(WatchLinkStoreUnreadable)
      await expectLatched(s, f, before)
    })

    it('a version other than 1 rejects and latches the store', async () => {
      const f = file()
      writeLinks(f, [rawEntry()], 2)
      const before = readFileSync(f, 'utf8')
      const s = new WatchLinkStore({ file: f })
      await expect(s.load()).rejects.toBeInstanceOf(WatchLinkStoreUnreadable)
      await expectLatched(s, f, before)
    })

    it('a save issued while load() is pending waits for it (real {"v":2} file)', async () => {
      const f = file()
      writeLinks(f, [rawEntry()], 2)
      const before = readFileSync(f, 'utf8')
      const s = new WatchLinkStore({ file: f })
      const loading = s.load()
      const saving = s.save([])
      await expect(loading).rejects.toBeInstanceOf(WatchLinkStoreUnreadable)
      expect(await saving).toBe('failed')
      expect(readFileSync(f, 'utf8')).toBe(before)
    })

    it('a save issued while a slow read is held waits for its verdict', async () => {
      const f = file()
      expect(await new WatchLinkStore({ file: f }).save([rec()])).toBe('saved')
      const before = readFileSync(f, 'utf8')
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      const eacces = Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' })
      const open = vi.spyOn(fsp, 'open').mockImplementationOnce(async () => {
        await gate // the read is still in flight when the save arrives
        throw eacces
      })
      const writes = vi.mocked(writeFileAtomic).mock.calls.length
      const s = new WatchLinkStore({ file: f })
      const loading = s.load()
      const saving = s.save([])
      for (let i = 0; i < 10; i++) await Promise.resolve() // microtasks only, no timers
      expect(vi.mocked(writeFileAtomic).mock.calls.length).toBe(writes) // nothing written yet
      release()
      await expect(loading).rejects.toBeInstanceOf(WatchLinkStoreUnreadable)
      open.mockRestore()
      expect(await saving).toBe('failed')
      expect(vi.mocked(writeFileAtomic).mock.calls.length).toBe(writes)
      expect(readFileSync(f, 'utf8')).toBe(before)
    })

    it('an unparseable file that cannot be set aside rejects and latches the store', async () => {
      const f = file()
      writeFileSync(f, '{nope')
      vi.mocked(renameAtomic).mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
      const s = new WatchLinkStore({ file: f })
      await expect(s.load()).rejects.toBeInstanceOf(WatchLinkStoreUnreadable)
      await expectLatched(s, f, '{nope')
    })
  })

  it('serializes saves: an older snapshot never lands after a newer one', async () => {
    // A revoke is a save of the smaller list. If two writes overlap and finish out of order, the
    // OLDER snapshot is what stays on disk — and the revoked link comes back at the next boot.
    const f = file()
    const s = new WatchLinkStore({ file: f })
    const { writeFileAtomic: realWrite } = await vi.importActual<typeof import('../fs-atomic')>('../fs-atomic')
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let bLanded!: () => void
    const bDone = new Promise<void>((r) => { bLanded = r })
    vi.mocked(writeFileAtomic)
      .mockImplementationOnce(async (...args) => {
        events.push('a:start')
        await gate // the FIRST write is held until the test releases it
        await realWrite(...args)
        events.push('a:end')
      })
      .mockImplementationOnce(async (...args) => {
        events.push('b:start')
        await realWrite(...args)
        events.push('b:end')
        bLanded()
      })
    const a = s.save([rec()])
    const b = s.save([])
    // Let already-scheduled work run (microtasks only, no timers). Serialized, the second write has
    // still not been called: it waits on the held first one. If it has (the bug), let it land
    // before releasing the first, so the out-of-order finish is certain rather than a race.
    for (let i = 0; i < 10; i++) await Promise.resolve()
    if (events.includes('b:start')) await bDone
    release()
    expect(await a).toBe('saved')
    expect(await b).toBe('saved')
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ v: 1, links: [] })
    expect(await s.load()).toEqual([])
  })

  it('a failed save does not break the chain for the next one', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f })
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(new Error('EPERM'))
    const a = s.save([rec()])
    const b = s.save([rec({ label: 'Bob' })])
    expect(await a).toBe('failed')
    expect(await b).toBe('saved')
    expect(await s.load()).toEqual([rec({ label: 'Bob' })])
  })
})

// Ruling R42(b): an entry whose SEALED secret cannot be unsealed this run (the keychain is locked at
// login, or was reset) is not evidence that the link is gone. The store keeps it verbatim — never
// returned by load(), never erased by a save — until its own expiresAt passes. Only then is it dropped.
describe('opaque entries (a sealed secret this run cannot unseal)', () => {
  const locked = () => {
    throw new Error('keychain locked')
  }
  const other = rec({ linkId: 'OtherLinkIjKlMnOpQrStU', label: 'Bob' })

  it('survives a save verbatim and comes back once the keychain answers again', async () => {
    const f = file()
    expect(await new WatchLinkStore({ file: f, seal, unseal }).save([rec()])).toBe('saved')
    const sealedEntry = JSON.parse(readFileSync(f, 'utf8')).links[0]

    // This run: the keychain refuses. The link is not returned (it cannot be hosted without its secret).
    const s = new WatchLinkStore({ file: f, seal, unseal: locked })
    expect(await s.load()).toEqual([])
    // A save of this run's own links (a new one) must not erase it.
    expect(await s.save([other])).toBe('saved')
    const onDisk = JSON.parse(readFileSync(f, 'utf8')).links as Record<string, unknown>[]
    expect(onDisk).toHaveLength(2)
    expect(onDisk.find((e) => e.linkId === rec().linkId)).toEqual(sealedEntry)
    // An empty save (every live link revoked) keeps it too.
    expect(await s.save([])).toBe('saved')
    expect(JSON.parse(readFileSync(f, 'utf8')).links).toEqual([sealedEntry])

    // Next run the keychain answers: the link is back, secret intact.
    expect(await new WatchLinkStore({ file: f, seal, unseal }).load()).toEqual([rec()])
  })

  it('is dropped by the first save after its own expiresAt', async () => {
    const f = file()
    expect(await new WatchLinkStore({ file: f, seal, unseal }).save([rec()])).toBe('saved')
    let t = EXPIRES_AT - 1
    const s = new WatchLinkStore({ file: f, seal, unseal: locked, now: () => t })
    expect(await s.load()).toEqual([])
    expect(await s.save([])).toBe('saved')
    expect(JSON.parse(readFileSync(f, 'utf8')).links).toHaveLength(1)
    t = EXPIRES_AT
    expect(await s.save([])).toBe('saved')
    expect(JSON.parse(readFileSync(f, 'utf8')).links).toEqual([])
    // Gone for good: time going back does not bring it back.
    t = EXPIRES_AT - 1
    expect(await s.save([])).toBe('saved')
    expect(JSON.parse(readFileSync(f, 'utf8')).links).toEqual([])
  })

  it('a live record with the same id wins over the opaque copy (never two entries for one link)', async () => {
    const f = file()
    expect(await new WatchLinkStore({ file: f, seal, unseal }).save([rec()])).toBe('saved')
    const s = new WatchLinkStore({ file: f, seal, unseal: locked })
    expect(await s.load()).toEqual([])
    expect(await s.save([rec({ label: 'Live' })])).toBe('saved')
    const links = JSON.parse(readFileSync(f, 'utf8')).links as Record<string, unknown>[]
    expect(links).toHaveLength(1)
    expect(links[0].label).toBe('Live')
  })

  it('is kept when sealing fails too (memory-only writes no live link, but never erases one it could not read)', async () => {
    const f = file()
    expect(await new WatchLinkStore({ file: f, seal, unseal }).save([rec()])).toBe('saved')
    const sealedEntry = JSON.parse(readFileSync(f, 'utf8')).links[0]
    const s = new WatchLinkStore({ file: f, seal: locked, unseal: locked })
    expect(await s.load()).toEqual([])
    expect(await s.save([other])).toBe('memory-only')
    expect(JSON.parse(readFileSync(f, 'utf8')).links).toEqual([sealedEntry])
  })

  it('opaqueCount() counts the ones still carried: not past their expiry, not discarded', async () => {
    const f = file()
    expect(await new WatchLinkStore({ file: f, seal, unseal }).save([rec(), other])).toBe('saved')
    let t = EXPIRES_AT - 1
    const s = new WatchLinkStore({ file: f, seal, unseal: locked, now: () => t })
    expect(s.opaqueCount()).toBe(0)
    await s.load()
    expect(s.opaqueCount()).toBe(2)
    t = EXPIRES_AT
    expect(s.opaqueCount()).toBe(0)
    t = EXPIRES_AT - 1
    s.discardOpaque()
    expect(s.opaqueCount()).toBe(0)
  })

  it('discardOpaque() drops them from the next save ("Stop all": the server revoked them)', async () => {
    const f = file()
    expect(await new WatchLinkStore({ file: f, seal, unseal }).save([rec()])).toBe('saved')
    const s = new WatchLinkStore({ file: f, seal, unseal: locked })
    expect(await s.load()).toEqual([])
    s.discardOpaque()
    expect(await s.save([])).toBe('saved')
    expect(JSON.parse(readFileSync(f, 'utf8')).links).toEqual([])
  })

  it('only a sealed entry the keychain REFUSED is opaque: a malformed or raw-on-desktop one is still dropped', async () => {
    const f = file()
    const sealB64 = (bytes: Uint8Array) => seal(Buffer.from(b64(bytes), 'utf8')).toString('base64')
    writeLinks(f, [
      // Unsealed fine, but the wrong length: malformed, not a keychain problem.
      rawEntry({ linkId: 'ShortSealIjKlMnOpQrStU', secret: sealB64(new Uint8Array(31).fill(7)), sealed: true }),
      // A raw secret on a desktop is never adopted.
      rawEntry({ linkId: 'RawOnDesktopKlMnOpQrSt' })
    ])
    const s = new WatchLinkStore({ file: f, seal, unseal })
    expect(await s.load()).toEqual([])
    expect(await s.save([])).toBe('saved')
    expect(JSON.parse(readFileSync(f, 'utf8')).links).toEqual([])
  })
})

// Ruling R45: when the keychain starts refusing to SEAL mid-run, the links this run already holds a
// sealed form of — read at boot, or sealed by an earlier write — are written with that ciphertext; only
// a link that was never sealed is left out ('memory-only'). Writing no live link at all lost every
// link loaded fine at boot, and writing nothing would keep a link stopped offline on disk (hosted again
// at the next launch). A link no longer in the list is still dropped.
describe('a keychain that stops sealing mid-run (R45)', () => {
  const a = rec({ linkId: 'AaaaEfGhIjKlMnOpQrStUv', secret: new Uint8Array(32).fill(1) })
  const b = rec({ linkId: 'BbbbEfGhIjKlMnOpQrStUv', secret: new Uint8Array(32).fill(2) })
  const c = rec({ linkId: 'CcccEfGhIjKlMnOpQrStUv', secret: new Uint8Array(32).fill(3) })
  const switchable = () => {
    const state = { refuse: false }
    const flaky = (b: Buffer) => {
      if (state.refuse) throw new Error('keychain locked')
      return seal(b)
    }
    return { state, flaky }
  }
  const ids = (f: string) => (JSON.parse(readFileSync(f, 'utf8')).links as { linkId: string }[]).map((e) => e.linkId)

  it('boot-loaded links survive it with the ciphertext they were read with; a revoked one is gone; a new one is not written', async () => {
    const f = file()
    expect(await new WatchLinkStore({ file: f, seal, unseal }).save([a, b])).toBe('saved')
    const before = JSON.parse(readFileSync(f, 'utf8')).links
    const k = switchable()
    const s = new WatchLinkStore({ file: f, seal: k.flaky, unseal })
    expect(await s.load()).toEqual([a, b])
    k.state.refuse = true
    expect(await s.save([a, b])).toBe('saved') // everything it holds is on disk: nothing is memory-only
    expect(JSON.parse(readFileSync(f, 'utf8')).links).toEqual(before)
    expect(await s.save([a])).toBe('saved') // b stopped: gone from the file, not resurrected
    expect(ids(f)).toEqual([a.linkId])
    expect(await s.save([a, c])).toBe('memory-only') // c was never sealed: left out, a kept
    expect(ids(f)).toEqual([a.linkId])
    // Next launch, keychain back: a resumes; b (stopped) and c (never written) do not.
    expect(await new WatchLinkStore({ file: f, seal, unseal }).load()).toEqual([a])
  })

  it('a link sealed by an earlier write this run survives it too', async () => {
    const f = file()
    const k = switchable()
    const s = new WatchLinkStore({ file: f, seal: k.flaky, unseal })
    expect(await s.save([c])).toBe('saved')
    k.state.refuse = true
    expect(await s.save([c, b])).toBe('memory-only')
    expect(ids(f)).toEqual([c.linkId])
    expect(await new WatchLinkStore({ file: f, seal, unseal }).load()).toEqual([c])
  })

  it('a sealed form is reused only for the SAME secret', async () => {
    const f = file()
    const k = switchable()
    const s = new WatchLinkStore({ file: f, seal: k.flaky, unseal })
    expect(await s.save([a])).toBe('saved')
    k.state.refuse = true
    expect(await s.save([{ ...a, secret: new Uint8Array(32).fill(9) }])).toBe('memory-only')
    expect(ids(f)).toEqual([])
  })

  it('keeps a sealed form only for the links in the last saved list (a stopped link\'s form is dropped)', async () => {
    const f = file()
    const k = switchable()
    const s = new WatchLinkStore({ file: f, seal: k.flaky, unseal })
    expect(await s.save([a, b])).toBe('saved')
    expect(await s.save([a])).toBe('saved') // b stopped
    k.state.refuse = true
    // b again (same id, same secret): its form was dropped with it, so it needs sealing — refused.
    expect(await s.save([a, b])).toBe('memory-only')
    expect(ids(f)).toEqual([a.linkId])
  })

  it('holds a DIGEST of each secret, never its text or bytes', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f, seal, unseal })
    await s.save([a, c])
    await s.load()
    const held = JSON.stringify([...(s as unknown as { sealedForms: Map<string, unknown> }).sealedForms])
    for (const r of [a, c]) {
      expect(held).not.toContain(Buffer.from(r.secret).toString('base64'))
      expect(held).not.toContain(Buffer.from(r.secret).toString('hex'))
    }
    expect(held).toContain(createHash('sha256').update(a.secret).digest('hex'))
  })

  it('never re-seals a secret it already holds sealed (the file does not churn on every write)', async () => {
    const f = file()
    let seals = 0
    const counting = (b: Buffer) => {
      seals++
      return seal(b)
    }
    const s = new WatchLinkStore({ file: f, seal: counting, unseal })
    await s.save([a])
    await s.save([a, b])
    await s.save([a, b])
    expect(seals).toBe(2)
  })
})

// A Control link's record carries `control` (the password's scrypt hash and the lock), and an
// Unlimited link's `expiresAt` is null. `control` is present IFF the role is 'controller': a
// hand-edited file cannot give a viewer link a password, and a controller link without one is dropped.
describe('controller records and unlimited expiry', () => {
  const SALT = b64(new Uint8Array(16).fill(1))
  const HASH = b64(new Uint8Array(32).fill(2))
  const control = { enabled: true, salt: SALT, hash: HASH, locked: false, wrong: 0, lockedUntil: null, lockStep: 0 }
  const ctl = (over: Partial<WatchLinkRecord> = {}) => rec({ role: 'controller', control, expiresAt: null, ...over })

  it('round-trips a controller record with no expiry through save and a fresh store', async () => {
    for (const opts of [{ seal, unseal }, {}]) {
      const f = file()
      expect(await new WatchLinkStore({ file: f, ...opts }).save([ctl()])).toBe('saved')
      expect(await new WatchLinkStore({ file: f, ...opts }).load()).toEqual([ctl()])
    }
    const f = file()
    const locked = ctl({ control: { enabled: false, salt: SALT, hash: HASH, locked: true, wrong: 10, lockedUntil: null, lockStep: 0 } })
    expect(await new WatchLinkStore({ file: f, seal, unseal }).save([locked])).toBe('saved')
    expect(await new WatchLinkStore({ file: f, seal, unseal }).load()).toEqual([locked])
  })

  it('drops a controller entry without control, and a viewer or commenter entry that carries one', async () => {
    const f = file()
    writeLinks(f, [
      rawEntry({ linkId: 'NoControlIjKlMnOpQrStU', role: 'controller' }),
      rawEntry({ linkId: 'NullControlKlMnOpQrStU', role: 'controller', control: null }),
      rawEntry({ linkId: 'ViewerPwdhIjKlMnOpQrSt', role: 'viewer', control }),
      rawEntry({ linkId: 'CommentPwdIjKlMnOpQrSt', role: 'commenter', control }),
      rawEntry({ linkId: 'ViewerNullIjKlMnOpQrSt', role: 'viewer', control: null }),
      rawEntry({ role: 'controller', control, expiresAt: null })
    ])
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([ctl()])
  })

  it('drops a controller entry whose control is malformed', async () => {
    const id = (i: number) => `Bad${String(i).padStart(19, '0')}`
    const bad: unknown[] = [
      'x',
      [],
      7,
      { ...control, salt: b64(new Uint8Array(15).fill(1)) },
      { ...control, salt: b64(new Uint8Array(17).fill(1)) },
      { ...control, hash: b64(new Uint8Array(31).fill(2)) },
      { ...control, hash: b64(new Uint8Array(33).fill(2)) },
      // Node's base64 decoder skips characters it does not know: only canonical text is accepted.
      { ...control, salt: `!${SALT}` },
      { ...control, hash: `${HASH.slice(0, 20)}*${HASH.slice(20)}` },
      { ...control, salt: SALT.replace(/=+$/, '') },
      { ...control, salt: 7 },
      { ...control, hash: null },
      { enabled: true, salt: SALT, locked: false },
      { ...control, enabled: 'true' },
      { ...control, enabled: 1 },
      { ...control, locked: 'false' },
      { salt: SALT, hash: HASH, locked: false },
      { enabled: true, salt: SALT, hash: HASH },
      // The link-wide wrong count (final review, Minor 2): an integer 0..10 when present.
      { ...control, wrong: 11 },
      { ...control, wrong: -1 },
      { ...control, wrong: 1.5 },
      { ...control, wrong: '3' },
      { ...control, wrong: null },
      { ...control, wrong: Number.MAX_SAFE_INTEGER },
      // When a lock lifts (finding L2): null or a finite epoch ms ≥ 0; how many locks: 0..16.
      { ...control, locked: true, lockedUntil: -1 },
      { ...control, locked: true, lockedUntil: '1700000000000' },
      { ...control, locked: true, lockedUntil: {} },
      { ...control, lockStep: -1 },
      { ...control, lockStep: 17 },
      { ...control, lockStep: 1.5 },
      { ...control, lockStep: '2' },
      { ...control, lockStep: null }
    ]
    const f = file()
    writeLinks(f, [...bad.map((c, i) => rawEntry({ linkId: id(i), role: 'controller', control: c, expiresAt: null })), rawEntry()])
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([rec()])
  })

  // Final review, Minor 2: the link-wide wrong-attempt count is persisted beside `locked`, so an app
  // restart no longer resets it. A file written before it existed has no `wrong`: it reads as 0.
  it('round-trips the link-wide wrong count, and reads a control written without one (an older file) as 0', async () => {
    for (const opts of [{ seal, unseal }, {}]) {
      const f = file()
      const seven = ctl({ control: { ...control, wrong: 7 } })
      expect(await new WatchLinkStore({ file: f, ...opts }).save([seven])).toBe('saved')
      expect(await new WatchLinkStore({ file: f, ...opts }).load()).toEqual([seven])
    }
    const f = file()
    const older = { enabled: true, salt: SALT, hash: HASH, locked: false }
    writeLinks(f, [rawEntry({ role: 'controller', expiresAt: null, control: older })])
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([ctl()])
  })

  // Finding L2: a lock lifts by itself. When (`lockedUntil`) and how many locks there were since the
  // owner last allowed control (`lockStep`) are persisted, so a restart neither lifts a lock early nor
  // makes it permanent.
  it('round-trips when a lock lifts and how many locks there were', async () => {
    for (const opts of [{ seal, unseal }, {}]) {
      const f = file()
      const timed = ctl({ control: { ...control, locked: true, wrong: 10, lockedUntil: 1_700_000_900_000, lockStep: 3 } })
      expect(await new WatchLinkStore({ file: f, ...opts }).save([timed])).toBe('saved')
      expect(await new WatchLinkStore({ file: f, ...opts }).load()).toEqual([timed])
    }
  })

  it('an existing lock with no lift time (written before timed locks) keeps its meaning: locked until the owner acts', async () => {
    const f = file()
    const older = { enabled: true, salt: SALT, hash: HASH, locked: true, wrong: 10 }
    writeLinks(f, [rawEntry({ role: 'controller', expiresAt: null, control: older })])
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([ctl({ control: { ...control, locked: true, wrong: 10, lockedUntil: null, lockStep: 0 } })])
  })

  it('carries a lift time only while locked: an unlocked record with one reads as none', async () => {
    const f = file()
    writeLinks(f, [rawEntry({ role: 'controller', expiresAt: null, control: { ...control, locked: false, lockedUntil: 1_700_000_900_000, lockStep: 2 } })])
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([ctl({ control: { ...control, lockStep: 2 } })])
  })

  it('keeps only the seven control fields: an extra one is not loaded or carried', async () => {
    const f = file()
    writeLinks(f, [rawEntry({ role: 'controller', expiresAt: null, control: { ...control, password: 'hunter22' } })])
    const s = new WatchLinkStore({ file: f })
    expect(await s.load()).toEqual([ctl()])
    expect(await s.save(await s.load())).toBe('saved')
    expect(readFileSync(f, 'utf8')).not.toContain('hunter22')
  })

  it('writes only the seven control fields of a record', async () => {
    const f = file()
    const withExtra = ctl({ control: { ...control, password: 'hunter22' } as WatchLinkRecord['control'] })
    expect(await new WatchLinkStore({ file: f, seal, unseal }).save([withExtra])).toBe('saved')
    expect(readFileSync(f, 'utf8')).not.toContain('hunter22')
    expect(await new WatchLinkStore({ file: f, seal, unseal }).load()).toEqual([ctl()])
  })

  // `control` IFF the role is 'controller' at WRITE time too: a record the next load would drop is
  // never written. The whole save answers 'failed' and the file stays as it was (a bug, made loud).
  it("refuses to write a record that breaks control-iff-controller: 'failed', the file untouched", async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f, seal, unseal })
    expect(await s.save([ctl()])).toBe('saved')
    const before = readFileSync(f, 'utf8')
    const broken: WatchLinkRecord[] = [
      rec({ role: 'viewer', control }),
      rec({ role: 'commenter', control }),
      rec({ role: 'controller' }),
      ctl({ control: { ...control, salt: b64(new Uint8Array(15).fill(1)) } }),
      ctl({ control: { ...control, hash: 'not base64!' } }),
      ctl({ control: { ...control, enabled: 'yes' } as unknown as WatchLinkRecord['control'] }),
      ctl({ control: { ...control, locked: undefined } as unknown as WatchLinkRecord['control'] }),
      ctl({ control: { ...control, wrong: 11 } }),
      ctl({ control: { ...control, wrong: -1 } }),
      ctl({ control: { ...control, wrong: 2.5 } }),
      ctl({ control: { ...control, locked: true, lockedUntil: Number.NaN } }),
      ctl({ control: { ...control, locked: true, lockedUntil: -5 } }),
      ctl({ control: { ...control, lockStep: 99 } })
    ]
    for (const r of broken) {
      expect(await s.save([rec({ linkId: 'OtherLinkIjKlMnOpQrStU' }), r]), JSON.stringify(r.control ?? r.role)).toBe('failed')
      expect(readFileSync(f, 'utf8')).toBe(before)
    }
    // A store that refused a bad list still writes the next good one.
    expect(await s.save([rec()])).toBe('saved')
    expect(await s.load()).toEqual([rec()])
  })

  it('never writes the plaintext password: the file holds only its salt and scrypt hash', async () => {
    const password = 'correct horse battery staple'
    const h = await hashControlPassword(password)
    const r = ctl({ control: { enabled: true, salt: h.salt, hash: h.hash, locked: false, wrong: 0, lockedUntil: null, lockStep: 0 } })
    for (const opts of [{ seal, unseal }, {}]) {
      const f = file()
      expect(await new WatchLinkStore({ file: f, ...opts }).save([r])).toBe('saved')
      const text = readFileSync(f, 'utf8')
      expect(text).not.toContain(password)
      expect(text).not.toContain(Buffer.from(password).toString('base64'))
      expect(text).not.toContain(Buffer.from(password).toString('hex'))
      expect(text).toContain(h.hash)
      expect(await new WatchLinkStore({ file: f, ...opts }).load()).toEqual([r])
    }
  })

  it('loads expiresAt: null and drops an entry whose expiresAt is neither null nor a finite number', async () => {
    const f = file()
    writeLinks(f, [
      rawEntry({ linkId: 'StrExpiryIjKlMnOpQrStU', expiresAt: 'x' }),
      rawEntry({ linkId: 'NoExpiryhIjKlMnOpQrStU', expiresAt: undefined }),
      rawEntry({ linkId: 'ObjExpiryIjKlMnOpQrStU', expiresAt: {} }),
      rawEntry({ expiresAt: null })
    ])
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([rec({ expiresAt: null })])
  })

  describe('an opaque entry (keychain refused) with no expiry', () => {
    const locked = () => {
      throw new Error('keychain locked')
    }
    const timed = rec({ linkId: 'TimedLinkjKlMnOpQrStUv', label: 'Bob' })

    it('is carried on every write and counted, however late it gets; a timed one is still dropped past its expiry', async () => {
      const f = file()
      expect(await new WatchLinkStore({ file: f, seal, unseal }).save([ctl(), timed])).toBe('saved')
      const onDisk = JSON.parse(readFileSync(f, 'utf8')).links as Record<string, unknown>[]
      const unlimited = onDisk.find((e) => e.linkId === ctl().linkId)
      expect(unlimited).toMatchObject({ expiresAt: null, role: 'controller', control })
      let t = EXPIRES_AT - 1
      const s = new WatchLinkStore({ file: f, seal, unseal: locked, now: () => t })
      expect(await s.load()).toEqual([])
      expect(s.opaqueCount()).toBe(2)
      expect(await s.save([])).toBe('saved')
      expect(JSON.parse(readFileSync(f, 'utf8')).links).toEqual(onDisk)
      t = EXPIRES_AT + 10 * 365 * 24 * 3600_000 // years later: the timed one is gone, the unlimited one is not
      expect(s.opaqueCount()).toBe(1)
      expect(await s.save([])).toBe('saved')
      expect(JSON.parse(readFileSync(f, 'utf8')).links).toEqual([unlimited])
      expect(await s.save([])).toBe('saved')
      expect(JSON.parse(readFileSync(f, 'utf8')).links).toEqual([unlimited])
      // The keychain answers again: the link comes back whole, control included.
      expect(await new WatchLinkStore({ file: f, seal, unseal }).load()).toEqual([ctl()])
    })

    it('is still dropped by discardOpaque() ("Stop all")', async () => {
      const f = file()
      expect(await new WatchLinkStore({ file: f, seal, unseal }).save([ctl()])).toBe('saved')
      const s = new WatchLinkStore({ file: f, seal, unseal: locked })
      expect(await s.load()).toEqual([])
      expect(s.opaqueCount()).toBe(1)
      s.discardOpaque()
      expect(s.opaqueCount()).toBe(0)
      expect(await s.save([])).toBe('saved')
      expect(JSON.parse(readFileSync(f, 'utf8')).links).toEqual([])
    })
  })
})
