// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NodeTerminalApi, Project } from '@shared/types'
import { spawnBelongsElsewhere } from './owning-project'
import { bindProjectToSession, createSession, disposeSession, isRemoteProjectId, resetSessionsForTest } from './session'
import { useProjects } from '../state/projects'

// The create-time half of bug F's defense (F2c): a node of a REMOTE project (a hosted team / relay
// tab) that finds itself under a session which is not a relay session must start nothing — that
// session is this desktop's own core, and the node id belongs to the host.
describe('spawnBelongsElsewhere', () => {
  it('a remote project under a non-relay session belongs elsewhere', () => {
    expect(spawnBelongsElsewhere(true, 'local')).toBe(true)
    expect(spawnBelongsElsewhere(true, 'server')).toBe(true)
  })

  it('a remote project under a relay session is where it belongs', () => {
    expect(spawnBelongsElsewhere(true, 'relay')).toBe(false)
  })

  it('a project that is not remote never belongs elsewhere, whatever the session', () => {
    expect(spawnBelongsElsewhere(false, 'local')).toBe(false)
    expect(spawnBelongsElsewhere(false, 'relay')).toBe(false)
    expect(spawnBelongsElsewhere(false, 'server')).toBe(false)
  })
})

// The question the terminals ask before it: `isRemoteProjectId` is the same rule
// `sessionForProject`'s unbound branch uses, so a tab the store has deleted still reads as remote
// (a store-only `getProject(id)?.remote` read answered false for it).
const TEAM = 'project-team'
const LOCAL = 'project-local'
const project = (id: string, remote = false): Project =>
  ({ id, name: id, color: '#888', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], ...(remote ? { remote: true } : {}) }) as unknown as Project

describe('isRemoteProjectId', () => {
  beforeEach(() => {
    resetSessionsForTest()
    useProjects.setState({ projects: [project(TEAM, true), project(LOCAL)], activeProjectId: LOCAL } as never)
  })
  afterEach(() => resetSessionsForTest())

  it('answers the store while the store holds the project', () => {
    expect(isRemoteProjectId(TEAM)).toBe(true)
    expect(isRemoteProjectId(LOCAL)).toBe(false)
  })

  it('a remote tab the store has since deleted stays remote once it was bound while remote', () => {
    const relay = createSession('relay', {} as NodeTerminalApi, 'Team')
    bindProjectToSession(TEAM, relay.id)
    disposeSession(relay.id)
    useProjects.setState({ projects: [project(LOCAL)] } as never)
    expect(isRemoteProjectId(TEAM)).toBe(true)
    // The terminals' composed question: refused under this desktop's own session.
    expect(spawnBelongsElsewhere(isRemoteProjectId(TEAM), 'local')).toBe(true)
  })

  it('an id the store never held as remote, and no project at all, are not evidence of anything', () => {
    expect(isRemoteProjectId('project-never-seen')).toBe(false)
    expect(isRemoteProjectId('')).toBe(false)
    expect(spawnBelongsElsewhere(isRemoteProjectId(''), 'local')).toBe(false)
    // A local project's own id is never remote, so its terminals are byte-identical.
    expect(spawnBelongsElsewhere(isRemoteProjectId(LOCAL), 'local')).toBe(false)
  })
})
