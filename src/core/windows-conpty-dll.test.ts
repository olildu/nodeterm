import { describe, it, expect } from 'vitest'
import path from 'path'
import { windowsConptySpawnOptions } from './windows-conpty-dll'

const ROOT = path.join('C:', 'app', 'node_modules', 'node-pty')
const rel = (...p: string[]): string => path.join(ROOT, ...p)

function existsFrom(files: string[]): (p: string) => boolean {
  const set = new Set(files.map((f) => path.normalize(f)))
  return (p) => set.has(path.normalize(p))
}

const BUILT = [
  rel('build', 'Release', 'conpty.node'),
  rel('build', 'Release', 'conpty', 'conpty.dll'),
  rel('build', 'Release', 'conpty', 'OpenConsole.exe')
]

describe('windowsConptySpawnOptions', () => {
  it('asks for the bundled ConPTY on win32 when conpty.dll AND OpenConsole.exe sit beside the loaded conpty.node', () => {
    expect(
      windowsConptySpawnOptions({
        platform: 'win32',
        arch: 'x64',
        nodePtyRoot: () => ROOT,
        exists: existsFrom(BUILT)
      })
    ).toEqual({ useConptyDll: true })
  })

  it('falls back to the inbox ConPTY when either file is missing', () => {
    for (const missing of BUILT.slice(1)) {
      expect(
        windowsConptySpawnOptions({
          platform: 'win32',
          arch: 'x64',
          nodePtyRoot: () => ROOT,
          exists: existsFrom(BUILT.filter((f) => f !== missing))
        })
      ).toEqual({})
    }
  })

  it('judges the sidecar of the conpty.node node-pty will LOAD, not a later candidate', () => {
    // build/Release wins in loadNativeModule; a DLL only beside the prebuild would not be found.
    expect(
      windowsConptySpawnOptions({
        platform: 'win32',
        arch: 'x64',
        nodePtyRoot: () => ROOT,
        exists: existsFrom([
          rel('build', 'Release', 'conpty.node'),
          rel('prebuilds', 'win32-x64', 'conpty.node'),
          rel('prebuilds', 'win32-x64', 'conpty', 'conpty.dll'),
          rel('prebuilds', 'win32-x64', 'conpty', 'OpenConsole.exe')
        ])
      })
    ).toEqual({})
  })

  it('uses the prebuild for the current arch when nothing was built', () => {
    const prebuilt = (arch: string): string[] => [
      rel('prebuilds', `win32-${arch}`, 'conpty.node'),
      rel('prebuilds', `win32-${arch}`, 'conpty', 'conpty.dll'),
      rel('prebuilds', `win32-${arch}`, 'conpty', 'OpenConsole.exe')
    ]
    expect(
      windowsConptySpawnOptions({
        platform: 'win32',
        arch: 'arm64',
        nodePtyRoot: () => ROOT,
        exists: existsFrom(prebuilt('arm64'))
      })
    ).toEqual({ useConptyDll: true })
    expect(
      windowsConptySpawnOptions({
        platform: 'win32',
        arch: 'arm64',
        nodePtyRoot: () => ROOT,
        exists: existsFrom(prebuilt('x64'))
      })
    ).toEqual({})
  })

  it('is {} on linux and darwin without touching the filesystem', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(
        windowsConptySpawnOptions({
          platform,
          nodePtyRoot: () => {
            throw new Error('must not resolve')
          },
          exists: () => {
            throw new Error('must not stat')
          }
        })
      ).toEqual({})
    }
  })

  it('never throws: an fs or resolve failure is the inbox ConPTY', () => {
    expect(
      windowsConptySpawnOptions({
        platform: 'win32',
        arch: 'x64',
        nodePtyRoot: () => ROOT,
        exists: () => {
          throw new Error('EACCES')
        }
      })
    ).toEqual({})
    expect(
      windowsConptySpawnOptions({
        platform: 'win32',
        arch: 'x64',
        nodePtyRoot: () => {
          throw new Error('Cannot find module')
        }
      })
    ).toEqual({})
  })
})
