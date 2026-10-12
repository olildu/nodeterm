# android-helper

The Android emulator's counterpart of `sim-helper`: lets nodeterm see and drive an AVD **without the
emulator window** — live screen frames, touch/button/keyboard input and the UI tree — over the SAME stdio
protocol as the iOS helper ([../sim-helper/PROTOCOL.md](../sim-helper/PROTOCOL.md), "Android" section), so
the sim service, the `sim` verb and the Simulator node treat both platforms alike.

## Build / run

    npm run build:android-helper          # → resources/bin/android-helper.cjs (esbuild, one file)
    node resources/bin/android-helper.cjs list
    node resources/bin/android-helper.cjs attach android:<avd>
    node native/android-helper/test/smoke.mjs [--avd <name>] [--boot <shut-down avd>]

nodeterm runs it with Electron's own Node (`ELECTRON_RUN_AS_NODE=1`). No runtime dependencies except
nodeterm's `sharp` (JPEG/PNG encoding), resolved from the app (`NODETERM_REQUIRE_FROM`) or the repo.

## How
* **Screen + input**: the emulator's gRPC `EmulatorController` (`streamScreenshot` RGB888 → sharp JPEG,
  `sendTouch`, `sendKey`, `setClipboard`), spoken with a hand-rolled protobuf/gRPC client over
  `node:http2` (`src/grpc.ts`) — no grpc-js, no .proto to ship.
* **UI tree**: `adb exec-out uiautomator dump /dev/tty` (~1.5 s), parsed into the iOS element shape.
* **Finding emulators**: the emulator's own discovery files (`…/avd/running/pid_<pid>.ini`), so a
  user-started emulator is found like ours. An emulator started without `-grpc`, or with JWT auth
  (Android Studio), cannot be shown; the node says so.
* **Boot**: `emulator -avd X -no-window -no-audio -no-snapshot -no-boot-anim -gpu host -grpc P -port N` on
  free ports. Headless defaults to software rendering (20–30 fps); `-gpu host` gives 48–60 fps.
* **Ownership**: only an emulator THIS helper booted (recorded in `$TMPDIR`, surviving a helper crash) is
  stopped on quit. A user-started one is never stopped.

## Source layout (`src/`)
`main.ts` controller + protocol · `grpc.ts` protobuf/gRPC · `sdk.ts` SDK, AVDs, discovery, ports ·
`uiautomator.ts` dump → elements · `keys.ts` HID usage / button → W3C key.
