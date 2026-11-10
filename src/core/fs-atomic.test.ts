// The retry has to be proved against a rename that FAILS and then succeeds, not merely against a
// rename that works — the whole point is behaviour on a platform most of this suite never runs on.
// So the transient failure is injected rather than waited for.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs, writeFileSync, readFileSync, renameSync } from 'fs'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  clearAtomicTarget,
  removeAtomic,
  renameAtomic,
  renameAtomicSync,
  STALE_TEMP_AGE_MS,
  sweepForeignTempFiles,
  sweepStaleTempFiles,
  tempNameFor,
  writeFileAtomic
} from './fs-atomic'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nt-atomic-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function errWithCode(code: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(`${code}: injected`)
  e.code = code
  return e
}

describe('renameAtomic survives a destination held open', () => {
  it('retries a Windows sharing violation and succeeds', async () => {
    const target = join(dir, 'store.json')
    const tmp = join(dir, 'store.json.tmp')
    await fs.writeFile(tmp, 'new')

    const real = fs.rename
    let calls = 0
    vi.spyOn(fs, 'rename').mockImplementation((async (a: never, b: never) => {
      // Two scanners in a row, then the handle is released. EPERM is what Windows actually
      // reports for a sharing violation on MoveFileEx.
      if (++calls <= 2) throw errWithCode('EPERM')
      return (real as (a: never, b: never) => Promise<void>)(a, b)
    }) as typeof fs.rename)

    await renameAtomic(tmp, target)
    expect(calls).toBe(3)
    expect(await readFile(target, 'utf-8')).toBe('new')
  })

  it.each(['EPERM', 'EACCES', 'EBUSY'])('treats %s as transient', async (code) => {
    const target = join(dir, 'store.json')
    const tmp = join(dir, 'store.json.tmp')
    await fs.writeFile(tmp, 'new')
    const real = fs.rename
    let calls = 0
    vi.spyOn(fs, 'rename').mockImplementation((async (a: never, b: never) => {
      if (++calls === 1) throw errWithCode(code)
      return (real as (a: never, b: never) => Promise<void>)(a, b)
    }) as typeof fs.rename)
    await renameAtomic(tmp, target)
    expect(calls).toBe(2)
  })

  it('does NOT retry an error that waiting cannot fix', async () => {
    // ENOENT means the temp is gone — a bug in the caller. Retrying delays a clearer error by a
    // third of a second and reports the same failure.
    let calls = 0
    vi.spyOn(fs, 'rename').mockImplementation((async () => {
      calls++
      throw errWithCode('ENOENT')
    }) as typeof fs.rename)
    await expect(renameAtomic(join(dir, 'a'), join(dir, 'b'))).rejects.toThrow(/ENOENT/)
    expect(calls).toBe(1)
  })

  it('gives up rather than hanging, and rethrows the REAL error', async () => {
    // A permanently locked file must fail: several callers report a failed save as not persisted,
    // and that contract is worth more than a save that eventually lands.
    let calls = 0
    vi.spyOn(fs, 'rename').mockImplementation((async () => {
      calls++
      throw errWithCode('EPERM')
    }) as typeof fs.rename)
    const err = await renameAtomic(join(dir, 'a'), join(dir, 'b')).catch((e) => e)
    expect(err.code, 'the original code must survive, not a wrapper').toBe('EPERM')
    expect(calls, 'bounded: five attempts, not an unbounded loop').toBe(5)
  })
})

describe('renameAtomicSync', () => {
  // The sync twin exists for paths that cannot be async — hook installers on the startup path, the
  // codex trust-hash write, the per-node token file. It is easy to add the async helper and leave
  // these behind, which is precisely what the first version of this work did: the guard knew only
  // `fs.rename(` and stayed green over eight `renameSync` and destructured-`rename` sites.
  //
  // The rename is injected because a spy cannot be attached to an ESM namespace export — see the
  // parameter's own comment in fs-atomic.ts.
  it('retries a sharing violation and succeeds', () => {
    const target = join(dir, 'store.json')
    const tmp = join(dir, 'store.json.tmp')
    writeFileSync(tmp, 'new')
    let calls = 0
    renameAtomicSync(tmp, target, (a, b) => {
      // Two scanners in a row, then the handle is released.
      if (++calls <= 2) throw errWithCode('EPERM')
      renameSync(a, b)
    })
    expect(calls).toBe(3)
    expect(readFileSync(target, 'utf-8')).toBe('new')
  })

  it.each(['EPERM', 'EACCES', 'EBUSY'])('treats %s as transient', (code) => {
    const target = join(dir, 'store.json')
    const tmp = join(dir, 'store.json.tmp')
    writeFileSync(tmp, 'new')
    let calls = 0
    renameAtomicSync(tmp, target, (a, b) => {
      if (++calls === 1) throw errWithCode(code)
      renameSync(a, b)
    })
    expect(calls).toBe(2)
  })

  it('does not retry an error waiting cannot fix', () => {
    let calls = 0
    expect(() =>
      renameAtomicSync(join(dir, 'a'), join(dir, 'b'), () => {
        calls++
        throw errWithCode('ENOENT')
      })
    ).toThrow(/ENOENT/)
    expect(calls).toBe(1)
  })

  it('gives up rather than blocking forever, and rethrows the REAL error', () => {
    // It blocks the thread while it waits, so an unbounded loop here would hang the app rather
    // than merely losing a save.
    let calls = 0
    let err: NodeJS.ErrnoException | undefined
    try {
      renameAtomicSync(join(dir, 'a'), join(dir, 'b'), () => {
        calls++
        throw errWithCode('EPERM')
      })
    } catch (e) {
      err = e as NodeJS.ErrnoException
    }
    expect(err?.code).toBe('EPERM')
    expect(calls, 'bounded: five attempts').toBe(5)
  })

  it('actually waits between attempts, rather than spinning through instantly', () => {
    // `Atomics.wait` is a real sleep. Swap it for a no-op and every retry fires in the same
    // millisecond, which defeats the point — the destination needs TIME to be released.
    const started = Date.now()
    try {
      renameAtomicSync(join(dir, 'a'), join(dir, 'b'), () => {
        throw errWithCode('EPERM')
      })
    } catch {
      /* expected */
    }
    // Four sleeps: 10 + 25 + 75 + 200. Asserting under the total to stay clear of timer slop.
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
  })

  it('uses the real renameSync when nothing is injected', () => {
    // The default parameter is the production path; without this the injected tests above would
    // all pass while the shipped function renamed nothing.
    const target = join(dir, 'real.json')
    const tmp = join(dir, 'real.json.tmp')
    writeFileSync(tmp, 'shipped')
    renameAtomicSync(tmp, target)
    expect(readFileSync(target, 'utf-8')).toBe('shipped')
  })
})

describe('writeFileAtomic', () => {
  it('publishes the new bytes', async () => {
    const target = join(dir, 'store.json')
    await writeFileAtomic(target, '{"a":1}')
    expect(await readFile(target, 'utf-8')).toBe('{"a":1}')
  })

  it('leaves the OLD file byte-for-byte intact when the write fails', async () => {
    // The half every `persisted:false` contract depends on: a failed save must not also destroy
    // what was already there.
    const target = join(dir, 'store.json')
    await writeFileAtomic(target, 'original')
    vi.spyOn(fs, 'rename').mockImplementation((async () => {
      throw errWithCode('ENOSPC')
    }) as typeof fs.rename)
    await expect(writeFileAtomic(target, 'replacement')).rejects.toThrow(/ENOSPC/)
    expect(await readFile(target, 'utf-8')).toBe('original')
  })

  it('removes its own temp on failure', async () => {
    // A unique temp name never self-heals the way a fixed one did, where the next save reused it.
    const target = join(dir, 'store.json')
    vi.spyOn(fs, 'rename').mockImplementation((async () => {
      throw errWithCode('ENOSPC')
    }) as typeof fs.rename)
    await writeFileAtomic(target, 'x').catch(() => {})
    const left = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))
    expect(left).toEqual([])
  })

  it('gives concurrent writers different temp files', async () => {
    // With one shared `<file>.tmp`, a writer's rename publishes the other's half-written bytes.
    const target = join(dir, 'store.json')
    const seen: string[] = []
    const real = fs.writeFile
    vi.spyOn(fs, 'writeFile').mockImplementation((async (p: never, ...rest: never[]) => {
      seen.push(String(p))
      return (real as (p: never, ...r: never[]) => Promise<void>)(p, ...rest)
    }) as typeof fs.writeFile)
    await Promise.all([writeFileAtomic(target, 'a'), writeFileAtomic(target, 'b')])
    expect(new Set(seen).size, `both writers used ${seen.join(' and ')}`).toBe(2)
  })

  it('the published result is one writer\'s bytes, never a splice of both', async () => {
    const target = join(dir, 'store.json')
    const a = JSON.stringify({ pubkeys: Array.from({ length: 64 }, (_, i) => `A${'a'.repeat(42)}${i}`) })
    const b = JSON.stringify({ pubkeys: ['B'] })
    await Promise.all([writeFileAtomic(target, a), writeFileAtomic(target, b)])
    const got = await readFile(target, 'utf-8')
    expect([a, b]).toContain(got)
  })
})

describe('removeAtomic', () => {
  it('reports success when the file is genuinely gone', async () => {
    const f = join(dir, 'gone.json')
    writeFileSync(f, 'x')
    expect(await removeAtomic(f)).toBe(true)
  })

  it('treats ENOENT as success — the caller wanted it absent and it is', async () => {
    expect(await removeAtomic(join(dir, 'never-existed.json'))).toBe(true)
  })

  it('reports FAILURE when the file is still there', async () => {
    // The whole point. A delete whose purpose is to stop something happening — the relay
    // advertisement, so phones stop minting tokens against a host that is off — must not report
    // success while the file sits there. The old shape was an unlink in a bare catch commented
    // "already absent", which is true of ENOENT and false of every other code.
    vi.spyOn(fs, 'unlink').mockImplementation((async () => {
      throw errWithCode('EPERM')
    }) as typeof fs.unlink)
    expect(await removeAtomic(join(dir, 'held-open.json'))).toBe(false)
  })

  it('retries a transient lock before giving up', async () => {
    const f = join(dir, 'busy.json')
    writeFileSync(f, 'x')
    const real = fs.unlink
    let calls = 0
    vi.spyOn(fs, 'unlink').mockImplementation((async (p: never) => {
      if (++calls <= 2) throw errWithCode('EBUSY')
      return (real as (p: never) => Promise<void>)(p)
    }) as typeof fs.unlink)
    expect(await removeAtomic(f)).toBe(true)
    expect(calls).toBe(3)
  })

  it('does not spend the retry budget on an error waiting cannot fix', async () => {
    let calls = 0
    vi.spyOn(fs, 'unlink').mockImplementation((async () => {
      calls++
      throw errWithCode('EISDIR')
    }) as typeof fs.unlink)
    expect(await removeAtomic(join(dir, 'a-directory'))).toBe(false)
    expect(calls).toBe(1)
  })
})

describe('unique temp names and abandoned-temp collection', () => {
  it('separates same-millisecond calls and colliding PID namespaces/module counters', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const a = tempNameFor(join(dir, 'secret.json'))
    const b = tempNameFor(join(dir, 'secret.json'))
    expect(a).not.toBe(b)
    expect(a).toContain(`.${process.pid}.`)
    expect(b).toContain(`.${process.pid}.`)

    const sameNamespace = { pid: 1, sequence: 1 }
    const defaultUuidA = tempNameFor(join(dir, 'secret.json'), sameNamespace)
    const defaultUuidB = tempNameFor(join(dir, 'secret.json'), sameNamespace)
    expect(defaultUuidA).not.toBe(defaultUuidB)
    const containerA = tempNameFor(join(dir, 'secret.json'), {
      ...sameNamespace,
      uuid: () => 'uuid-a'
    })
    const containerB = tempNameFor(join(dir, 'secret.json'), {
      ...sameNamespace,
      uuid: () => 'uuid-b'
    })
    expect(containerA).not.toBe(containerB)
    expect(containerA).toContain('.1.1.uuid-a.tmp')
    expect(containerB).toContain('.1.1.uuid-b.tmp')
    now.mockRestore()
  })

  it('keeps every fresh temp, even when its owner is already dead', async () => {
    const target = join(dir, 'secret.json')
    const legacy = `${target}.tmp`
    const foreign = `${target}.4242.1.tmp`
    await Promise.all([fs.writeFile(legacy, 'legacy'), fs.writeFile(foreign, 'foreign')])
    const writtenAt = Math.min((await fs.lstat(legacy)).mtimeMs, (await fs.lstat(foreign)).mtimeMs)

    await sweepStaleTempFiles(target, {
      now: writtenAt + STALE_TEMP_AGE_MS - 1
    })

    expect((await fs.readdir(dir)).sort()).toEqual(['secret.json.4242.1.tmp', 'secret.json.tmp'])
  })

  it('removes only an aged ownerless legacy temp and preserves every PID-bearing shape', async () => {
    const target = join(dir, 'secret.json')
    const legacy = `${target}.tmp`
    const priorPidShape = `${target}.1111.1.tmp`
    const current = `${target}.2222.2.22222222-2222-4222-8222-222222222222.tmp`
    const ours = `${target}.${process.pid}.3.33333333-3333-4333-8333-333333333333.tmp`
    const unknown = `${target}.not-an-owner.tmp`
    const unrelated = join(dir, 'other-file!.tmp') // same basename length as secret.json
    await Promise.all(
      [legacy, priorPidShape, current, ours, unknown, unrelated].map((file) => fs.writeFile(file, file))
    )
    const writtenAt = Math.max(
      ...(await Promise.all(
        [legacy, priorPidShape, current, ours, unknown, unrelated].map((file) => fs.lstat(file))
      ))
        .map((stat) => stat.mtimeMs)
    )

    await sweepStaleTempFiles(target, { now: writtenAt + STALE_TEMP_AGE_MS })

    expect((await fs.readdir(dir)).sort()).toEqual([
      `secret.json.${process.pid}.3.33333333-3333-4333-8333-333333333333.tmp`,
      'other-file!.tmp',
      'secret.json.1111.1.tmp',
      'secret.json.2222.2.22222222-2222-4222-8222-222222222222.tmp',
      'secret.json.not-an-owner.tmp'
    ].sort())
  })

  it('does not use namespace-local signal zero to judge an aged PID-bearing temp', async () => {
    const target = join(dir, 'secret.json')
    const foreign = `${target}.3333.1.11111111-1111-4111-8111-111111111111.tmp`
    await fs.writeFile(foreign, 'foreign')
    const writtenAt = (await fs.lstat(foreign)).mtimeMs
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errWithCode('ESRCH')
    })

    await sweepStaleTempFiles(target, { now: writtenAt + STALE_TEMP_AGE_MS })

    expect(kill).not.toHaveBeenCalled()
    expect(await fs.readFile(foreign, 'utf8')).toBe('foreign')
  })
})

describe('sweepForeignTempFiles (credential stores)', () => {
  it('removes the legacy temp and every foreign PID shape at once, with no age grace', async () => {
    const target = join(dir, 'token.json')
    const legacy = `${target}.tmp`
    const priorPidShape = `${target}.1111.1.tmp`
    const current = `${target}.2222.2.22222222-2222-4222-8222-222222222222.tmp`
    const ours = `${target}.${process.pid}.3.33333333-3333-4333-8333-333333333333.tmp`
    const oursPrior = `${target}.${process.pid}.4.tmp`
    const unknown = `${target}.not-an-owner.tmp`
    const unrelated = join(dir, 'other-fil!.tmp') // same basename length as token.json
    const lookalike = join(dir, 'token.json.bak.1111.1.tmp')
    await Promise.all(
      [target, legacy, priorPidShape, current, ours, oursPrior, unknown, unrelated, lookalike].map((file) =>
        fs.writeFile(file, file)
      )
    )

    await sweepForeignTempFiles(target)

    expect((await fs.readdir(dir)).sort()).toEqual([
      'other-fil!.tmp',
      'token.json',
      `token.json.${process.pid}.3.33333333-3333-4333-8333-333333333333.tmp`,
      `token.json.${process.pid}.4.tmp`,
      'token.json.bak.1111.1.tmp',
      'token.json.not-an-owner.tmp'
    ].sort())
  })

  it('resolves quietly when the directory cannot be read', async () => {
    await expect(sweepForeignTempFiles(join(dir, 'missing', 'token.json'))).resolves.toBeUndefined()
  })
})

describe('clearAtomicTarget', () => {
  it('removes the canonical file but reports a young current temp as retained', async () => {
    const target = join(dir, 'secret.json')
    const foreign = `${target}.4242.1.11111111-1111-4111-8111-111111111111.tmp`
    await Promise.all([fs.writeFile(target, 'canonical'), fs.writeFile(foreign, 'bearer')])
    const writtenAt = (await fs.lstat(foreign)).mtimeMs

    const result = await clearAtomicTarget(target, {
      now: writtenAt + STALE_TEMP_AGE_MS - 1
    })

    expect(result).toEqual({
      cleared: false,
      canonicalRemoved: true,
      retainedTempCount: 1,
      inspectionComplete: true
    })
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(foreign, 'utf8')).toBe('bearer')
  })

  it('does not delete or bless an aged temp whose owner may be in another PID namespace', async () => {
    const target = join(dir, 'secret.json')
    const foreign = `${target}.5151.1.22222222-2222-4222-8222-222222222222.tmp`
    await fs.writeFile(foreign, 'bearer')
    const writtenAt = (await fs.lstat(foreign)).mtimeMs

    const result = await clearAtomicTarget(target, { now: writtenAt + STALE_TEMP_AGE_MS })

    expect(result.cleared).toBe(false)
    expect(result.retainedTempCount).toBe(1)
    expect(await fs.readFile(foreign, 'utf8')).toBe('bearer')
  })

  it('reports an aged temp whose deletion failed instead of swallowing the incomplete clear', async () => {
    const target = join(dir, 'secret.json')
    const legacy = `${target}.tmp`
    await fs.writeFile(legacy, 'bearer')
    const writtenAt = (await fs.lstat(legacy)).mtimeMs
    const realRm = fs.rm
    vi.spyOn(fs, 'rm').mockImplementation((async (file: any, options?: any) => {
      if (String(file) === legacy) throw errWithCode('EACCES')
      return (realRm as any)(file, options)
    }) as typeof fs.rm)

    const result = await clearAtomicTarget(target, { now: writtenAt + STALE_TEMP_AGE_MS })

    expect(result.cleared).toBe(false)
    expect(result.retainedTempCount).toBe(1)
    expect(await fs.readFile(legacy, 'utf8')).toBe('bearer')
  })

  it('reports success only after an aged ownerless temp and the canonical file are gone', async () => {
    const target = join(dir, 'secret.json')
    const legacy = `${target}.tmp`
    await Promise.all([fs.writeFile(target, 'canonical'), fs.writeFile(legacy, 'bearer')])
    const writtenAt = (await fs.lstat(legacy)).mtimeMs

    const result = await clearAtomicTarget(target, { now: writtenAt + STALE_TEMP_AGE_MS })

    expect(result).toEqual({
      cleared: true,
      canonicalRemoved: true,
      retainedTempCount: 0,
      inspectionComplete: true
    })
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('does not mistake an arbitrary dot-free token for a UUID temp', async () => {
    const target = join(dir, 'secret.json')
    const lookalike = `${target}.6262.1.not-a-uuid.tmp`
    await Promise.all([fs.writeFile(target, 'canonical'), fs.writeFile(lookalike, 'unrelated')])

    const result = await clearAtomicTarget(target)

    expect(result).toEqual({
      cleared: true,
      canonicalRemoved: true,
      retainedTempCount: 0,
      inspectionComplete: true
    })
    expect(await fs.readFile(lookalike, 'utf8')).toBe('unrelated')
  })

  it('reports a canonical file republished between unlink and inspection as uncleared', async () => {
    const target = join(dir, 'secret.json')
    await fs.writeFile(target, 'old')
    const realReaddir = fs.readdir
    let reads = 0
    vi.spyOn(fs, 'readdir').mockImplementation((async (directory: any, options?: any) => {
      reads++
      // First read is the conservative sweep; second is the post-unlink completeness scan.
      if (reads === 2) await fs.writeFile(target, 'republished')
      return (realReaddir as any)(directory, options)
    }) as typeof fs.readdir)

    const result = await clearAtomicTarget(target)

    expect(result.cleared).toBe(false)
    expect(result.canonicalRemoved).toBe(false)
    expect(result.retainedTempCount).toBe(0)
    expect(await fs.readFile(target, 'utf8')).toBe('republished')
  })
})
