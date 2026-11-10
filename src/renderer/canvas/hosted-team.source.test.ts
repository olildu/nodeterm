import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the hosted-team glue in Canvas.tsx — the same class of test as
 * `control-cold-open.source.test.ts`, for the same reason: the glue lives inside a 15,000-line
 * component with no render harness. Every BEHAVIOUR is proven against the real modules elsewhere:
 * the attempt owner (`lib/hostedAttempts.test.ts`), the joiner's boot / drop / click / paste /
 * forget paths (`lib/hostedJoin.test.ts`), the approval queue and the owner subscription
 * (`lib/hostedPendingQueue.test.ts`, `lib/hostedOwner.test.ts`, `session/relay-tab.test.ts`), the
 * role gate and the legacy relay api (`bridge/relay-api.test.ts`), the dialog
 * (`components/HostedApprovalDialog.test.tsx`).
 *
 * What only a source read can pin is that Canvas CALLS them, and — the rule this feature rests on —
 * that a Team Access relay tab and a local tab still take their old path: every hosted branch sits
 * behind a join code, a hosted api or a hosted role. See docs/hosted-team-relay.md.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function between(start: string, end: string): string {
  const a = src.indexOf(start)
  expect(a, start).toBeGreaterThan(-1)
  const b = src.indexOf(end, a + start.length)
  expect(b, end).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('hosted team glue in Canvas', () => {
  it('a pairing offer keeps its old connect path; only a join code is handed to the hosted joiner', () => {
    const body = between('const connectOffer = useCallback(', '[confirmAndMount]')
    const divert = body.indexOf('if (isJoinCode(offer) && hostedJoinerRef.current) {')
    const legacy = body.indexOf("await window.nodeTerminal.relayClient.connect(offer)")
    expect(divert).toBeGreaterThan(-1)
    expect(legacy).toBeGreaterThan(divert)
    expect(body).toContain("confirmAndMount(connectionId, 'Remote host')") // no hosted options
  })

  it('a greyed tab asks the joiner first, and a non-hosted tab falls through to the pairing prompt', () => {
    const body = between('const reconnectRelay = useCallback(', 'onError: (message)')
    expect(body.indexOf('if (hostedJoinerRef.current?.reconnectTab(projectId)) return')).toBeLessThan(
      body.indexOf('void reconnectRelayTab(projectId, {')
    )
    expect(body).toContain(`promptDialog({ message: "Paste the host's new pairing code:" })`)
    // R46: a join code pasted there goes to the joiner WITH this tab's id, which refuses to rebind a
    // tab it did not open (lib/hostedJoin.test.ts); a pairing offer is returned untouched.
    const divert = body.indexOf('hostedJoinerRef.current.joinWithCode(offer, projectId)')
    expect(divert).toBeGreaterThan(-1)
    expect(body.indexOf('return offer', divert)).toBeGreaterThan(divert)
  })

  it('the relay tab is built with hosted options, a long approval wait and no alert ONLY when hosted', () => {
    const body = between('const mountRemoteMirror = useCallback(', 'const confirmAndMount = useCallback(')
    const opts = between('        ...(hosted\n          ? {\n              hosted: true,', '          : {}),')
    expect(opts).toContain('timeoutMs: HOSTED_APPROVAL_WAIT_MS,')
    expect(opts).toContain('activate: hosted.activate,')
    expect(body).toContain(opts)
    expect(body).toContain('if (hosted) return { error: err, declined }')
    expect(body).toContain("window.alert(`Remote session did not open: ${(err as Error).message}`)")
  })

  it('a hosted team places one tab per shared project; a reconnect reuses the stale session\'s tabs', () => {
    const opts = between('        ...(hosted\n          ? {\n              hosted: true,', '          : {}),')
    expect(opts).toContain('const existing = staleSessionId ? projectIdsBoundToSession(staleSessionId) : []')
    expect(opts).toContain('return teamTabs.place({ hostId: hosted.hostId, label }, projects, existing, {')
    expect(opts).toContain('keepActive: !hosted.activate')
    expect(opts).toContain('...(hosted.focusProjectId ? { focusProjectId: hosted.focusProjectId } : {}),')
    const body = between('const mountRemoteMirror = useCallback(', 'const confirmAndMount = useCallback(')
    // Back online: every tab the connection serves un-greys, not just the one the reconnect named.
    expect(body).toContain('for (const id of tab.projectIds) useProjects.getState().setProjectUnavailable(id, false)')
    expect(body).toContain('return hosted ? { projectId: tab.projectId, projectIds: tab.projectIds } : null')
  })

  it('share events follow the host live: keep the screen, reconcile the joiner from the store either way', () => {
    const body = between('const mountRemoteMirror = useCallback(', 'const confirmAndMount = useCallback(')
    // The api is read once, right after the mount; the event's load never re-resolves it through a tab.
    const capture = body.indexOf('const bound = boundSessionForProject(tab.projectId)')
    const listen = body.indexOf('api.hosted.onSharedChanged((p) => {')
    expect(capture).toBeGreaterThan(-1)
    expect(listen).toBeGreaterThan(capture)
    const handler = body.slice(listen)
    expect(handler).not.toContain('sessionForProject(')
    expect(handler).toContain('async () => (await api.workspace.load()).projects.map(sanitizeRelayProject)')
    expect(handler).toContain('{ keepActive: true }')
    // A rejected event still closed tabs: the joiner is reconciled after it settles, resolved or not.
    const settled = handler.indexOf('.catch(() => {})')
    expect(settled).toBeGreaterThan(-1)
    expect(handler.indexOf('.then(() => {', settled)).toBeGreaterThan(settled)
    // The joiner follows a per-connection set (lib/hostedTeamTabs.test.ts `reconcileTeamTabs`), seeded
    // with the mount's tabs, never a per-event snapshot, and a share event never ends the team.
    expect(body.indexOf('let known = [...tab.projectIds]')).toBeGreaterThan(capture)
    expect(body.indexOf('let known = [...tab.projectIds]')).toBeLessThan(listen)
    expect(handler).toContain('const r = reconcileTeamTabs(known, teamTabIds())')
    expect(handler).toContain('known = r.known')
    expect(handler).toContain('joiner.tabsAdded(hostId, r.added)')
    expect(handler).toContain('for (const id of r.removed) joiner.tabRemoved(id, r.known[0])')
    expect(handler.slice(0, handler.indexOf('holdSessionTeardown('))).not.toContain('tabClosed(')
    expect(handler).not.toContain('const before =')
    // The subscription dies with the session.
    expect(handler).toContain('holdSessionTeardown(tab.sessionId, off)')
  })

  it('the team tab model runs on the store ops module (placeholder and removal: lib/hostedTeamTabStore.test.ts)', () => {
    const body = between('const [teamTabs] = useState<TeamTabs>(() => {', '    return tabs\n  })')
    expect(body).toContain('createTeamTabs(teamTabStoreOps((id) => tabs.teamOf(id)))')
    expect(src).not.toContain('function isOpenTab(')
    const store = readFileSync(new URL('../lib/hostedTeamTabStore.ts', import.meta.url), 'utf8')
    expect(store).toContain('const next = store.deleteProject(id)')
    expect(store).not.toContain('transport.destroy')
  })

  it('the joiner\'s mount names the team and where to land; the share flow joins through the joiner', () => {
    const joiner = between('const joiner = createHostedJoiner({', '}, [confirmAndMount])')
    expect(joiner).toContain('hostId: req.hostId,')
    expect(joiner).toContain('focusProjectId: req.focusProjectId ?? req.reconnectProjectId')
    const join = between('const joinApprovedTeam = useCallback(', '}, [])')
    expect(join).toContain('hostedJoinerRef.current?.joinApproved(code, focusProjectId ? { focusProjectId } : undefined)')
  })

  it('the joiner is created once and reconnects the approved bookmarks at boot', () => {
    const body = between('const joiner = createHostedJoiner({', '}, [confirmAndMount])')
    expect(body).toContain('createHostedJoiner({')
    expect(body).toContain('void joiner.bootReconnect()')
    expect(body).toContain('joiner.dispose()')
  })

  it('a read-only role never publishes canvas edits, and the rule is false for every non-hosted tab', () => {
    // ONE gate for the node publisher and the kanban publisher (Task 6): the read-only refusal lives
    // in `shouldPublishFor`, and the node publisher asks it for the active project.
    const start = src.indexOf('const shouldPublishFor = (projectId: string): boolean =>')
    expect(start).toBeGreaterThan(-1)
    const gate = src.slice(start, src.indexOf('const pub = createCanvasPublisher(', start))
    // The peer check, OR a project the host's canvas authority governs (authority-gate-wiring.test.ts).
    expect(gate).toContain('shouldPublish(hasPeersRef.current, governedRef.current, projectId) &&')
    expect(gate).toContain('!isHostedReadOnly(activeSession.id)')
    expect(src).toContain('shouldPublish: () => shouldPublishFor(useProjects.getState().activeProjectId)')
    expect(src).toContain('shouldPublish: (projectId) => shouldPublishFor(projectId)')
  })

  it('the canvas turns read-only only for a hosted Viewer/Commenter (a spread: nothing new otherwise)', () => {
    expect(src).toContain('{...(hostedReadOnly ? HOSTED_READ_ONLY_FLOW : {})}')
    expect(src).toContain('const hostedReadOnly = isReadOnlyRole(activeHosted?.role)')
    expect(src).toContain('{activeHosted && hostedReadOnly && (')
  })

  it('the owner dialog shows the queue head, one request at a time', () => {
    const body = between('{hostedHead && (', '{pendingPeer && (')
    expect(body).toContain('<HostedApprovalDialog')
    expect(body).toContain('key={hostedHead.pending.pendingId}')
  })

  it('R40: closing or deleting a tab stops its team\'s attempt (the one disposal both paths share)', () => {
    const body = between('const disposeRelayTabForProject = useCallback(', '}, [teamTabs])')
    expect(body).toContain('hostedJoinerRef.current?.tabClosed(projectId)')
    // …unless the team has other tabs open: then only this one goes, and the connection lives on.
    const multi = body.indexOf('const { remaining } = teamTabs.closeTab(projectId)')
    expect(multi).toBeGreaterThan(-1)
    expect(multi).toBeLessThan(body.indexOf('hostedJoinerRef.current?.tabClosed(projectId)'))
    expect(body).toContain('hostedJoinerRef.current?.tabRemoved(projectId, remaining[0])')
    // A connection that still serves other tabs keeps its entry, even for a tab it once served.
    expect(body).toContain('const othersBound = projectIdsBoundToSession(tab.sessionId).some((id) => id !== projectId)')
    expect(body).toContain('if (ours && !othersBound) relayTabsRef.current.delete(connectionId)')
    expect(body.indexOf('return', multi)).toBeLessThan(body.indexOf('disposeSession(s.id)'))
    expect(src).toContain('disposeRelayTabForProject(id)\n      store.closeProject(id)')
    expect(src).toContain('disposeRelayTabForProject(id)\n      store.deleteProject(id)')
  })

  it('R40: a hosted reconnect refuses to bind to a tab that is no longer open; a Team Access one is unchanged', () => {
    const body = between('const mountRemoteMirror = useCallback(', 'const confirmAndMount = useCallback(')
    expect(body).toContain('if (hosted && !isOpenTab(reconnectProjectId)) {')
    // A team whose tabs were ALL closed while it reconnected gets none of them back.
    expect(body).toContain('if (reconnectProjectId && !existing.some((id) => isOpenTab(id))) {')
    expect(body).toContain('return { id: reconnectProjectId } // reconnect: reuse the existing tab')
  })

  it('R40: the waiting notice is the joiner\'s (every hosted mount), not tied to the SAS dialog', () => {
    const body = between('const confirmAndMount = useCallback(', 'return mountRemoteMirror(')
    expect(body).not.toContain('waitingForOwnerText')
    expect(between('const joiner = createHostedJoiner({', '}, [confirmAndMount])')).toContain('clearNotice:')
  })

  it('R40: an owner\'s answer is settled only once the host answered', () => {
    const body = between('const answerHosted = useCallback(', '}, [])')
    expect(body).toContain('{ begin: q.beginAnswer, finish: q.finishAnswer }')
    expect(body).not.toContain('.settle(')
  })

  it('R41: the owner\'s wait starts only once the SAS was confirmed (hosted), and the joiner hears the SAS', () => {
    const body = between('const confirmAndMount = useCallback(', 'return mountRemoteMirror(')
    expect(body.indexOf('window.nodeTerminal.relayClient.confirm(connectionId)')).toBeLessThan(body.indexOf('hosted?.onSasConfirmed?.()'))
    const joiner = between('const joiner = createHostedJoiner({', '}, [confirmAndMount])')
    expect(joiner).toContain('onSas: (id, listener) =>')
    expect(joiner).toContain('onSasConfirmed: hooks.sasConfirmed')
  })
})
