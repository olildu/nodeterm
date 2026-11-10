// Issue #1145: a folder project CREATED from now on keeps its canvas where Settings → Behavior
// says; one adopted from an existing project.json, a cwd-less canvas and an SSH project never take
// the flag.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useProjects } from './projects'
import { useSettings } from './settings'
import type { Project } from '@shared/types'

const setStorage = (newProjectStorage: 'folder' | 'appData') =>
  useSettings.setState((s) => ({ settings: { ...s.settings, newProjectStorage } }))

beforeEach(() => {
  useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: [] })
})
afterEach(() => setStorage('folder'))

describe('where a new folder project stores its canvas', () => {
  it('in the folder by default', () => {
    expect(useProjects.getState().openFolderProject('/Users/me/dev/app').storeInAppData).toBeUndefined()
  })

  it('in app data when the setting says so, for every creation path', () => {
    setStorage('appData')
    expect(useProjects.getState().openFolderProject('/Users/me/dev/a').storeInAppData).toBe(true)
    expect(useProjects.getState().addProject('b', '/Users/me/dev/b').storeInAppData).toBe(true)
    expect(useProjects.getState().registerProject({ resolvedCwd: '/Users/me/dev/c' }).project.storeInAppData).toBe(true)
  })

  it('never for a cwd-less canvas, an SSH project or an adopted project.json', () => {
    setStorage('appData')
    expect(useProjects.getState().addProject('scratch').storeInAppData).toBeUndefined()
    const ssh = { server: { host: 'h', user: 'u' }, remoteCwd: '~/x' } as unknown as NonNullable<Project['ssh']>
    expect(useProjects.getState().addProject('remote', undefined, ssh).storeInAppData).toBeUndefined()
    const adopted = useProjects.getState().adoptProject({
      id: 'project-adopted', name: 'cloned', color: '#fff', cwd: '/Users/me/dev/cloned',
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: []
    })
    expect(adopted.storeInAppData).toBeUndefined()
  })

  it('the move flag sets and clears without touching anything else', () => {
    const p = useProjects.getState().openFolderProject('/Users/me/dev/app')
    useProjects.getState().setProjectStoreInAppData(p.id, true)
    expect(useProjects.getState().getProject(p.id)).toMatchObject({ cwd: '/Users/me/dev/app', storeInAppData: true })
    useProjects.getState().setProjectStoreInAppData(p.id, false)
    expect('storeInAppData' in useProjects.getState().getProject(p.id)!).toBe(false)
  })
})
