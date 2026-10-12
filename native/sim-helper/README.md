# sim-helper

A native (Objective-C) helper that lets nodeterm see and drive an iOS Simulator **without Simulator.app**:
live screen frames, touch/button/keyboard input and the accessibility tree, over one stdio protocol per
device. See [PROTOCOL.md](PROTOCOL.md).

## Build

    npm run build:sim-helper            # → resources/bin/sim-helper (universal arm64 + x86_64, ad-hoc signed)
    node scripts/build-sim-helper.mjs --force --verbose --host-arch-only

Needs only the Xcode command line tools. The private frameworks are `dlopen`ed at run time, so the binary
builds anywhere and reports `no-xcode` where Xcode is missing. The output is gitignored; the build is cached
on a hash of the sources.

## Run

    resources/bin/sim-helper list
    resources/bin/sim-helper attach <udid>      # protocol on stdin/stdout
    node native/sim-helper/test/smoke.mjs [--recovery]   # needs a booted device

## Source layout (`src/`)
`main.m` controller (device-state polling, setup/teardown/recovery, command dispatch) · `protocol.m` framing ·
`device.m` frameworks, device lookup, lock · `capture.m` SimScreen → JPEG · `input.m` Indigo HID ·
`describe.m` AXPTranslator.

## Private-API risk
Everything rides CoreSimulator, SimulatorKit and AccessibilityPlatformTranslation, none of them public
(the same ones idb uses). Verified on Xcode 26.6 / iOS 26.5. A future Xcode can change selectors; the
helper checks for them and fails with a named error rather than crashing. Fallbacks if they break:
* screen: `xcrun simctl io <udid> screenshot -` in a loop (~10 fps, no Simulator.app needed);
* input: `simctl` has no touch API — use idb or Maestro as the fallback driver;
* tree: Maestro (`maestro hierarchy`, 10–45 s per call).
Rules baked in from the spike (see `PROTOCOL.md` and the comments): exact `objc_msgSend` prototypes,
ROCK proxies via direct sends not KVC, pick the display port with a non-zero size, never the legacy Siri
button source, drags need intermediate moves, `xcode-select -p` for the developer dir.

## Known limits
* Landscape/rotation is untested (touch ratios use the current surface size, which should follow it).
* The framebuffer is read without `IOSurfaceLock`; no tearing observed.
* `describe` can degrade to hit-test sampling (see PROTOCOL.md).
* One driver per device: another tool injecting input at the same time will interfere.
