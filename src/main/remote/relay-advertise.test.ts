// The standing host used to rewrite ~/.nodeterm/relay.json with identical
// content on every ~90 s listener cycle. The advertiser now skips an unchanged write, but must still
// rewrite when the content changes, when the file has gone, and after a remove. Every test runs
// against a temp dir through the factory — never the live ~/.nodeterm.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

const atomic = vi.hoisted(() => ({ writes: 0 }))
vi.mock('../../core/fs-atomic', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../core/fs-atomic')>()
  return {
    ...real,
    writeFileAtomic: async (...args: Parameters<typeof real.writeFileAtomic>) => {
      atomic.writes++
      return real.writeFileAtomic(...args)
    }
  }
})

import { createRelayAdvertiser, type RelayAdvertisement } from './relay-advertise'

const AD: RelayAdvertisement = {
  v: 1,
  hostId: 'host-1',
  hostPublicKeyB64: 'cHVi',
  relayEndpoint: 'wss://relay.example/ws',
  hostDeviceId: 'dev-1'
}

let dir: string
let file: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-relay-ad-'))
  file = path.join(dir, '.nodeterm', 'relay.json')
  atomic.writes = 0
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('relay advertisement — skip unchanged rewrites', () => {
  it('writes once, then skips byte-identical advertisements', async () => {
    const ad = createRelayAdvertiser(file)
    await ad.write(AD)
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(AD)
    await ad.write({ ...AD })
    await ad.write({ ...AD })
    expect(atomic.writes).toBe(1)
  })

  it('rewrites when the content changes', async () => {
    const ad = createRelayAdvertiser(file)
    await ad.write(AD)
    await ad.write({ ...AD, relayEndpoint: 'wss://other.example/ws' })
    expect(atomic.writes).toBe(2)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).relayEndpoint).toBe('wss://other.example/ws')
  })

  it('rewrites an unchanged advertisement whose file has gone', async () => {
    const ad = createRelayAdvertiser(file)
    await ad.write(AD)
    await fs.rm(file)
    await ad.write(AD)
    expect(atomic.writes).toBe(2)
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(AD)
  })

  it('remove deletes the file and forgets it, so the next start writes again', async () => {
    const ad = createRelayAdvertiser(file)
    await ad.write(AD)
    await ad.remove()
    await expect(fs.readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await ad.write(AD)
    expect(atomic.writes).toBe(2)
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(AD)
  })
})
