import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { simPlatformOf, type SimAgentEvent, type SimDeviceEntry, type SimStatus } from '../../shared/sim'
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
  describeResult,
  parseOpenSimulatorArgs,
  parseSimArgs,
  readDescribe,
  renderDescribeText,
  renderElement,
  resolveTapLabel,
  SIM_UNTRUSTED_NOTE,
  type SimCall
} from './verb'

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
  now?(): number
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

  const helperFailure = (reply: { code?: unknown; error?: unknown }, what: string): SimControlReply =>
    fail(`sim-${typeof reply.code === 'string' ? reply.code : 'failed'}: ${what}: ${typeof reply.error === 'string' ? reply.error : 'the simulator refused'}`)

  async function act(d: AgentDevice, call: SimCall, projectId: string | undefined, pr?: DriveProgress): Promise<SimControlReply> {
    const a = call.action
    switch (a.kind) {
      case 'describe': {
        const r = await d.command({ cmd: 'describe' })
        if (!r.ok) return helperFailure(r, 'describe')
        const read = readDescribe(r)
        return { ok: true, message: renderDescribeText(read), result: describeResult(read) }
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
      case 'tap-label': {
        const desc = await d.command({ cmd: 'describe' })
        if (!desc.ok) return helperFailure(desc, 'describe')
        const read = readDescribe(desc)
        const hit = resolveTapLabel(read.elements, a.label)
        if (!hit.ok) {
          return fail(
            `sim-tap-label-${hit.reason}: ${hit.message}` +
              (read.partial && hit.reason === 'none' ? '\n(The tree was PARTIAL; run --describe again in a moment.)' : '')
          )
        }
        const c = hit.element.center as { x: number; y: number }
        pr?.point({ tap: { x: c.x, y: c.y } })
        const r = await d.command({ cmd: 'tap', x: c.x, y: c.y })
        if (!r.ok) return helperFailure(r, 'tap')
        return {
          ok: true,
          message: `tapped ${renderElement(hit.element)} — ${await settle(d, call, pr)}`,
          result: { x: Math.round(c.x), y: Math.round(c.y) }
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
      default:
        return fail(`sim: ${a.kind} is not a device action`)
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
    const t = target(call, projectId, nodeId)
    if ('ok' in t) return t
    const linkNote = autoLink(nodeId, projectId, t)
    const tail = (): string => watchHint(t.udid, t.shown) + linkNote
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
    const run = await deps.service.agentRun(t.udid, opts, (d) => act(d, call, projectId, progress))
    if (drive) deps.emit?.({ kind: 'drive', ownerNodeId: nodeId, simNodeIds: t.shownBy, until: now() + SIM_DRIVE_LINGER_MS, action: SIM_DRIVE_DONE })
    if (!run.ok) return failureReply(run, t.udid)
    const reply = run.value
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
    const next: Record<string, string> = { ...args }
    delete next.udid
    if (bound) {
      next.udid = bound.udid
      if (bound.name) next['device-name'] = bound.name
    }
    return { args: next }
  }
}
