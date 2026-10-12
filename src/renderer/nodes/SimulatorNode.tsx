/**
 * The simulator node: the host's iOS Simulator, drawn and driven inside a canvas node, with
 * Simulator.app never opened.
 *
 * The pixels come from `sim-helper` (core/sim) as JPEG frames pushed over a per-device channel and
 * drawn to a <canvas>; input goes back as touches in device POINTS. All the decisions live in pure
 * modules — `lib/simulatorView` (what to show), `lib/simPointer` (geometry), `lib/simKeyboard`
 * (keys), `lib/simFramePump` (newest-frame decoding) — so this file is wiring.
 *
 * **Who may drive it: the hover guard, exactly like a terminal.** A touch surface and a canvas both
 * answer to a drag, so the body is covered by the same `HoverGuard` a terminal uses until the user
 * means it: a quick drag moves the node and the wheel pans the canvas; a click, or (with sloppy
 * focus on, the default) a dwell of `panHoverDelay`, hands the glass over — then a drag is a swipe
 * on the phone and the wheel scrolls it. The two settings that already decide this for terminals
 * (`terminalFocusFollowsPointer`, `panHoverDelay`) decide it here, through the same pure helpers
 * (`lib/terminalFocusMode`), so a user does not learn two contracts. Unlike a terminal, the click
 * that disarms the guard is NOT forwarded as a tap: the first click only takes the node.
 *
 * **Keyboard** goes through a hidden <textarea> inside the node, focused when the guard drops. A
 * textarea (not a div) because an IME, dictation, the emoji picker and ⌘V all need an editable
 * element; it also keeps React Flow's delete/arrow shortcuts and the canvas dispatcher's bare-key
 * handling off it. ⌘/Ctrl chords are never claimed, so ⌘K, ⌘W, ⌘M … still reach the app
 * (`lib/simKeyboard`). Escape hands the keyboard back to the canvas.
 *
 * **Chrome that folds into the phone.** Only the phone is visible until the pointer (or focus)
 * enters: the frame, shadow and the terminal-style header are clipped away by a `clip-path` hugging
 * the screen (`lib/simNodeChrome.collapsedClip`, from the MEASURED screen box), and on hover the
 * clip grows out to the whole frame while the header rolls open and its buttons pop in. The header
 * is absolutely positioned in a strip that is ALWAYS reserved, so opening it never moves or resizes
 * the screen (and the stream canvas is never resized). The clip also hides hit-testing outside the
 * phone, so a collapsed node is moved by hovering it (the chrome opens) and dragging the header.
 * Chrome stays open while the node is selected / maximized / being edited / needs the user
 * (no device, shut down, connecting, error). All motion is a CSS transition or a FINITE animation,
 * gated by the app's idle gate and off under Reduce Motion (CLAUDE.md → Idle energy).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, useStore, type NodeProps } from '@xyflow/react'
import { useSimDrivingEntry } from '../state/simDriving'
import { useEdgeAnchorInsets } from '../state/edgeAnchorInsets'
import {
  normalizeSimUdid,
  parseSimFrame,
  simPlatformOf,
  type SimAvailability,
  type SimButton,
  type SimDeviceEntry,
  type SimStatus,
  type SimViewOptions
} from '@shared/sim'
import { NODE_MIN_SIZES } from '../lib/nodeSizing'
import { toggleCollapsed, type CanvasNode } from '../state/workspace'
import { MaximizeButton } from './MaximizeButton'
import { HoverGuard } from './HoverGuard'
import { NodeColorSwatches } from '../components/NodeColorSwatches'
import { ContextMenu, type MenuItem } from '../components/ContextMenu'
import { useSession } from '../session/session'
import { useSettings } from '../state/settings'
import {
  focusDrivesGuard,
  hoverTakesKeyboard,
  pointerLeaveRearmsGuard,
  resolveFocusFollowsPointer
} from '../lib/terminalFocusMode'
import { desiredStreamScale, simPickerRows, simView, viewLevel } from '../lib/simulatorView'
import {
  clientToDevice,
  cornerRadiusFraction,
  createMoveThrottle,
  edgeFor,
  fitScreen,
  pinchFor,
  wheelSwipe,
  type Box,
  type Point
} from '../lib/simPointer'
import { mapKeyEvent, textFromInput } from '../lib/simKeyboard'
import { createFramePump } from '../lib/simFramePump'
import {
  SIM_BORDER_TOP,
  SIM_BORDER_X,
  SIM_HEADER_H,
  chromePinnedOpen,
  clipPad,
  collapsedClip,
  deviceToScreenPx,
  expandedClip,
  rootBox
} from '../lib/simNodeChrome'

/** Layout fallback until the device reports its size (an iPhone 15, the common case). */
const FALLBACK_DEVICE: Box = { width: 393, height: 852 }
/** Wheel deltas are gathered this long, then sent as ONE swipe (a swipe occupies the input queue). */
const WHEEL_GATHER_MS = 70
const WHEEL_SWIPE_MS = 140
const FLASH_MS = 3500

const ICON = { width: 13, height: 13, viewBox: '0 0 16 16', 'aria-hidden': true } as const
const stroke = { stroke: 'currentColor', strokeWidth: 1.5, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' } as const

/** Hardware buttons in the header, in the order the design shows them. */
const IOS_BUTTONS: Array<{ name: SimButton; title: string; icon: JSX.Element }> = [
  { name: 'home', title: 'Home', icon: <svg {...ICON}><rect x="3" y="3" width="10" height="10" rx="3" {...stroke} /></svg> },
  {
    name: 'lock',
    title: 'Lock',
    icon: (
      <svg {...ICON}>
        <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" {...stroke} />
        <path d="M5.5 7V5a2.5 2.5 0 015 0v2" {...stroke} />
      </svg>
    )
  },
  {
    name: 'voldown',
    title: 'Volume down',
    icon: (
      <svg {...ICON}>
        <path d="M2.5 6h2.5l3-2.5v9L5 10H2.5z" {...stroke} strokeWidth={1.4} />
        <path d="M10 8h3.5" {...stroke} />
      </svg>
    )
  },
  {
    name: 'volup',
    title: 'Volume up',
    icon: (
      <svg {...ICON}>
        <path d="M2.5 6h2.5l3-2.5v9L5 10H2.5z" {...stroke} strokeWidth={1.4} />
        <path d="M11.75 6v4M9.75 8h4" {...stroke} />
      </svg>
    )
  },
  {
    name: 'siri',
    title: 'Siri',
    icon: (
      <svg {...ICON}>
        <rect x="5.5" y="2" width="5" height="8" rx="2.5" {...stroke} />
        <path d="M3.5 8a4.5 4.5 0 009 0M8 12.5V14" {...stroke} />
      </svg>
    )
  }
]
const VOLUME_BUTTONS = IOS_BUTTONS.filter((b) => b.name === 'voldown' || b.name === 'volup')
/** Android's navigation bar (back, home, recents) and its power + volume keys. */
const ANDROID_BUTTONS: Array<{ name: SimButton; title: string; icon: JSX.Element }> = [
  { name: 'back', title: 'Back', icon: <svg {...ICON}><path d="M11 3L5 8l6 5z" {...stroke} /></svg> },
  { name: 'home', title: 'Home', icon: <svg {...ICON}><circle cx="8" cy="8" r="4.5" {...stroke} /></svg> },
  { name: 'recents', title: 'Recent apps', icon: <svg {...ICON}><rect x="4" y="4" width="8" height="8" rx="1" {...stroke} /></svg> },
  {
    name: 'power',
    title: 'Power',
    icon: (
      <svg {...ICON}>
        <path d="M8 2.5V7.5" {...stroke} />
        <path d="M5 4.5a4.5 4.5 0 106 0" {...stroke} />
      </svg>
    )
  },
  ...VOLUME_BUTTONS
]
const SHOT_ICON = (
  <svg {...ICON}>
    <path d="M2.5 5.5V4a1.5 1.5 0 011.5-1.5h1.5M10.5 2.5H12A1.5 1.5 0 0113.5 4v1.5M13.5 10.5V12a1.5 1.5 0 01-1.5 1.5h-1.5M5.5 13.5H4A1.5 1.5 0 012.5 12v-1.5" {...stroke} />
    <circle cx="8" cy="8" r="1.8" fill="currentColor" />
  </svg>
)

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(out)
}

export function SimulatorNode({ id, data, selected, dragging }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements, setNodes, getNode } = useReactFlow()
  const { api } = useSession()
  const sim = api.sim

  const udid = useMemo(() => normalizeSimUdid(data.simUdid), [data.simUdid])
  const platform = udid ? simPlatformOf(udid) : 'ios'
  const buttons = platform === 'android' ? ANDROID_BUTTONS : IOS_BUTTONS
  const collapsed = !!data.collapsed
  const focusFollowsPointer = resolveFocusFollowsPointer(
    useSettings((s) => s.settings.terminalFocusFollowsPointer)
  )
  const panHoverDelay = useSettings((s) => s.settings.panHoverDelay)
  /** Canvas zoom, quantized: the stream is as sharp as the node is DRAWN, zoom included. */
  const zoom = useStore((s) => Math.ceil(s.transform[2] * 4) / 4)

  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const keysRef = useRef<HTMLTextAreaElement>(null)

  const [showColors, setShowColors] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleBefore, setTitleBefore] = useState('')
  const [autoBefore, setAutoBefore] = useState(true)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [availability, setAvailability] = useState<SimAvailability | null>(null)
  const [status, setStatus] = useState<SimStatus | null>(null)
  const [attachNonce, setAttachNonce] = useState(0)
  const [armed, setArmed] = useState(true)
  const [keyed, setKeyed] = useState(false)
  const [booting, setBooting] = useState(false)
  const [flash, setFlash] = useState('')
  const [bodySize, setBodySize] = useState<Box>({ width: 0, height: 0 })
  const [onScreen, setOnScreen] = useState(true)
  const [windowFocused, setWindowFocused] = useState(() => typeof document === 'undefined' || document.hasFocus())
  const [documentHidden, setDocumentHidden] = useState(() => typeof document !== 'undefined' && document.hidden)

  // ─── availability ────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let live = true
    void sim
      .availability()
      .then((a) => live && setAvailability(a))
      .catch(() => live && setAvailability({ ok: false, code: 'unsupported', message: 'The simulator is not available here.' }))
    return () => {
      live = false
    }
  }, [sim, attachNonce])

  // ─── what is being watched: on screen? window focused? ───────────────────────────────────
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) setOnScreen(e.isIntersecting)
    })
    io.observe(root)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    const sync = (): void => {
      setWindowFocused(document.hasFocus())
      setDocumentHidden(document.hidden)
    }
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])
  useEffect(() => {
    const body = bodyRef.current
    if (!body || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setBodySize({ width: body.clientWidth, height: body.clientHeight }))
    ro.observe(body)
    setBodySize({ width: body.clientWidth, height: body.clientHeight })
    return () => ro.disconnect()
  }, [collapsed])

  const device = status?.device
  const deviceBox: Box =
    device && device.pointWidth > 0 && device.pointHeight > 0
      ? { width: device.pointWidth, height: device.pointHeight }
      : FALLBACK_DEVICE
  const screenBox = useMemo(() => fitScreen(bodySize, deviceBox), [bodySize, deviceBox.width, deviceBox.height]) // eslint-disable-line react-hooks/exhaustive-deps
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  const scale = desiredStreamScale(screenBox.width * zoom, dpr, device?.pixelWidth ?? 0)
  const level = viewLevel({ onScreen, collapsed, documentHidden, windowFocused })
  const viewRef = useRef<SimViewOptions>({ level, scale })
  viewRef.current = { level, scale }

  // ─── attach: one helper per device, shared; frames drawn newest-first ───────────────────
  const live = availability?.ok === true
  useEffect(() => {
    // A different device (or a Reconnect) starts from "connecting", never from the last one's status.
    setStatus(null)
    if (!udid || !live) return
    let disposed = false
    const pump = createFramePump<ImageBitmap>({
      decode: (jpeg) => createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' })),
      draw: (bitmap, width, height) => {
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (!canvas || !ctx) return
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }
        ctx.drawImage(bitmap, 0, 0, width, height)
      },
      release: (bitmap) => bitmap.close(),
      ack: () => sim.ackFrame(udid)
    })
    // Subscribe BEFORE attaching: core pushes the last frame and the current status as part of it.
    const offStatus = sim.onStatus(udid, (s) => !disposed && setStatus(s))
    const offFrame = sim.onFrame(udid, (bytes) => {
      const frame = parseSimFrame(bytes)
      if (frame) pump.push(frame)
      else sim.ackFrame(udid) // unparseable, but core is still owed the ack
    })
    void sim
      .attach(udid, id, viewRef.current)
      .then((s) => !disposed && setStatus(s))
      .catch(() => undefined)
    return () => {
      disposed = true
      offStatus()
      offFrame()
      pump.dispose()
      sim.detach(udid, id)
    }
  }, [sim, udid, id, live, attachNonce])

  useEffect(() => {
    if (udid && live) sim.setView(udid, id, { level, scale })
  }, [sim, udid, id, live, level, scale])

  // A Reconnect or a different device is a new session: a booting flag from the last one is stale.
  useEffect(() => setBooting(false), [udid, attachNonce])
  useEffect(() => {
    if (status?.phase === 'connecting' || status?.phase === 'live') setBooting(false)
  }, [status?.phase])

  const flashRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const say = useCallback((text: string) => {
    setFlash(text)
    if (flashRef.current) clearTimeout(flashRef.current)
    flashRef.current = setTimeout(() => setFlash(''), FLASH_MS)
  }, [])
  useEffect(() => () => void (flashRef.current && clearTimeout(flashRef.current)), [])

  const view = simView({ availability, udid, status })
  const isLive = view.kind === 'live'

  // ─── the hover guard (see the header) ────────────────────────────────────────────────────
  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchingRef = useRef(false)
  const takeKeyboard = useCallback(() => {
    setArmed(false)
    keysRef.current?.focus({ preventScroll: true })
  }, [])
  const onBodyEnter = (): void => {
    if (dwellRef.current) clearTimeout(dwellRef.current)
    if (!hoverTakesKeyboard(focusFollowsPointer)) return
    dwellRef.current = setTimeout(takeKeyboard, panHoverDelay)
  }
  const onBodyLeave = (): void => {
    if (dwellRef.current) clearTimeout(dwellRef.current)
    // A gesture in progress keeps the glass: the pointer is captured, so leave is not "walked away".
    if (pointerLeaveRearmsGuard(focusFollowsPointer) && !touchingRef.current) setArmed(true)
  }
  useEffect(() => () => void (dwellRef.current && clearTimeout(dwellRef.current)), [])

  // ─── pointer → touch ─────────────────────────────────────────────────────────────────────
  const throttle = useRef(createMoveThrottle()).current
  const touch = useRef<{ pointerId: number; start: Point; alt: boolean; squeeze: boolean } | null>(null)

  const screenRect = (): DOMRect | null => screenRef.current?.getBoundingClientRect() ?? null
  const toDevice = (e: { clientX: number; clientY: number }, clamp: boolean): Point | null => {
    const r = screenRect()
    if (!r) return null
    return clientToDevice({ x: e.clientX, y: e.clientY }, { left: r.left, top: r.top, width: r.width, height: r.height }, deviceBox, { clamp })
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !udid || !isLive || touch.current) return
    const p = toDevice(e, false)
    if (!p) return
    e.currentTarget.setPointerCapture(e.pointerId)
    touch.current = { pointerId: e.pointerId, start: p, alt: e.altKey, squeeze: e.shiftKey }
    touchingRef.current = true
    keysRef.current?.focus({ preventScroll: true })
    if (e.altKey) return // a pinch is decided on release
    throttle.reset()
    sim.input(udid, { cmd: 'touch', phase: 'down', x: p.x, y: p.y, ...(edgeFor(p, deviceBox) ? { edge: edgeFor(p, deviceBox) } : {}) })
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const t = touch.current
    if (!t || t.pointerId !== e.pointerId || !udid || t.alt) return
    if (!throttle.take()) return
    const p = toDevice(e, true)
    if (p) sim.input(udid, { cmd: 'touch', phase: 'move', x: p.x, y: p.y })
  }
  const endTouch = (e: React.PointerEvent<HTMLDivElement>): void => {
    const t = touch.current
    if (!t || t.pointerId !== e.pointerId) return
    touch.current = null
    touchingRef.current = false
    if (!udid) return
    const p = toDevice(e, true) ?? t.start
    if (t.alt) {
      const pinch = pinchFor(t.start, p, t.squeeze)
      if (pinch) sim.input(udid, { cmd: 'pinch', ...pinch, ms: 350 })
      return
    }
    sim.input(udid, { cmd: 'touch', phase: 'up', x: p.x, y: p.y })
  }
  // The capture can be taken away (a menu opens, the window loses focus): never leave a finger down.
  const onLostCapture = (e: React.PointerEvent<HTMLDivElement>): void => endTouch(e)

  // ─── wheel → one swipe per gathered burst ────────────────────────────────────────────────
  const wheel = useRef<{ at: Point; dx: number; dy: number; timer: ReturnType<typeof setTimeout> | null; busyUntil: number }>({
    at: { x: 0, y: 0 },
    dx: 0,
    dy: 0,
    timer: null,
    busyUntil: 0
  })
  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    if (!udid || !isLive) return
    const p = toDevice(e, false)
    if (!p) return
    const w = wheel.current
    if (!w.timer) w.at = p
    w.dx += e.deltaX
    w.dy += e.deltaY
    if (w.timer) return
    w.timer = setTimeout(() => {
      w.timer = null
      const { dx, dy, at } = w
      w.dx = 0
      w.dy = 0
      const now = performance.now()
      if (now < w.busyUntil) return // the previous swipe is still running; drop, don't queue
      const swipe = wheelSwipe(at, dx, dy, deviceBox)
      if (!swipe) return
      w.busyUntil = now + WHEEL_SWIPE_MS + 40
      sim.input(udid, { cmd: 'swipe', ...swipe, ms: WHEEL_SWIPE_MS, steps: 8 })
    }, WHEEL_GATHER_MS)
  }
  useEffect(
    () => () => {
      const w = wheel.current
      if (w.timer) clearTimeout(w.timer)
    },
    []
  )

  // ─── keyboard ────────────────────────────────────────────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!udid || !isLive) return
    const action = mapKeyEvent(e.nativeEvent)
    if (!action) return // an app chord, or an IME key: let it bubble
    e.preventDefault()
    e.stopPropagation()
    if (action.kind === 'release') {
      keysRef.current?.blur()
      setArmed(true)
    } else if (action.kind === 'key') {
      sim.input(udid, { cmd: 'key', usage: action.usage, ...(action.mods.length ? { mods: action.mods } : {}) })
    } else {
      sim.input(udid, { cmd: 'text', text: action.text })
    }
  }
  /** Anything that arrives as INPUT rather than a key: IME commits, dictation, the emoji picker. */
  const flushTyped = (el: HTMLTextAreaElement): void => {
    const text = textFromInput(el.value)
    el.value = ''
    if (text && udid && isLive) sim.input(udid, { cmd: 'text', text })
  }
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    e.preventDefault()
    const text = textFromInput(e.clipboardData.getData('text/plain'))
    if (text && udid && isLive) sim.input(udid, { cmd: 'text', text, paste: true })
  }

  // ─── device picker, boot, buttons, screenshot ────────────────────────────────────────────
  const pickDevice = useCallback(
    (d: SimDeviceEntry): void => {
      updateNodeData(id, {
        simUdid: d.udid,
        simName: d.name,
        ...(data.titleAuto !== false ? { title: d.name } : {})
      })
      setAttachNonce((n) => n + 1)
    },
    [id, updateNodeData, data.titleAuto]
  )
  const openPicker = useCallback(
    async (anchor: HTMLElement): Promise<void> => {
      const r = anchor.getBoundingClientRect()
      let devices: SimDeviceEntry[] = []
      let error = ''
      try {
        const res = await sim.devices()
        devices = res.devices
        error = res.error ?? ''
      } catch {
        error = 'Could not list simulators.'
      }
      const rows = simPickerRows(devices, udid)
      const items: MenuItem[] =
        rows.length === 0
          ? [{ label: error || 'No simulators or emulators found', onClick: () => undefined, disabled: true }]
          : rows.map((r) =>
              r.kind === 'header'
                ? { label: r.label, onClick: () => undefined, disabled: true }
                : { label: r.label, onClick: () => pickDevice(r.device) }
            )
      setMenu({ x: r.left, y: r.bottom + 4, items })
    },
    [sim, udid, pickDevice]
  )
  const boot = async (): Promise<void> => {
    if (!udid || booting) return
    setBooting(true)
    const res = await sim.boot(udid).catch(() => ({ ok: false, error: 'Boot failed.' }))
    if (!res.ok) {
      setBooting(false)
      say(res.error ?? 'Boot failed.')
    }
  }
  const press = (name: SimButton): void => {
    if (udid && isLive) sim.input(udid, { cmd: 'button', name })
  }
  const screenshot = async (): Promise<void> => {
    if (!udid || !isLive) return
    const shot = await sim.screenshot(udid).catch(() => null)
    if (!shot || !shot.ok) {
      say(shot && !shot.ok ? shot.error : 'Screenshot failed.')
      return
    }
    // Saved where a pasted screenshot is (the swept upload area), and the PATH goes to the
    // clipboard — the same hand-off a screenshot paste into a terminal makes, which is what an agent
    // can read. Nothing lands in the project folder: a screenshot is not repository content.
    const name = `simulator-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
    const saved = await api.files.saveUpload(name, bytesToBase64(shot.data)).catch(() => null)
    if (!saved) {
      say('Could not save the screenshot.')
      return
    }
    window.nodeTerminal.clipboard.writeText(saved, { quiet: true })
    say('Screenshot saved — path copied')
  }

  const toggleCollapse = (): void => setNodes((ns) => toggleCollapsed(ns as CanvasNode[], [id]))
  // An agent is acting on this device through `sim` (bounded: the entry lapses on its own).
  const driving = useSimDrivingEntry(id)
  const drivingTitle = driving
    ? ((getNode(driving.ownerNodeId)?.data.title as string | undefined) || 'An agent')
    : ''
  const dot = isLive ? 'live' : view.kind === 'connecting' ? 'wait' : view.kind === 'error' ? 'error' : 'off'
  const radius = screenBox.width * cornerRadiusFraction(deviceBox, platform)

  // ─── chrome: open while the user works in it or the node needs them, else folded into the phone ──
  const pinned = chromePinnedOpen({
    selected: !!selected,
    maximized: !!data.premaxRect,
    needsUser: !isLive || collapsed,
    menuOpen: !!menu || showColors,
    editing: editingTitle,
    touching: keyed,
    dragging: !!dragging
  })
  const foldedClip = collapsedClip(bodySize, screenBox, radius, clipPad({ driving: !!driving, ring: !!selected || keyed }))
  const rootStyle = {
    '--sim-clip-folded': foldedClip ?? expandedClip(),
    '--sim-clip-open': expandedClip(),
    '--sim-header-h': `${SIM_HEADER_H}px`,
    '--sim-color': (data.color as string | undefined) ?? 'var(--accent)'
  } as React.CSSProperties
  // Links meet the PHONE, not the frame: the frame is invisible while folded, and a dot or a line end
  // a letterbox away from the device reads as detached. The phone never moves when the chrome opens
  // (the header strip is reserved), so anchoring to it always also means nothing jumps on hover.
  const phone = bodySize.width > 0 && screenBox.width > 0
    ? (() => {
        const root = rootBox(bodySize)
        const left = SIM_BORDER_X + screenBox.left
        const top = SIM_BORDER_TOP + SIM_HEADER_H + screenBox.top
        return {
          left,
          top,
          right: root.width - left - screenBox.width,
          bottom: root.height - top - screenBox.height,
          midY: top + screenBox.height / 2
        }
      })()
    : null
  const setAnchorInsets = useEdgeAnchorInsets((s) => s.set)
  const pl = phone ? Math.round(phone.left) : -1
  const pt = phone ? Math.round(phone.top) : -1
  const pr = phone ? Math.round(phone.right) : -1
  const pb = phone ? Math.round(phone.bottom) : -1
  useEffect(() => {
    setAnchorInsets(id, pl >= 0 && pt >= 0 && pr >= 0 && pb >= 0 ? { left: pl, top: pt, right: pr, bottom: pb } : null)
  }, [id, pl, pt, pr, pb, setAnchorInsets])
  useEffect(() => () => setAnchorInsets(id, null), [id, setAnchorInsets])
  const handleY = phone ? { top: phone.midY } : undefined
  const tapPx = driving?.tap ? deviceToScreenPx(driving.tap, deviceBox, screenBox) : null
  const swipe = driving?.swipe
  const swipeFrom = swipe ? deviceToScreenPx({ x: swipe.x1, y: swipe.y1 }, deviceBox, screenBox) : null
  const swipeTo = swipe ? deviceToScreenPx({ x: swipe.x2, y: swipe.y2 }, deviceBox, screenBox) : null
  const runtime = device?.runtime || 'Device'

  return (
    <>
    <div
      ref={rootRef}
      className={`sim-node${pinned ? ' is-open' : ''}${selected ? ' selected' : ''}${collapsed ? ' collapsed' : ''}${keyed ? ' keyed' : ''}${driving ? ' driving' : ''}`}
      style={rootStyle}
    >
      {/* Paint only: the old resize box in its old place (see .nt-resize-ghost in styles.css). */}
      <NodeResizer isVisible={selected && !collapsed} color={data.color as string} lineClassName="nt-resize-ghost" handleClassName="nt-resize-ghost" />
      {/* The terminal node's header: the same metrics, the same 22px icon buttons. Its strip is
          reserved (absolute, SIM_HEADER_H) so rolling it open never moves the screen. */}
      <div className="sim-node__header term-node__header">
        <button className="term-node__collapse nodrag" title={collapsed ? 'Expand' : 'Collapse'} aria-label={collapsed ? 'Expand' : 'Collapse'} onClick={toggleCollapse}>
          {collapsed ? '▸' : '▾'}
        </button>
        <button
          className="term-node__color nodrag"
          style={{ background: data.color as string }}
          title="Color"
          aria-label="Node color"
          onClick={() => setShowColors((v) => !v)}
        />
        {showColors && (
          <NodeColorSwatches
            className="color-popover"
            selected={data.color as string | undefined}
            onPick={(c) => {
              updateNodeData(id, { color: c })
              setShowColors(false)
            }}
          />
        )}
        {editingTitle ? (
          <input
            className="term-node__title nodrag"
            value={(data.title as string) ?? ''}
            spellCheck={false}
            autoFocus
            onChange={(e) => updateNodeData(id, { title: e.target.value, titleAuto: false })}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                setEditingTitle(false)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                updateNodeData(id, { title: titleBefore, titleAuto: autoBefore })
                setEditingTitle(false)
              }
            }}
          />
        ) : (
          <span
            className="term-node__title-text nodrag"
            title="Click to rename"
            onClick={() => {
              setTitleBefore((data.title as string) ?? '')
              setAutoBefore(data.titleAuto !== false)
              setEditingTitle(true)
            }}
          >
            {(data.title as string) || 'Simulator'}
          </span>
        )}
        <button
          className="sim-node__chip nodrag"
          title={`${view.title}${view.detail ? ` — ${view.detail}` : ''} · choose device`}
          aria-label="Choose device"
          onClick={(e) => void openPicker(e.currentTarget)}
        >
          <span className={`sim-node__dot sim-node__dot--${dot}`} aria-hidden />
          {runtime}
          <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {!editingTitle && <span className="term-node__spacer" />}
        {buttons.map((b) => (
          <button
            key={b.name}
            className="term-node__refresh sim-node__tool nodrag"
            title={b.title}
            aria-label={b.title}
            disabled={!isLive}
            onClick={() => press(b.name)}
          >
            {b.icon}
          </button>
        ))}
        <button
          className="term-node__refresh sim-node__tool nodrag"
          title="Screenshot — saves a PNG and copies its path"
          aria-label="Screenshot"
          disabled={!isLive}
          onClick={() => void screenshot()}
        >
          {SHOT_ICON}
        </button>
        {!collapsed && <MaximizeButton id={id} maximized={!!data.premaxRect} />}
        <button className="term-node__close nodrag" title="Close" aria-label="Close" onClick={() => deleteElements({ nodes: [{ id }] })}>
          ×
        </button>
      </div>

      {!collapsed && (
        <div
          ref={bodyRef}
          className="sim-node__body"
          onMouseEnter={onBodyEnter}
          onMouseLeave={onBodyLeave}
        >
          <div
            ref={screenRef}
            className={`sim-node__screen${isLive && !armed ? ' nodrag nowheel' : ''}${driving ? ' driving' : ''}`}
            style={{
              left: screenBox.left,
              top: screenBox.top,
              width: screenBox.width,
              height: screenBox.height,
              borderRadius: radius
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endTouch}
            onPointerCancel={endTouch}
            onLostPointerCapture={onLostCapture}
            onWheel={onWheel}
          >
            <canvas ref={canvasRef} className="sim-node__canvas" />
            {/* The agent's touch, at the real point: a dot that springs in and two ripples. A new
                `seq` remounts it so the next tap replays. */}
            {tapPx && driving?.tap && (
              <span key={`tap-${driving.tap.seq}`} className="sim-node__tap" style={{ left: tapPx.x, top: tapPx.y }} aria-hidden>
                <span className="sim-node__tap-ripple" />
                <span className="sim-node__tap-ripple sim-node__tap-ripple--2" />
                <span className="sim-node__tap-dot" />
              </span>
            )}
            {swipeFrom && swipeTo && swipe && (
              <svg
                key={`swipe-${swipe.seq}`}
                className="sim-node__swipe"
                width={screenBox.width}
                height={screenBox.height}
                viewBox={`0 0 ${screenBox.width} ${screenBox.height}`}
                aria-hidden
              >
                <line x1={swipeFrom.x} y1={swipeFrom.y} x2={swipeTo.x} y2={swipeTo.y} pathLength={1} />
                <circle cx={swipeTo.x} cy={swipeTo.y} r={7} />
              </svg>
            )}
          </div>

          {/* Same overlay a terminal uses (shared class, shared component): while it is up a
              quick drag moves the node and the wheel pans the canvas. */}
          {armed && (
            <HoverGuard
              onPress={() => dwellRef.current && clearTimeout(dwellRef.current)}
              onClick={takeKeyboard}
              onDragEnd={onBodyEnter}
            />
          )}

          {!isLive && (
            <div className="sim-node__overlay">
              <div className="sim-node__card">
                <div className="sim-node__card-title">{booting ? 'Booting…' : view.title}</div>
                {view.detail && !booting && <div className="sim-node__card-detail">{view.detail}</div>}
                {view.action === 'pick' && (
                  <button className="sim-node__action nodrag" onClick={(e) => void openPicker(e.currentTarget)}>
                    Choose device
                  </button>
                )}
                {view.action === 'boot' && !booting && (
                  <button className="sim-node__action nodrag" onClick={() => void boot()}>
                    Boot
                  </button>
                )}
                {view.action === 'reconnect' && (
                  <button className="sim-node__action nodrag" onClick={() => setAttachNonce((n) => n + 1)}>
                    Reconnect
                  </button>
                )}
              </div>
            </div>
          )}
          {/* The flash and the helper's notice share one unobtrusive toast over the bottom of the glass. */}
          {(flash || (view.notice && isLive)) && (
            <div className="sim-node__toast" role="status" style={{ left: screenBox.left + 8, width: Math.max(0, screenBox.width - 16), bottom: bodySize.height - screenBox.top - screenBox.height + 14 }}>
              {flash || view.notice}
            </div>
          )}

          <textarea
            ref={keysRef}
            className="sim-node__keys nokey"
            aria-label="Simulator keyboard input"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onCompositionEnd={(e) => flushTyped(e.currentTarget)}
            onInput={(e) => {
              if (!(e.nativeEvent as InputEvent).isComposing) flushTyped(e.currentTarget)
            }}
            onPaste={onPaste}
            onFocus={() => setKeyed(true)}
            onBlur={() => {
              setKeyed(false)
              if (focusDrivesGuard(focusFollowsPointer)) setArmed(true)
            }}
          />
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
    {/* Who is driving, ABOVE the node and outside the clip so it shows while the chrome is folded.
        Siblings of the root, like the handles and the resizer. */}
    {driving && (
      <div
        className="sim-node__drivechip"
        role="status"
        aria-live="polite"
        // Folded, the frame and header are invisible: sit just above the PHONE, not above the frame.
        style={phone ? ({ '--sim-phone-top': `${Math.round(phone.top)}px` } as React.CSSProperties) : undefined}
      >
        <span className="sim-node__drivechip-live" aria-hidden />
        <span className="sim-node__drivechip-who">{drivingTitle}</span>
        {driving.action && <span className="sim-node__drivechip-what">{driving.action}</span>}
      </div>
    )}
    {/* Link handles, as on a terminal / sticky node: drag to or from an agent so the device becomes
        that agent's default `sim` target. Siblings after the root (a glass root is a containing
        block that would clip them), and never inside the clip, so the links stay visible while the
        chrome is folded. They sit on the frame's sides: an edge meets the node's side midpoints
        (FloatingEdge), so when folded the line ends a letterbox short of the phone's edge rather
        than jumping between two anchors. */}
    <Handle
      id="link-out"
      type="source"
      position={Position.Right}
      className="bridge-handle bridge-handle--out bridge-handle--sim"
      style={phone ? { ...handleY, right: phone.right - 8 } : undefined}
      data-tip="Link out — drag to an agent so this device is its default sim target"
    />
    <Handle
      id="link-in"
      type="target"
      position={Position.Left}
      className="bridge-handle bridge-handle--in bridge-handle--sim"
      style={phone ? { ...handleY, left: phone.left - 8 } : undefined}
      data-tip="Link in — drop an agent's link here so it drives this device by default"
    />
    {/* Sibling of the root, after it (see FilesNode): focus mode reparents the root, and the
        glass appearance makes the root a containing block that would clip these edges. */}
    <NodeResizer
      minWidth={NODE_MIN_SIZES.simulator.width}
      minHeight={NODE_MIN_SIZES.simulator.height}
      isVisible={selected && !collapsed}
      color={data.color as string}
    />
    </>
  )
}
