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

## Android (`android-helper`)

`resources/bin/android-helper.cjs` (native/android-helper, run by Electron's Node with
`ELECTRON_RUN_AS_NODE=1`) speaks this same protocol for an Android emulator, so core treats both alike.
Differences, all MEASURED on emulator 36.6.11 (API 30 Nexus 7, API 30 Pixel):

* **Device id** `android:<avd>` (AVD name, `[A-Za-z0-9][A-Za-z0-9._-]*`, case kept). `info`/`ready` bodies add
  `platform: "android"`, `serial` (`emulator-<console port>`) and `owned` (this helper booted it).
* **Points**: `scale = density / 160` (Nexus 7: 320 dpi → 2, 1200×1920 px = 600×960 pt). Coordinates are points.
* **Attach never boots.** A shut-down AVD reports `device-state Shutdown`; the extra command **`boot`** starts it
  headless (`-no-window -no-audio -no-snapshot -no-boot-anim -gpu host -grpc P -port N`, free ports) and replies at
  once (`booting`, ports); `ready` follows when Android has booted (~18 s cold). `boot-failed` (non-fatal error
  event) when the emulator exits first, with the log's last error line. `-gpu host` matters: headless defaults
  to software rendering (20–30 fps); host GPU gives 48–60 fps.
* **`boot` is single-flight and checks liveness.** Overlapping `boot` requests share one launch (a second used to
  start a second emulator for the same AVD, which lost the AVD lock and left the ownership record on a dead pid).
  The emulator the monitor last adopted is re-checked against the discovery files first: one that was just killed
  is dropped (`device-state Shutdown`) and booted again instead of being answered `alreadyRunning`; an emulator for
  this AVD the monitor has not adopted yet also answers `alreadyRunning` and is never launched over.
  An emulator that is still dying (`adb emu kill` takes seconds; it stays alive and listed meanwhile) passes that check, so if
  one answered `alreadyRunning` disappears within 15 s (`REBOOT_WINDOW_MS`) the helper boots again, once, after the old
  process has exited (`owesReboot`).
* **Ownership**: on quit/EOF/SIGTERM the helper SIGTERMs only an emulator it booted (recorded in
  `$TMPDIR/nodeterm-android-helper-<avd>.owned.json`, so a crashed helper's successor still knows). An emulator
  someone else started is never stopped. One controller per AVD: `$TMPDIR/nodeterm-android-helper-<avd>.lock` (pid).
* **Found by** the emulator's discovery files (`…/avd/running/pid_*.ini`): a user-started emulator is used if it
  has gRPC; started without `-grpc`, or with JWT auth (Android Studio), it reports `setup-failed` with a sentence.
* **Frames**: gRPC `streamScreenshot` RGB888 at `scale` × pixel size → JPEG (sharp). The emulator sends a frame at
  once and nothing while static; the helper encodes the newest only, ≤ `maxFps`. Measured 44–46 fps at 600×960
  while scrolling, ~30 ms capture→stdout.
* **Input**: gRPC `sendTouch` (pressure 1/0; `edge` ignored — Android's edge gestures are ordinary touches),
  `sendKey` with W3C key names. `button`: `home`, `back`, `recents`, `power` (`lock`/`side` = power), `volup`,
  `voldown`; `siri`/`playpause` are refused. `key`: HID usages map to keys; **shift** picks the shifted
  character, **ctrl/alt/cmd are not applied** (the emulator's gRPC keys do not combine modifiers).
* **`text`**: printable ASCII via gRPC (newline = Enter). Anything else (or `paste: true`) goes through the
  emulator clipboard + `adb shell input keyevent 279` (KEYCODE_PASTE, ~0.5 s) — gRPC drops non-ASCII text and no
  gRPC Ctrl+V/Paste key pasted. It overwrites the device clipboard.
* **`describe`**: `adb exec-out uiautomator dump /dev/tty` (~1.5–2 s, retried while the screen animates), mapped to
  the element shape above: `label` = content-desc or text, `value` = text when both exist; for a `TextField`
  the typed text is always `value` and the label is content-desc, else `hint`, else empty (a password field's
  text is never reported). `identifier` = resource-id, `role` = class short name (`EditText` → `TextField`; a
  clickable generic container → `Button`; else `Element`). Elements may also carry `focused`, `checked`,
  `clickable`, `scrollable` (booleans, present only when true / checkable). The reply adds `keyboard` (boolean,
  from `dumpsys input_method` `mInputShown`; omitted when it could not be read). No `axPref`, no degraded mode.
  `describe-point` hit-tests that dump. iOS replies carry no `focused`/`keyboard`; nodeterm detects the iOS
  keyboard from a `Keyboard`-role element.
* **Flutter** (Posha, API 30, measured by the step-4 spike): labels show with NO accessibility setting changed —
  `uiautomator` connects as a UiAutomation client, Flutter builds its semantics for it, and nothing persists
  afterwards (`accessibility_enabled` stays 0). So there is no iOS-style attach-time switch, on purpose. Before a
  cold-started Flutter app draws its first frame the dump fails (`null root node`) or shows only the splash; an
  API 30 Flutter text field has no name (no content-desc, no hint), so pair it with the label above it.
* **No hardware keyboard → adb `input`.** gRPC `sendKey` is accepted and silently DROPPED on an AVD whose
  `hw.keyboard` is off — avdmanager's default, so most scripted AVDs — in native and Flutter fields alike
  (measured: the same AVD typed nothing with `no` and typed with `yes`). The helper reads the running instance's
  `<avd.dir>/hardware-qemu.ini` (`info.hardwareKeyboard`) and, when it is off, sends `text`/`key`/`button` as
  device-side `input` (runs of plain keycodes as ONE `input keyevent a b c`, other characters one quoted
  `input text` each — `input text` of a whole string drops characters into Flutter). About 0.5 s per call, so
  keys are slower there. It never edits the AVD's config.
* **Exit codes**: 3 already attached, 4 not an AVD / malformed id, 5 no Android SDK (`no-android-sdk`).
* `list` → `{udid, name, runtime ("Android 11"), state, deviceType, serial?}` per AVD (`emulator -list-avds`).
