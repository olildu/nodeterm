import { describe, it, expect } from 'vitest'
import { portableRemoteCwd, remoteNodeCwd } from './ssh-project-nodes'

describe('remoteNodeCwd / portableRemoteCwd', () => {
  it('resolves portable and relative paths against the remote folder, POSIX-style', () => {
    expect(remoteNodeCwd('.', '/srv/p')).toBe('/srv/p')
    expect(remoteNodeCwd('./a/b', '/srv/p/')).toBe('/srv/p/a/b')
    expect(remoteNodeCwd('a', '~')).toBe('~/a')
    expect(remoteNodeCwd(undefined, '~/p')).toBe('~/p')
    expect(remoteNodeCwd(42, '/srv/p')).toBe('/srv/p')
  })
  it('keeps the host’s own absolute and home paths, drops another OS’s', () => {
    expect(remoteNodeCwd('/etc', '/srv/p')).toBe('/etc')
    expect(remoteNodeCwd('~/x', '/srv/p')).toBe('~/x')
    expect(remoteNodeCwd('C:\\work', '/srv/p')).toBe('/srv/p')
    expect(remoteNodeCwd('\\\\share\\x', '/srv/p')).toBe('/srv/p')
  })
  it('portable form is the inverse inside the folder and leaves the outside alone', () => {
    expect(portableRemoteCwd('/srv/p', '/srv/p')).toBe('.')
    expect(portableRemoteCwd('/srv/p/a', '/srv/p/')).toBe('./a')
    expect(portableRemoteCwd('/srv/px', '/srv/p')).toBe('/srv/px')
    expect(portableRemoteCwd('~/p/a', '~/p')).toBe('./a')
    expect(portableRemoteCwd(undefined, '/srv/p')).toBeUndefined()
  })
})
