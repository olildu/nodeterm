import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { testTmpDir } from '../src/core/test-tmp'
// @ts-expect-error -- plain .mjs build script, no type declarations
import { stageConptyDll } from './stage-conpty-dll.mjs'

const PKG = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'))

function fakePty(opts: { built?: boolean; arches?: string[] } = {}): string {
  const dir = testTmpDir('nt-stage-conpty-')
  const write = (rel: string): void => {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, rel)
  }
  if (opts.built !== false) write('build/Release/conpty.node')
  for (const arch of opts.arches ?? ['x64', 'arm64']) {
    write(`third_party/conpty/1.23.251008001/win10-${arch}/conpty.dll`)
    write(`third_party/conpty/1.23.251008001/win10-${arch}/OpenConsole.exe`)
  }
  return dir
}

describe('stage-conpty-dll', () => {
  it('copies conpty.dll + OpenConsole.exe beside the rebuilt conpty.node on win32 (where node-pty looks)', () => {
    const dir = fakePty()
    expect(stageConptyDll({ ptyDir: dir, platform: 'win32', arch: 'arm64' }).staged).toBe(true)
    for (const f of ['conpty.dll', 'OpenConsole.exe']) {
      expect(fs.readFileSync(path.join(dir, 'build/Release/conpty', f), 'utf8')).toBe(
        `third_party/conpty/1.23.251008001/win10-arm64/${f}`
      )
    }
  })

  it('is a no-op off Windows, without a built module, or for an arch with no bundled ConPTY', () => {
    const linux = fakePty()
    expect(stageConptyDll({ ptyDir: linux, platform: 'linux', arch: 'x64' }).staged).toBe(false)
    expect(fs.existsSync(path.join(linux, 'build/Release/conpty'))).toBe(false)

    const unbuilt = fakePty({ built: false })
    expect(stageConptyDll({ ptyDir: unbuilt, platform: 'win32', arch: 'x64' }).staged).toBe(false)

    const ia32 = fakePty()
    expect(stageConptyDll({ ptyDir: ia32, platform: 'win32', arch: 'ia32' }).staged).toBe(false)
  })

  it('stages nothing when the arch folder is incomplete', () => {
    const dir = fakePty({ arches: ['arm64'] })
    expect(stageConptyDll({ ptyDir: dir, platform: 'win32', arch: 'x64' }).staged).toBe(false)
    expect(fs.existsSync(path.join(dir, 'build/Release/conpty'))).toBe(false)
  })

  it('runs AFTER electron-rebuild in both postinstall and rebuild (node-gyp rebuild wipes build/)', () => {
    for (const name of ['postinstall', 'rebuild']) {
      const cmd: string = PKG.scripts[name]
      const rebuild = cmd.indexOf('electron-rebuild')
      const stage = cmd.indexOf('node scripts/stage-conpty-dll.mjs')
      expect(rebuild, name).toBeGreaterThanOrEqual(0)
      expect(stage, `${name} must stage the bundled ConPTY`).toBeGreaterThan(rebuild)
    }
  })

  it("ships the staged ConPTY in the Windows session host's node-pty copy", () => {
    const resources: Array<{ from: string; to: string; filter?: string[] }> = PKG.build.win.extraResources
    const nodePty = resources.find((r) => r.to === 'session-host/node_modules/node-pty')
    expect(nodePty?.filter).toEqual(
      expect.arrayContaining(['build/Release/conpty/conpty.dll', 'build/Release/conpty/OpenConsole.exe'])
    )
  })
})
