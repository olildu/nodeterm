# sim-helper `attach` protocol (v0.1)

`sim-helper attach <udid>` is one long-lived controller per simulator device.

* **stdin** — newline-delimited JSON requests: `{"id":N,"cmd":"…", …}`. `id` is echoed back (any JSON value).
* **stdout** — ONLY length-prefixed messages: `u32be len | u8 type | payload`, where `len` counts the
  type byte plus the payload.
* **stderr** — human logs only, never parsed.

| type | payload |
|---|---|
| 1 video frame | `u64be captureMicros \| u16be w \| u16be h \| JPEG bytes` (`captureMicros` = Unix µs when the frame was composited) |
| 2 JSON | UTF-8 JSON: a reply (`id`, `ok`) or an unsolicited event (`event`) |
| 3 still image | `u32be imageId \| u8 fmt (1 jpeg, 2 png) \| u16be w \| u16be h \| bytes` — sent immediately BEFORE the JSON reply of a `screenshot` that names the same `imageId` |

Replies: `{"id":N,"ok":true,…}` or `{"id":N,"ok":false,"code":"…","error":"…"}`.
Events: `{"event":"…",…}`.

All coordinates are device **points**, origin top-left (iPhone 15: 393×852; pixels = points × `scale`).

## Commands

| cmd | fields | reply fields |
|---|---|---|
| `ping` | | `t` (helper Unix µs) |
| `info` | | `device`: `udid,name,runtime,state,deviceType,pixelWidth/Height,pointWidth/Height,scale,ready,streaming,helperVersion,pid` |
| `stream` | `on` (default true), `maxFps` (1–120, default 30), `scale` (0.05–1 of pixel size, default 0.5), `quality` (0.05–1, default 0.7) | `streaming`, `deviceReady`. Frames then arrive as type 1. A first frame is sent at once; a static screen sends nothing (frames byte-identical to the previous one are dropped); the encoder always encodes the newest surface (no backlog). Settings persist across a device shutdown/boot. `scale 0.33` ≈ 1 px per point. |
| `screenshot` | `format` `png`\|`jpeg` (default png), `scale` (0–1, default 1), `quality` | `imageId, format, width, height, bytes`; image arrives as type 3 first |
| `describe` | `flat` (default true) | `elements` (flat) or `tree`, plus `count, screen{width,height}, ms`; `partial`/`viaPoint` true when degraded (see below) |
| `describe-point` | `x, y` | `element` (or null), `ms` |
| `touch` | `phase` down\|move\|up, `x, y`, `edge`?, `quiet`? | `ms`. Down must be on-screen; move/up are clamped. `edge` (none/top/left/bottom/right) sets the system-gesture bits and is remembered from `down`. |
| `tap` | `x, y`, `holdMs`? | `ms` |
| `swipe` | `x1,y1,x2,y2`, `ms` (300), `steps` (20), `edge`? | `ms` |
| `pinch` | `cx, cy, r1, r2`, `ms` (400), `steps`, `angleDeg` (45) | `ms` |
| `button` | `name` home\|lock\|side\|siri\|volup\|voldown\|playpause, `holdMs`? | `ms`. `siri` is HID usage 0xCF; the legacy Siri source (crashes backboardd) is refused. |
| `key` | `usage` (HID page 7), `down`? (omit = press+release), `mods`? `["shift","ctrl","alt","cmd"]` | `ms` |
| `text` | `text`, `paste`? (force paste), `delayMs`? | `typed, pasted, ms`. Pure typable ASCII → keystrokes; any other character → the whole string via `simctl pbcopy` + Cmd+V (overwrites the device pasteboard). |
| `quit` | | `ok`, then the helper exits 0 |

`quiet: true` on touch/tap/etc. suppresses the success reply (errors always reply) — use it for pointer-move
streams. Input commands run in order on one queue; describe and screenshot run on their own queues.

Each `describe` element: `label, identifier, role, subrole, roleDescription, value, help, enabled,
frame{x,y,width,height}, depth, offscreen, clipped`, and for visible ones `visibleFrame` and `center` (tap target).
The tree covers the frontmost app only; rows scrolled off-screen are usually not listed at all.

### Degraded describe
The guest sometimes has no "frontmost application" (seen after typing into a focused search field and in some
post-boot states) although hit-testing works. The helper retries 4×250 ms, then falls back to a grid of
hit-tests (~50 pt spacing): leaves only, no containers, `partial:true, viaPoint:true`, ~1.5 s.

### Guest accessibility preference
Flutter and other lazy frameworks build their tree only when the guest says an assistive technology is on
(`com.apple.Accessibility ApplicationAccessibilityEnabled`). On attach the helper runs, once, in the background,
`xcrun simctl spawn <udid> defaults read com.apple.Accessibility ApplicationAccessibilityEnabled` and, unless it is
`1`, writes `ApplicationAccessibilityEnabled` and `AccessibilityEnabled` to `true` (XCUITest/Maestro leave explicit
zeros that nothing else overrides). Side effects: none visible (no VoiceOver, no UI change); the setting persists in
the device, so other tools see accessibility on. Apps read it at launch: the `describe` reply carries
`axPref: "on"` or `"enabled-now"` (just changed; relaunch apps started earlier).

## Events

| event | meaning |
|---|---|
| `ready` | device booted and capture + HID + AX set up; `device` = the `info` body. Sent again after every recovery. |
| `device-state` | `{state, booted}` on every CoreSimulator state change (Shutdown, Booting, Booted, Shutting Down). Teardown happens before this event; input then fails with `not-ready`. |
| `surfaces-changed` | framebuffer size changed: `pixelWidth/Height, pointWidth/Height, scale` |
| `error` | `{code, message, fatal?}` — `setup-failed` (retried every 0.5 s, reported once per distinct message), `stream-failed`, and fatal startup errors `no-xcode`, `already-attached`, `device-not-found` (process exits). |

## Error codes
`bad-request`, `unknown-command`, `out-of-bounds`, `no-touch`, `not-ready` (device not booted), `hid-failed`
(the HID client died; it is rebuilt automatically on the next command), `paste-failed`, `screenshot-failed`,
`no-translation`/`describe-failed`/`not-ready` (describe).

## Lifecycle
* One controller per UDID: an exclusive `flock` on `$TMPDIR/nodeterm-sim-helper-<UDID>.lock`. A second `attach`
  emits `error{code:"already-attached",fatal:true}` and exits 3. (Other exit codes: 4 device not found, 5 no Xcode.)
* Attaching to a Shutdown/Booting device is fine: the helper waits and emits `ready` when it boots.
* stdin EOF, SIGTERM/SIGINT or `quit`: a held touch is released, then exit 0.
* A private-API exception never crashes the helper; it becomes an error reply.

## Other modes
`sim-helper --version` · `sim-helper list` → JSON array `{udid,name,runtime,state,deviceType}`.
