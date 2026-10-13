import { randomUUID } from 'node:crypto'
import path, { join } from 'node:path'
import { normalizeSimUdid, simPlatformOf, type SimAgentEvent, type SimDeviceEntry, type SimStatus } from '../../shared/sim'
import type { AgentDevice, AgentFailure, AgentRunOptions, SimService } from './service'
import {
  createSimLinkLedger,
  defaultSimTarget,
  linkedSimulatorIds,
  shouldAutoLink,
  SIM_DRIVE_LINGER_MS,
  SIM_DRIVE_MAX_MS,
  type PairLike,
  type SimLinkLedger
} from './links'
import {
  describeDriveAction,
  SIM_CONTROL_REFUSAL,
  SIM_DRIVE_DONE,
  SIM_DRIVE_SETTLING,
  SIM_INPUT_ACTIONS,
  SIM_REACTION_MS,
  compactResult,
  compactScreen,
  describeResult,
  isFieldElement,
  parseOpenSimulatorArgs,
  parseSimArgs,
  readDescribe,
  renderCompactDiff,
  renderCompactText,
  renderDescribeText,
  renderElement,
  resolveElement,
  SIM_UNTRUSTED_NOTE,
  SIM_WAIT_FOR_POLL_MS,
  type CompactEntry,
  type CompactScreen,
  type ElementQuery,
  type SimAction,
  type SimCall,
  type SimElement
} from './verb'
import {
  buildVarMap,
  createMasker,
  FlowError,
  FLOW_DIR,
  isSecretVarName,
  loadFlow,
  maskDeep,
  type ElementRef,
  type FlowStep,
  type LoadedFlow
} from './flow'
import { classifyFailure, renderRunSummary, runFlow, type FlowRunResult, type StepOutcome } from './flow-run'
import { RECORD_MAX_AGE_MS, RECORD_STEPS_MAX, recordStep, renderRecording, startRecording, type Recording } from './flow-record'

/** What a running call reports to the node's driving chip (no-ops when nobody is shown the device). */
interface DriveProgress {
  /** Where the input lands, in device points (known only once a label is resolved). */
  point(p: { tap: { x: number; y: number } } | { swipe: { x1: number; y1: number; x2: number; y2: number } }): void
  /** The input is in; the call is now waiting for the screen to settle. */
  settling(): void
}

/**
 * The `sim` canvas-control verb, run: an agent looks at and drives an iOS Simulator (or an Android
 * emulator, through android-helper — same protocol) through the SAME
 * helper process the Simulator node watches (CLAUDE.md → Simulator node, "Agents drive it too").
 *
 * Answered entirely in the shell's control handler and never forwarded to a canvas — a device is a
 * machine fact, so no project tab is needed or touched (`control-off-screen`: store-answered). The
 * shell supplies the few things core cannot reach (the persisted nodes, the screenshot path jail
 * and the file write), so this file is Electron-free and the tests drive it with fakes.
 *
 * WHY THERE IS NO PER-PROJECT CONSENT SWITCH (unlike `browser`): a browser node holds the user's
 * logged-in sessions; a simulator is a throwaway device that holds nothing of the host's, and the
 * user watches every action live in the node. What an agent CAN reach is: the app under test and
 * its data, the device pasteboard (`--type` with a non-ASCII character pastes, which OVERWRITES
 * it), and files it writes under the project (`--screenshot`, jailed). Identity is still required:
 * verified callers only.
 */

export interface SimControlReply {
  ok: boolean
  message?: string
  error?: string
  result?: unknown
}

export interface SimControlDeps {
  service: Pick<SimService, 'agentRun' | 'devices' | 'boot' | 'availability'>
  /** The caller's OWNING project, by node membership in the shell's own persisted store. */
  projectIdOfNode(nodeId: string): string | undefined
  /** Simulator nodes of one project as persisted: id, title and the device they show (if chosen). */
  simulatorNodes(projectId: string): Array<{ id: string; title: string; udid?: string }>
  /** The project folder a screenshot path is jailed to (undefined for a folder-less canvas / SSH). */
  projectCwd(projectId: string): string | undefined
  /** The OS temp directory (default home of a `--screenshot` with no path). */
  tempDir(): string
  /** The shell's path jail: resolves a caller path to an absolute one INSIDE the project or the OS temp dir, or refuses. */
  resolvePath(cwd: string | undefined, raw: string): Promise<{ ok: true; abs: string } | { ok: false; message: string }>
  writeFile(abs: string, data: Buffer): Promise<void>
  /** The caller's project's persisted bridges (links). Absent = no link knowledge (every call needs a target). */
  bridges?(projectId: string): PairLike[]
  /** Can this node be linked to a Simulator node at all (a context-capable agent)? Absent = no. */
  canAutoLink?(nodeId: string): boolean
  /** Push to the renderer: a driving highlight, or a request to create a link. Absent = neither. */
  emit?(event: SimAgentEvent): void
  /** The per-run memory of auto-links and user removals; main shares it with the removal IPC. */
  ledger?: SimLinkLedger
  /** Read a flow file (already jailed by `resolvePath`), as text, at most ~128 KB of it. Absent = `--run` is unavailable. */
  readFile?(abs: string): Promise<string>
  /** The app's environment: a flow variable NAME falls back to `FLOW_NAME` here. Absent = none. */
  env?(): Record<string, string | undefined>
  now?(): number
  /** Wait between polls of a `--wait-for-ms` lookup (tests inject a virtual clock). */
  sleep?(ms: number): Promise<void>
}

/** A cold helper start is ~1 s; this only has to outlast a slow machine. */
const CONNECT_TIMEOUT_MS = 15_000

const fail = (error: string): SimControlReply => ({ ok: false, error, message: error })

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** "<udid>  "iPhone 15"  iOS 26.5  Booted" — one device, one line; a running emulator adds its adb serial. */
export function renderDeviceLine(
  d: SimDeviceEntry,
  nodes: Array<{ id: string; title: string; linked?: boolean }>
): string {
  const shown = nodes.length
    ? `  shown by node ${nodes
        .map((n) => `${n.id}${n.title ? ` ${JSON.stringify(n.title)}` : ''}${n.linked ? ' (linked to you)' : ''}`)
        .join(', ')}`
    : ''
  const serial = d.serial ? `  adb ${d.serial}` : ''
  return `${d.udid}  ${JSON.stringify(d.name)}  ${d.runtime}  ${d.booted ? 'Booted' : 'Shutdown'}${serial}${shown}`
}

const DEVICE_LIST_MAX = 40

/** Screens remembered per device for `--describe --since <hash>`, and devices remembered at all. */
const SNAPSHOTS_PER_DEVICE = 6
const SNAPSHOT_DEVICES_MAX = 16
/** Lines of the compact screen a flow failure report carries. */
const FLOW_FAILURE_SCREEN_LINES = 45

/** How a failed lease reads to the agent: a code it can branch on, then the sentence. */
export function failureReply(f: AgentFailure, udid: string): SimControlReply {
  switch (f.code) {
    case 'device-shutdown':
      return fail(`sim-device-shutdown: ${f.error} Boot it with: sim --udid ${udid} --boot`)
    case 'already-attached':
      return fail(
        `sim-busy: another program controls this device (a second nodeterm, or a tool that holds the simulator). ` +
          'Close it and retry.'
      )
    case 'device-not-found':
      return fail(`sim-device-not-found: no simulator or emulator ${udid} on this machine. \`sim --list\` shows the ones that exist.`)
    case 'unsupported':
    case 'no-helper':
    case 'no-xcode':
    case 'no-android-sdk':
      return fail(`sim-unavailable: ${f.error}`)
    case 'timeout':
      return fail(`sim-timeout: ${f.error} Retry in a few seconds.`)
    default:
      return fail(`sim-${f.code}: ${f.error}`)
  }
}

export function createSimControl(deps: SimControlDeps): (req: {
  nodeId: string
  args: Record<string, string>
  verified: boolean
}) => Promise<SimControlReply> {
  /** Devices the agent has already been told no node shows, so the hint is not repeated per call. */
  const hinted = new Set<string>()
  const ledger = deps.ledger ?? createSimLinkLedger()
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  /** The last few compact screens per device (insertion order = age), for `--since`. Bounded both ways. */
  const snapshots = new Map<string, Array<{ hash: string; entries: CompactEntry[] }>>()
  const remember = (udid: string, c: CompactScreen): void => {
    const list = (snapshots.get(udid) ?? []).filter((s) => s.hash !== c.hash)
    list.push({ hash: c.hash, entries: c.entries })
    while (list.length > SNAPSHOTS_PER_DEVICE) list.shift()
    snapshots.delete(udid)
    snapshots.set(udid, list)
    while (snapshots.size > SNAPSHOT_DEVICES_MAX) snapshots.delete(snapshots.keys().next().value as string)
  }

  /** The Simulator nodes of the caller's project it is linked to, in canvas order. */
  const linkedTo = (callerId: string, projectId: string | undefined): string[] =>
    projectId
      ? linkedSimulatorIds(
          callerId,
          deps.simulatorNodes(projectId).map((n) => n.id),
          deps.bridges?.(projectId) ?? [],
          ledger
        )
      : []

  const watchHint = (udid: string, shown: boolean): string => {
    if (shown || hinted.has(udid)) return ''
    hinted.add(udid)
    return (
      '\nNote: no Simulator node in this project shows this device, so the user cannot watch what you do. ' +
      'Ask them to add one (Add menu ▸ New view ▸ New simulator, then pick this device).'
    )
  }

  async function list(projectId: string | undefined, callerId: string): Promise<SimControlReply> {
    const found = await deps.service.devices()
    if (found.error && found.devices.length === 0) return fail(`sim-list-failed: ${found.error}`)
    const nodes = projectId ? deps.simulatorNodes(projectId) : []
    const linked = new Set(linkedTo(callerId, projectId))
    const byUdid = new Map<string, Array<{ id: string; title: string; linked: boolean }>>()
    for (const n of nodes) {
      if (!n.udid) continue
      byUdid.set(n.udid, [...(byUdid.get(n.udid) ?? []), { id: n.id, title: n.title, linked: linked.has(n.id) }])
    }
    const booted = found.devices.filter((d) => d.booted)
    const lines: string[] = [
      `iOS simulators and Android emulators on this machine: ${plural(found.devices.length, 'device')}, ${booted.length} booted. ` +
        'Act with --udid <id> or --node <Simulator node id>.'
    ]
    for (const d of found.devices.slice(0, DEVICE_LIST_MAX)) lines.push(renderDeviceLine(d, byUdid.get(d.udid) ?? []))
    if (found.devices.length > DEVICE_LIST_MAX) lines.push(`… ${found.devices.length - DEVICE_LIST_MAX} more shut-down devices not shown.`)
    if (linked.size) {
      lines.push(
        `Linked to you (your default target when you pass no --node/--udid): ${nodes
          .filter((n) => linked.has(n.id))
          .map((n) => `${n.id}${n.title ? ` ${JSON.stringify(n.title)}` : ''}`)
          .join(', ')}.`
      )
    }
    const bare = nodes.filter((n) => !n.udid)
    if (bare.length) {
      lines.push(`Simulator nodes with no device chosen yet: ${bare.map((n) => n.id).join(', ')}.`)
    }
    if (booted.length === 0) lines.push('Nothing is booted. Boot one with: sim --udid <id> --boot')
    else if (booted.every((d) => !byUdid.has(d.udid))) {
      lines.push('No Simulator node in this project shows a booted device; ask the user to add one so they can watch.')
    }
    return {
      ok: true,
      message: lines.join('\n'),
      result: {
        devices: found.devices.map((d) => ({
          udid: d.udid,
          name: d.name,
          runtime: d.runtime,
          booted: d.booted,
          nodes: (byUdid.get(d.udid) ?? []).map((n) => n.id)
        })),
        linked: [...linked]
      }
    }
  }

  /** The device a call resolved to, and the Simulator node(s) of the caller's project that show it. */
  interface Resolved {
    udid: string
    shown: boolean
    /** The ONE node this call is about (by --node, by default link, or the only node showing the --udid). */
    simNodeId?: string
    /** Every node of the project showing the device — what the driving highlight addresses. */
    shownBy: string[]
    /** The target came from the caller's link, not from a flag. */
    viaLink: boolean
  }

  /** Resolve the target to a device id, or the refusal to give. */
  function target(call: SimCall, projectId: string | undefined, callerId: string): Resolved | SimControlReply {
    const nodes = projectId ? deps.simulatorNodes(projectId) : []
    let t = call.target
    let viaLink = false
    if (!t) {
      const linked = linkedTo(callerId, projectId)
      const d = defaultSimTarget(linked)
      if (!d.ok && d.reason === 'several') {
        const titles = new Map(nodes.map((n) => [n.id, n.title]))
        return fail(
          `sim-ambiguous-target: you are linked to ${linked.length} Simulator nodes — pass --node <id>: ` +
            linked.map((id) => `${id}${titles.get(id) ? ` ${JSON.stringify(titles.get(id))}` : ''}`).join(', ') +
            '.'
        )
      }
      if (!d.ok) {
        return fail(
          'sim-no-target: pass --node <Simulator node id> or --udid <device id> (`sim --list` shows both). ' +
            'A Simulator node linked to you on the canvas becomes your default target, and your first ' +
            '--node call links it for you.'
        )
      }
      t = { by: 'node', node: d.node }
      viaLink = true
    }
    if (t.by === 'udid') {
      const showing = nodes.filter((n) => n.udid === t.udid).map((n) => n.id)
      return {
        udid: t.udid,
        shown: showing.length > 0,
        // Auto-link only when the device names exactly one node — two nodes showing it is a choice
        // the agent has not made, and a link is a statement about one of them.
        ...(showing.length === 1 ? { simNodeId: showing[0] } : {}),
        shownBy: showing,
        viaLink
      }
    }
    if (!projectId) {
      return fail('sim-no-project: this node is not in a saved project, so --node cannot be resolved. Use --udid <id> (`sim --list`).')
    }
    const node = nodes.find((n) => n.id === t.node)
    if (!node) {
      return fail(
        `sim-bad-node: ${t.node} is not a Simulator node in this project.` +
          (nodes.length
            ? ` Simulator nodes here: ${nodes.map((n) => n.id).join(', ')}.`
            : ' There are none; use --udid <id> (`sim --list`) and ask the user to add a Simulator node.')
      )
    }
    if (!node.udid) {
      return fail('sim-node-no-device: that Simulator node has no device chosen yet. Pick one in the node, or use --udid <id>.')
    }
    return { udid: node.udid, shown: true, simNodeId: node.id, shownBy: [node.id], viaLink }
  }

  /** After an input: wait for the screen to stop changing (unless `--no-wait true`) and say how it went. */
  async function settle(d: AgentDevice, call: SimCall, pr?: DriveProgress): Promise<string> {
    if (!call.wait) return 'not waited for (--no-wait)'
    pr?.settling()
    const r = await d.waitIdle({ quietMs: call.quietMs, timeoutMs: call.timeoutMs, reactionMs: SIM_REACTION_MS })
    if (!r.idle) return `screen still changing after ${r.waitedMs} ms (an animation or a load) — run --wait-idle or --describe`
    // (The docs say once that a slow app load can pause longer than the quiet window.)
    return r.changed ? `screen settled after ${r.waitedMs} ms` : `no visible change within ${r.waitedMs} ms`
  }

  function bounds(d: AgentDevice, points: Array<[number, number]>): string | null {
    const dev = d.status().device
    if (!dev || !(dev.pointWidth > 0) || !(dev.pointHeight > 0)) return null
    for (const [x, y] of points) {
      if (x < 0 || y < 0 || x > dev.pointWidth || y > dev.pointHeight) {
        return `sim-out-of-bounds: (${x},${y}) is outside the ${Math.round(dev.pointWidth)}×${Math.round(dev.pointHeight)} pt screen. Coordinates are device points; --describe prints them.`
      }
    }
    return null
  }

  /**
   * Find the element a label/id names, polling the tree for up to `--wait-for-ms` while it has not
   * appeared (or is not visible yet). An ambiguity is final: another poll cannot make it less so.
   */
  async function locate(
    d: AgentDevice,
    a: Extract<SimAction, { kind: 'tap-label' | 'tap-id' | 'type-label' }>,
    query: ElementQuery,
    prefer?: (e: SimElement) => boolean
  ): Promise<{ ok: true; element: SimElement } | { ok: false; reply: SimControlReply }> {
    const t0 = now()
    for (;;) {
      const desc = await d.command({ cmd: 'describe' })
      if (!desc.ok) return { ok: false, reply: helperFailure(desc, 'describe') }
      const read = readDescribe(desc)
      const hit = resolveElement(read.elements, query, { index: a.index, prefer })
      if (hit.ok) return { ok: true, element: hit.element }
      const waited = now() - t0
      if ((hit.reason === 'none' || hit.reason === 'unreachable') && waited < a.waitForMs) {
        await sleep(Math.min(SIM_WAIT_FOR_POLL_MS, a.waitForMs - waited))
        continue
      }
      return {
        ok: false,
        reply: fail(
          `sim-${a.kind}-${hit.reason}: ${hit.message}` +
            (a.waitForMs > 0 && (hit.reason === 'none' || hit.reason === 'unreachable') ? `\n(waited ${Math.round(waited)} ms for it to appear; --wait-for-ms changes that)` : '') +
            (read.partial && hit.reason === 'none' ? '\n(The tree was PARTIAL; run --describe again in a moment.)' : '')
        )
      }
    }
  }


  /**
   * Poll the tree for an element: until it is visible (`present`) or gone (`absent`), at most
   * `timeoutMs` (0 = look once). An element matched by several visible candidates is PRESENT — that
   * is a question about the screen, not an aim at one target.
   */
  async function probe(
    d: AgentDevice,
    ref: ElementRef,
    index: number | null,
    timeoutMs: number,
    mode: 'present' | 'absent'
  ): Promise<{ ok: true; waitedMs: number; element?: SimElement } | { ok: false; reply: SimControlReply }> {
    const t0 = now()
    const query: ElementQuery = { by: ref.by, text: ref.text }
    for (;;) {
      const desc = await d.command({ cmd: 'describe' })
      if (!desc.ok) return { ok: false, reply: helperFailure(desc, 'describe') }
      const read = readDescribe(desc)
      const hit = resolveElement(read.elements, query, { index })
      const visible = hit.ok || hit.reason === 'ambiguous'
      const waited = now() - t0
      if (mode === 'present' && visible) return { ok: true, waitedMs: waited, ...(hit.ok ? { element: hit.element } : {}) }
      if (mode === 'absent' && !visible) return { ok: true, waitedMs: waited }
      if (waited < timeoutMs) {
        await sleep(Math.min(SIM_WAIT_FOR_POLL_MS, timeoutMs - waited))
        continue
      }
      const what = `${ref.by} ${JSON.stringify(ref.text)}`
      if (mode === 'absent') {
        const shown = hit.ok ? renderElement(hit.element) : `${hit.candidates.length} elements`
        return { ok: false, reply: fail(`sim-assert-visible: ${what} is still on screen after ${Math.round(waited)} ms: ${shown}`) }
      }
      return {
        ok: false,
        reply: fail(
          `sim-wait-for-${hit.ok ? 'none' : hit.reason}: ${what} did not appear within ${Math.round(waited)} ms.\n${hit.ok ? '' : hit.message}` +
            (read.partial ? '\n(The tree was PARTIAL; run --describe again in a moment.)' : '')
        )
      }
    }
  }

  /** After a settled input: the compact screen, so the agent needs no separate --describe. */
  async function newScreen(d: AgentDevice, call: SimCall, udid: string): Promise<{ text: string; result?: Record<string, unknown> }> {
    if (!call.wait || call.noScreen) return { text: '' }
    const r = await d.command({ cmd: 'describe' })
    if (!r.ok) return { text: '' }
    const c = compactScreen(readDescribe(r))
    remember(udid, c)
    return { text: `\nScreen now:\n${renderCompactText(c)}`, result: compactResult(c) }
  }

  const helperFailure = (reply: { code?: unknown; error?: unknown }, what: string): SimControlReply =>
    fail(`sim-${typeof reply.code === 'string' ? reply.code : 'failed'}: ${what}: ${typeof reply.error === 'string' ? reply.error : 'the simulator refused'}`)

  async function act(d: AgentDevice, call: SimCall, projectId: string | undefined, udid: string, pr?: DriveProgress): Promise<SimControlReply> {
    const a = call.action
    switch (a.kind) {
      case 'describe': {
        const r = await d.command({ cmd: 'describe' })
        if (!r.ok) return helperFailure(r, 'describe')
        const read = readDescribe(r)
        if (a.full) return { ok: true, message: renderDescribeText(read), result: describeResult(read) }
        const c = compactScreen(read)
        const before = a.since ? snapshots.get(udid)?.find((s) => s.hash === a.since) : undefined
        remember(udid, c)
        if (a.since && before) {
          return { ok: true, message: renderCompactDiff(c, before.entries, a.since), result: { ...describeResult(read), ...compactResult(c), since: a.since, unchanged: c.hash === a.since } }
        }
        const lost = a.since
          ? `(hash ${a.since} is not remembered for this device — it is older than the last ${SNAPSHOTS_PER_DEVICE} screens, or from another session — so the whole screen follows)\n`
          : ''
        return { ok: true, message: lost + renderCompactText(c), result: { ...describeResult(read), ...compactResult(c) } }
      }
      case 'point': {
        const oob = bounds(d, [[a.x, a.y]])
        if (oob) return fail(oob)
        const r = await d.command({ cmd: 'describe-point', x: a.x, y: a.y })
        if (!r.ok) return helperFailure(r, 'describe-point')
        const read = readDescribe(r)
        const el = read.elements[0]
        return {
          ok: true,
          message: el
            ? `At (${a.x},${a.y}): ${renderElement(el)}\n${SIM_UNTRUSTED_NOTE}`
            : `Nothing exposes an accessibility element at (${a.x},${a.y}).`,
          result: describeResult(read)
        }
      }
      case 'screenshot': {
        const cwd = projectId ? deps.projectCwd(projectId) : undefined
        // No path given: a fresh file in the OS temp dir (the reply prints it).
        const raw = a.path ?? join(deps.tempDir(), `nodeterm-sim-${randomUUID()}.png`)
        const resolved = await deps.resolvePath(cwd, raw)
        if (!resolved.ok) return fail(resolved.message)
        const shot = await d.screenshot(call.scale)
        if (!shot.ok) return helperFailure(shot, 'screenshot')
        try {
          await deps.writeFile(resolved.abs, Buffer.from(shot.data))
        } catch {
          return fail(`sim: could not write the screenshot to ${resolved.abs}`)
        }
        const dev = d.status().device
        const pt = dev && dev.pointWidth > 0 ? `; the device is ${Math.round(dev.pointWidth)}×${Math.round(dev.pointHeight)} pt, so this image is ${(shot.width / dev.pointWidth).toFixed(2)} px per point` : ''
        const kb = Math.max(1, Math.round(shot.data.byteLength / 1024))
        return {
          ok: true,
          message: `wrote ${resolved.abs} (${shot.width}×${shot.height} px, ${kb} KB${pt}) — show it with: show-image ${resolved.abs}`,
          result: { path: resolved.abs, width: shot.width, height: shot.height, bytes: shot.data.byteLength }
        }
      }
      case 'tap': {
        const oob = bounds(d, [[a.x, a.y]])
        if (oob) return fail(oob)
        pr?.point({ tap: { x: a.x, y: a.y } })
        const r = await d.command({ cmd: 'tap', x: a.x, y: a.y })
        if (!r.ok) return helperFailure(r, 'tap')
        return { ok: true, message: `tapped (${a.x},${a.y}) — ${await settle(d, call, pr)}` }
      }
      case 'tap-label':
      case 'tap-id': {
        const found = await locate(d, a, a.kind === 'tap-id' ? { by: 'id', text: a.id } : { by: 'label', text: a.label })
        if (!found.ok) return found.reply
        const c = found.element.center as { x: number; y: number }
        pr?.point({ tap: { x: c.x, y: c.y } })
        const r = await d.command({ cmd: 'tap', x: c.x, y: c.y })
        if (!r.ok) return helperFailure(r, 'tap')
        const settled = await settle(d, call, pr)
        const screen = await newScreen(d, call, udid)
        return {
          ok: true,
          message: `tapped ${renderElement(found.element)} — ${settled}${screen.text}`,
          result: { x: Math.round(c.x), y: Math.round(c.y), ...(screen.result ? { screen: screen.result } : {}) }
        }
      }
      case 'type-label': {
        const found = await locate(d, a, { by: 'label', text: a.label }, isFieldElement)
        if (!found.ok) return found.reply
        const c = found.element.center as { x: number; y: number }
        pr?.point({ tap: { x: c.x, y: c.y } })
        const t = await d.command({ cmd: 'tap', x: c.x, y: c.y })
        if (!t.ok) return helperFailure(t, 'tap')
        // The keyboard rises and the field takes focus; typing before that lands in the old focus.
        await settle(d, call, pr)
        const r = await d.command({ cmd: 'text', text: a.text })
        if (!r.ok) return helperFailure(r, 'type')
        const pasted = typeof r.pasted === 'number' && r.pasted > 0
        const settled = await settle(d, call, pr)
        const screen = await newScreen(d, call, udid)
        return {
          ok: true,
          message:
            `typed ${plural(Array.from(a.text).length, 'character')} into ${renderElement(found.element)}` +
            (pasted ? ' (through the device pasteboard, which now holds that text)' : '') +
            ` — ${settled}${screen.text}`,
          result: { x: Math.round(c.x), y: Math.round(c.y), ...(screen.result ? { screen: screen.result } : {}) }
        }
      }
      case 'swipe': {
        const oob = bounds(d, [
          [a.x1, a.y1],
          [a.x2, a.y2]
        ])
        if (oob) return fail(oob)
        pr?.point({ swipe: { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 } })
        const r = await d.command({ cmd: 'swipe', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, ms: a.ms })
        if (!r.ok) return helperFailure(r, 'swipe')
        return { ok: true, message: `swiped (${a.x1},${a.y1}) → (${a.x2},${a.y2}) over ${a.ms} ms — ${await settle(d, call, pr)}` }
      }
      case 'type': {
        const r = await d.command({ cmd: 'text', text: a.text })
        if (!r.ok) return helperFailure(r, 'type')
        const typed = typeof r.typed === 'number' ? r.typed : 0
        const pasted = typeof r.pasted === 'number' ? r.pasted : 0
        const how =
          pasted > 0
            ? `${typed ? `typed ${plural(typed, 'character')} and ` : ''}pasted ${plural(pasted, 'character')} through the device pasteboard ` +
              '(characters a keyboard cannot type go that way, and the pasteboard now holds that text)'
            : `typed ${plural(typed || a.text.length, 'character')}`
        return { ok: true, message: `${how} — ${await settle(d, call, pr)}` }
      }
      case 'key': {
        const r = await d.command({ cmd: 'key', usage: a.usage, ...(a.mods.length ? { mods: a.mods } : {}) })
        if (!r.ok) return helperFailure(r, 'key')
        const label = `${a.mods.length ? `${a.mods.join('+')}+` : ''}${a.name}`
        return { ok: true, message: `pressed key ${label} — ${await settle(d, call, pr)}` }
      }
      case 'press': {
        const r = await d.command({ cmd: 'button', name: a.button })
        if (!r.ok) return helperFailure(r, 'press')
        return { ok: true, message: `pressed ${a.button} — ${await settle(d, call, pr)}` }
      }
      case 'wait-idle': {
        const r = await d.waitIdle({ quietMs: call.quietMs, timeoutMs: call.timeoutMs })
        return {
          ok: true,
          message: r.idle
            ? `screen settled (no change for ${call.quietMs} ms; waited ${r.waitedMs} ms)`
            : `screen still changing after ${r.waitedMs} ms — an animation or a load is running`,
          result: { idle: r.idle, waitedMs: r.waitedMs }
        }
      }
      case 'wait-for': {
        const r = await probe(d, { by: 'label', text: a.label }, null, a.waitForMs, 'present')
        if (!r.ok) return r.reply
        return { ok: true, message: `${JSON.stringify(a.label)} is on screen (${Math.round(r.waitedMs)} ms)` }
      }
      default:
        return fail(`sim: ${a.kind} is not a device action`)
    }
  }


  // ─── Flows: --run, --record, --record-stop ────────────────────────────────────────────────

  /** One recording per device, bounded: devices are few, steps are capped, and an old one is dropped. */
  const recordings = new Map<string, Recording>()
  const liveRecording = (udid: string): Recording | undefined => {
    const r = recordings.get(udid)
    if (r && now() - r.startedAt > RECORD_MAX_AGE_MS) {
      recordings.delete(udid)
      return undefined
    }
    return r
  }

  const jailMessage = (m: string): string => m.replace('--screenshot path', 'path')

  /** Resolve a flow path (or an include relative to `baseAbs`) through the shell's path jail. */
  const flowResolve =
    (cwd: string | undefined) =>
    async (baseAbs: string | null, rel: string): Promise<{ ok: true; abs: string } | { ok: false; message: string }> => {
      if (rel.length === 0 || rel.length > 1024) return { ok: false, message: 'the path is empty or too long' }
      const raw = baseAbs ? path.resolve(path.dirname(baseAbs), rel) : rel
      const r = await deps.resolvePath(cwd, raw)
      return r.ok ? r : { ok: false, message: jailMessage(r.message) }
    }

  /** The `--var` flags of a resume command: names only, never values. */
  const varFlagsFor = (vars: Array<[string, string]>): string =>
    vars.length ? ' ' + [...new Set(vars.map(([n]) => n))].map((n) => `--var ${n}=…`).join(' ') : ''

  function stepAction(step: FlowStep): SimCall | { error: string } {
    const parsed = parseSimArgs(step.args ?? {})
    return 'error' in parsed ? parsed : { ...parsed, noScreen: true }
  }

  async function runFlowOnDevice(
    d: AgentDevice,
    flow: LoadedFlow,
    action: Extract<SimAction, { kind: 'run' }>,
    udid: string,
    projectId: string | undefined,
    pr: DriveProgress | undefined,
    say: ((extra: Partial<Extract<SimAgentEvent, { kind: 'drive' }>>) => void) | undefined,
    mask: (s: string) => string
  ): Promise<{ run: FlowRunResult; runDir: string; shot: string | null; screen: string | null }> {
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const runDir = join(deps.tempDir(), `nodeterm-flow-${flow.name}-${stamp}`)
    const total = flow.steps.length
    const exec = async (step: FlowStep, remainingMs: number): Promise<StepOutcome> => {
      say?.({ action: `flow ${flow.name} ${step.index}/${total}: ${step.display}` })
      const wrap = (r: SimControlReply): StepOutcome => {
        if (r.ok) return { ok: true }
        const reason = r.error ?? r.message ?? 'the step failed'
        return { ok: false, reason, kind: classifyFailure(reason) }
      }
      if (step.op === 'sim') {
        const call = stepAction(step)
        if ('error' in call) return { ok: false, kind: 'other', reason: call.error }
        return wrap(await act(d, call, projectId, udid, pr))
      }
      if (step.op === 'screenshot') {
        const call = parseSimArgs({ screenshot: join(runDir, `${String(step.index).padStart(2, '0')}-${step.shot}.png`) })
        if ('error' in call) return { ok: false, kind: 'other', reason: call.error }
        return wrap(await act(d, call, projectId, udid, pr))
      }
      const c = step.check as NonNullable<FlowStep['check']>
      const r = await probe(d, c.ref, c.index, Math.min(c.timeoutMs, remainingMs), step.op === 'assert-not-visible' ? 'absent' : 'present')
      if (r.ok) return { ok: true }
      const reason = r.reply.error ?? r.reply.message ?? 'the step failed'
      return { ok: false, reason, kind: step.op === 'wait-for' ? classifyFailure(reason) : 'assert' }
    }
    const run = await runFlow({
      name: flow.name,
      steps: flow.steps,
      fromStep: action.fromStep,
      totalTimeoutMs: action.totalMs,
      exec,
      now,
      mask
    })
    let shot: string | null = null
    let screen: string | null = null
    if (run.failed) {
      const target = join(runDir, `failed-step-${String(run.failed.index).padStart(2, '0')}.png`)
      try {
        const cwd = projectId ? deps.projectCwd(projectId) : undefined
        const resolved = await deps.resolvePath(cwd, target)
        const img = resolved.ok ? await d.screenshot(0.5) : null
        if (resolved.ok && img && img.ok) {
          await deps.writeFile(resolved.abs, Buffer.from(img.data))
          shot = resolved.abs
        }
      } catch {
        /* a failure report without a screenshot is still a failure report */
      }
      try {
        const desc = await d.command({ cmd: 'describe' })
        if (desc.ok) {
          const c = compactScreen(readDescribe(desc))
          remember(udid, c)
          screen = renderCompactText(c).split('\n').slice(0, FLOW_FAILURE_SCREEN_LINES).join('\n')
        }
      } catch {
        /* same */
      }
    }
    return { run, runDir, shot, screen }
  }

  /** `--run`: load everything first (nothing touches the device on a bad flow), then replay under ONE lease. */
  async function runFlowAction(
    a: Extract<SimAction, { kind: 'run' }>,
    call: SimCall,
    nodeId: string,
    projectId: string | undefined
  ): Promise<SimControlReply> {
    if (!deps.readFile) return fail('sim-flow-unavailable: flows cannot be read in this build.')
    const cwd = projectId ? deps.projectCwd(projectId) : undefined
    const vars = buildVarMap(a.vars, deps.env?.() ?? {})
    // Masked from the first byte: every secret-NAMED variable we hold, used by this flow or not.
    const mask = createMasker([...vars].filter(([n]) => isSecretVarName(n)).map(([, v]) => v))
    const resolve = flowResolve(cwd)
    const root = await resolve(null, a.path)
    if (!root.ok) return fail(`sim-flow-path: ${root.message}`)
    let flow: LoadedFlow
    try {
      flow = await loadFlow(root.abs, { vars, io: { resolve, read: deps.readFile } })
    } catch (e) {
      if (e instanceof FlowError) return fail(`sim-flow-invalid: ${mask(e.message)}`)
      throw e
    }
    if (a.fromStep > flow.steps.length) {
      return fail(`sim-flow-invalid: --from-step ${a.fromStep} is past the last step (the flow has ${flow.steps.length}).`)
    }
    // The device: the command line wins, then the flow's own `device:`, then the caller's link.
    let c = call
    if (!c.target && flow.device) {
      const udid = normalizeSimUdid(flow.device)
      if (!udid) return fail(`sim-flow-invalid: the flow's device ${JSON.stringify(flow.device)} is not a simulator id.`)
      c = { ...c, target: { by: 'udid', udid } }
    }
    const t = target(c, projectId, nodeId)
    if ('ok' in t) return t
    const linkNote = autoLink(nodeId, projectId, t)
    const drive = t.shownBy.length > 0
    const say = drive
      ? (extra: Partial<Extract<SimAgentEvent, { kind: 'drive' }>>): void =>
          deps.emit?.({ kind: 'drive', ownerNodeId: nodeId, simNodeIds: t.shownBy, until: now() + SIM_DRIVE_MAX_MS, ...extra } as SimAgentEvent)
      : undefined
    const progress: DriveProgress = {
      point: (p) => say?.({ action: 'flow step', ...p }),
      settling: () => say?.({ action: SIM_DRIVE_SETTLING })
    }
    say?.({ action: `flow ${flow.name}` })
    const run = await deps.service.agentRun(t.udid, { connectTimeoutMs: CONNECT_TIMEOUT_MS }, (d) =>
      runFlowOnDevice(d, flow, a, t.udid, projectId, progress, say, mask)
    )
    if (drive) deps.emit?.({ kind: 'drive', ownerNodeId: nodeId, simNodeIds: t.shownBy, until: now() + SIM_DRIVE_LINGER_MS, action: SIM_DRIVE_DONE })
    if (!run.ok) return failureReply(run, t.udid)
    const { run: res, runDir, shot, screen } = run.value
    const lines = [`flow ${JSON.stringify(flow.name)} on ${t.udid} — ${flow.steps.length} step${flow.steps.length === 1 ? '' : 's'}${flow.files.length > 1 ? ` (${flow.files.length} files)` : ''}`, renderRunSummary(res)]
    if (res.failed) {
      const f = res.failed
      lines.push('', `FAILED step ${f.index}/${res.total} (${f.origin}): ${f.display}`, `reason: ${f.reason ?? 'unknown'}`)
      if (shot) lines.push(`screenshot: ${shot}`)
      if (screen) lines.push('screen now:', screen)
      lines.push(
        `resume after you fix it: sim --run ${a.path} --udid ${t.udid} --from-step ${f.index}${varFlagsFor(a.vars)}`,
        'Fix the step in the flow file (or do it by hand with --tap-label etc.), then resume — steps before it are not repeated.'
      )
    } else if (res.steps.some((s) => s.display.startsWith('screenshot'))) {
      lines.push(`screenshots: ${runDir}`)
    }
    const reply: SimControlReply = {
      ok: !res.failed,
      ...(res.failed ? { error: lines.join('\n') } : {}),
      message: lines.join('\n') + (res.failed ? '' : tailOf(t, linkNote)),
      result: {
        flow: flow.name,
        udid: t.udid,
        passed: res.passed,
        total: res.total,
        elapsedMs: res.elapsedMs,
        steps: res.steps.map((s) => ({ index: s.index, step: s.display, status: s.status, ms: s.ms, ...(s.reason ? { reason: s.reason } : {}) })),
        ...(res.failed ? { failedStep: res.failed.index, resume: `--from-step ${res.failed.index}`, ...(shot ? { screenshot: shot } : {}) } : {})
      }
    }
    return maskDeep(reply, mask)
  }

  const tailOf = (t: Resolved, linkNote: string): string => watchHint(t.udid, t.shown) + linkNote

  function startRecord(a: Extract<SimAction, { kind: 'record' }>, udid: string): SimControlReply {
    const live = liveRecording(udid)
    if (live) {
      return fail(
        `sim-recording-active: already recording ${JSON.stringify(live.name)} on this device (${live.steps.length} step${live.steps.length === 1 ? '' : 's'}). ` +
          'Finish it with: sim --record-stop'
      )
    }
    recordings.set(udid, startRecording(a.name, udid, now()))
    while (recordings.size > SNAPSHOT_DEVICES_MAX) recordings.delete(recordings.keys().next().value as string)
    return {
      ok: true,
      message:
        `recording ${JSON.stringify(a.name)} on ${udid}: the label-based actions you run on this device (--tap-label, --tap-id, --type-label, --swipe, --press, --key, --wait-for) ` +
        `are logged, ${RECORD_STEPS_MAX} at most. Finish with: sim --record-stop [--out <file.yaml>]`
    }
  }

  async function stopRecord(
    a: Extract<SimAction, { kind: 'record-stop' }>,
    udid: string,
    projectId: string | undefined
  ): Promise<SimControlReply> {
    const rec = liveRecording(udid)
    if (!rec) return fail('sim-no-recording: nothing is being recorded on this device. Start one with: sim --record <name>')
    if (rec.steps.length === 0) {
      return fail('sim-recording-empty: no steps were recorded yet — run some actions (--tap-label …) first. The recording is still on; --record-stop again when done.')
    }
    const cwd = projectId ? deps.projectCwd(projectId) : undefined
    const raw = a.out ?? (cwd ? `${FLOW_DIR}/${rec.name}.yaml` : null)
    if (!raw) return fail('sim-flow-path: this node has no project folder to hold .nodeterm/flows — pass --out <path>.yaml (inside the OS temp directory).')
    const resolved = await deps.resolvePath(cwd, raw)
    if (!resolved.ok) return fail(`sim-flow-path: ${jailMessage(resolved.message)}`)
    if (deps.readFile) {
      let exists = true
      try {
        await deps.readFile(resolved.abs)
      } catch {
        exists = false
      }
      if (exists) return fail(`sim-flow-exists: ${resolved.abs} already exists — it was not overwritten. Pass --out <another>.yaml (the recording is kept).`)
    }
    try {
      await deps.writeFile(resolved.abs, Buffer.from(renderRecording(rec), 'utf8'))
    } catch {
      return fail(`sim: could not write the flow to ${resolved.abs}`)
    }
    recordings.delete(udid)
    const todo = rec.steps.filter((s) => s.note?.startsWith('TODO')).length
    return {
      ok: true,
      message:
        `wrote ${resolved.abs} (${rec.steps.length} step${rec.steps.length === 1 ? '' : 's'}${rec.dropped ? `, ${rec.dropped} past the limit not kept` : ''}). ` +
        `Replay with: sim --run ${raw} --udid ${udid}${varFlagsFor([...rec.vars].map((n) => [n, '']))}` +
        (todo ? `\n${todo} step${todo === 1 ? '' : 's'} tap${todo === 1 ? 's' : ''} a coordinate (marked "TODO: use a label") — replace with a label if the element has one.` : '') +
        '\nRead the file before committing: typed text is written as typed (secret-looking fields are written as ${VARIABLES}). Add assert-visible steps for what must hold.',
      result: { path: resolved.abs, steps: rec.steps.length, name: rec.name }
    }
  }

  async function boot(udid: string, call: SimCall): Promise<SimControlReply> {
    const booted = await deps.service.boot(udid)
    if (!booted.ok) return fail(`sim-boot-failed: ${booted.error ?? 'the device could not be booted'}`)
    const opts: AgentRunOptions = { connectTimeoutMs: call.timeoutMs, tolerateShutdown: true }
    const run = await deps.service.agentRun(udid, opts, async (d) => d.status())
    if (!run.ok) {
      if (run.code === 'timeout' || run.code === 'device-shutdown') {
        return {
          ok: true,
          message: 'boot requested; the device is still starting. Run --describe in a few seconds (or --wait-idle).'
        }
      }
      return failureReply(run, udid)
    }
    const dev = (run.value as SimStatus).device
    const size = dev && dev.pointWidth > 0 ? `, screen ${Math.round(dev.pointWidth)}×${Math.round(dev.pointHeight)} pt` : ''
    return {
      ok: true,
      message:
        `booted ${dev?.name ?? udid}${size}. ` +
        (simPlatformOf(udid) === 'android'
          ? 'No emulator window was opened. nodeterm stops this emulator a few minutes after nothing shows or drives it.'
          : 'No Simulator window was opened.')
    }
  }

  /** Create the link a manual drag would have made, once, and tell the agent. '' = nothing to say. */
  function autoLink(callerId: string, projectId: string | undefined, r: Resolved): string {
    if (!projectId || !r.simNodeId || !deps.emit) return ''
    const linked = linkedTo(callerId, projectId)
    if (!shouldAutoLink(callerId, r.simNodeId, linked, ledger, deps.canAutoLink?.(callerId) ?? false)) return ''
    ledger.noteAutoLinked(callerId, r.simNodeId)
    deps.emit({ kind: 'auto-link', projectId, ownerNodeId: callerId, simNodeId: r.simNodeId })
    const title = deps.simulatorNodes(projectId).find((n) => n.id === r.simNodeId)?.title
    return (
      `\nLinked: Simulator node ${r.simNodeId}${title ? ` ${JSON.stringify(title)}` : ''} is now linked to you on the canvas — ` +
      'it is your default `sim` target (no --node needed while it is the only one), and the user can remove the link there.'
    )
  }

  return async ({ nodeId, args, verified }) => {
    if (!verified) return fail(SIM_CONTROL_REFUSAL)
    const call = parseSimArgs(args)
    if ('error' in call) return fail(call.error)
    const avail = deps.service.availability()
    if (!avail.ok) return fail(`sim-unavailable: ${avail.message}`)
    const projectId = deps.projectIdOfNode(nodeId)
    if (call.action.kind === 'list') return list(projectId, nodeId)
    if (call.action.kind === 'run') return runFlowAction(call.action, call, nodeId, projectId)
    const t = target(call, projectId, nodeId)
    if ('ok' in t) return t
    const linkNote = autoLink(nodeId, projectId, t)
    const tail = (): string => watchHint(t.udid, t.shown) + linkNote
    if (call.action.kind === 'record') return startRecord(call.action, t.udid)
    if (call.action.kind === 'record-stop') return stopRecord(call.action, t.udid, projectId)
    if (call.action.kind === 'boot') {
      const r = await boot(t.udid, call)
      return r.ok ? { ...r, message: (r.message ?? '') + tail() } : r
    }
    // The driving highlight: while an INPUT action runs (its settle wait included), then a short,
    // bounded linger. Reads (describe, screenshot) link but do not animate.
    const drive = SIM_INPUT_ACTIONS.has(call.action.kind) && t.shownBy.length > 0
    const phrase = describeDriveAction(call.action)
    const say = (extra: Partial<Extract<SimAgentEvent, { kind: 'drive' }>>): void =>
      deps.emit?.({ kind: 'drive', ownerNodeId: nodeId, simNodeIds: t.shownBy, until: now() + SIM_DRIVE_MAX_MS, ...extra })
    const progress: DriveProgress = {
      point: (p) => drive && say({ action: phrase, ...p }),
      settling: () => drive && say({ action: SIM_DRIVE_SETTLING })
    }
    if (drive) say({ action: phrase })
    const opts: AgentRunOptions = { connectTimeoutMs: CONNECT_TIMEOUT_MS }
    const run = await deps.service.agentRun(t.udid, opts, (d) => act(d, call, projectId, t.udid, progress))
    if (drive) deps.emit?.({ kind: 'drive', ownerNodeId: nodeId, simNodeIds: t.shownBy, until: now() + SIM_DRIVE_LINGER_MS, action: SIM_DRIVE_DONE })
    if (!run.ok) return failureReply(run, t.udid)
    const reply = run.value
    if (reply.ok) {
      const rec = liveRecording(t.udid)
      if (rec) recordStep(rec, call.action)
    }
    return reply.ok ? { ...reply, message: (reply.message ?? '') + tail() } : reply
  }
}

/**
 * `open-simulator`, MAIN's half: everything the renderer cannot know. The renderer creates the node
 * and draws the links; this decides whether it may (verified, macOS + helper) and which device the
 * node starts on. An explicit `--udid` is kept (a UDID not on this Mac is stored as given — the node
 * shows its own device-not-found); without one, exactly one Booted device is bound, else the node
 * is left unbound for its picker. Returns the args to forward, or the reply that ends the call.
 */
export function createOpenSimulatorPrep(
  deps: Pick<SimControlDeps, 'service'>
): (req: { args: Record<string, string>; verified: boolean }) => Promise<{ args: Record<string, string> } | SimControlReply> {
  return async ({ args, verified }) => {
    if (!verified) return fail(SIM_CONTROL_REFUSAL)
    const call = parseOpenSimulatorArgs(args)
    if ('error' in call) return fail(call.error)
    const avail = deps.service.availability()
    if (!avail.ok) return fail(`sim-unavailable: ${avail.message}`)
    const found = await deps.service.devices()
    const byUdid = call.udid ? found.devices.find((d) => d.udid === call.udid) : undefined
    let bound: { udid: string; name: string } | undefined
    if (call.udid) bound = { udid: call.udid, name: byUdid?.name ?? '' }
    else {
      const booted = found.devices.filter((d) => d.booted)
      if (booted.length === 1) bound = { udid: booted[0].udid, name: booted[0].name }
    }
    // An agent that opens an Android emulator wants to use it, and Android attach never boots (only the
    // helper's `boot` does), so start a shut-down AVD here. The node shows it starting; a failure is not
    // fatal to the open (the node keeps its Boot button and the agent's next `sim` says why).
    if (bound && simPlatformOf(bound.udid) === 'android' && !found.devices.find((d) => d.udid === bound.udid)?.booted) {
      await deps.service.boot(bound.udid).catch(() => undefined)
    }
    const next: Record<string, string> = { ...args }
    delete next.udid
    if (bound) {
      next.udid = bound.udid
      if (bound.name) next['device-name'] = bound.name
    }
    return { args: next }
  }
}
