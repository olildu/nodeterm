# Remote desk: work from one computer while another runs nodeterm

One machine, the **host**, does all the work: nodeterm, every agent and terminal (in tmux),
repos and builds. Any other device, the **viewer**, opens the same nodeterm canvas in a browser
and drives it. You sit at the viewer; the host stays on.

It is nodeterm's own Server Edition (see [SERVER.md](SERVER.md)) plus plain tools: an SSH tunnel
and a keep-awake command. No relay and no Pro: on a home or office network everything stays local.
`scripts/remote-desk.sh` wraps the whole thing in a few commands.

- Many terminals and agents at once, the same as on the host itself.
- Many viewers at once, all on one live canvas (with presence avatars).
- Close the browser and everything keeps running in tmux on the host.

| Role | Needs | Works on |
| --- | --- | --- |
| Host | this checkout, Node, tmux | macOS (the script). Linux works with the manual steps below |
| Viewer | a browser and `ssh` | any OS. A phone or tablet works with an SSH app |

## Install

On each Mac, from this checkout:

```sh
scripts/remote-desk.sh install
```

This links `remote-desk` into `~/.local/bin` and the agent skill into `~/.claude/skills/remote-desk`,
so Claude Code can help with setup and troubleshooting. Both are symlinks into this checkout, so a
`git pull` updates them. `remote-desk uninstall` removes them.

## First-time setup

1. **Remote Login on.** macOS: System Settings > General > Sharing > Remote Login. Allow only your
   user. Turn off "Allow full disk access for remote users": the tunnel does not need it.
   Turning this on needs an administrator, so it is always done by hand.
2. **SSH keys**, so no command asks for a password:
   - on the viewer: `remote-desk keys <you>@<host>.local`
   - on the host, only if you use emulators: `remote-desk keys <you>@<viewer>.local`
3. **Start the host once**: `remote-desk host start`. The first start prints a one-time setup link.
   Open it and choose the nodeterm password (at least 8 characters).

## A normal day

1. Host: `remote-desk host start`. It keeps the Mac awake for as long as the server runs.
2. Viewer: `remote-desk view <you>@<host>.local`. It opens the tunnel and the canvas at
   `http://127.0.0.1:8443`.
3. Work on the viewer. Every agent and terminal you open runs on the host.
4. Walk away: close the browser, or `remote-desk view stop`. Agents keep running in tmux.
5. Finished for good: `remote-desk host stop`. Agents still keep running in tmux; the next
   `host start` reattaches them.

`host start` options: `--build` rebuilds from this checkout first (it also builds automatically
the first time), `--force` allows a short test beside the desktop app (see below), and
`--canvas-control` turns on canvas control, which is off by default on the Server Edition. Turn
it on if your agents open nodes or report back to an orchestrator on the canvas; it lets agent
sessions act on the canvas.

## Rules that matter

- **One core per host.** The desktop app and the server share the `node-terminal` tmux socket
  (`src/core/tmux-naming.ts`). Run both and each one's idle-session reaper
  (`src/core/session-budget.ts`) can kill the other's detached sessions, and a project open in both
  fights over its terminals. And each one installs the agent hooks (`~/.nodeterm/agent-hooks`) and
  skills (`~/.claude/skills`, `~/.codex/skills`, …) pointing at itself when it starts, last start
  wins, so a server started beside the desktop app breaks the app's agent badges and canvas skill.
  `host start` refuses while the desktop app is open. `--force` allows a short test, turns the
  reaper off for that run, and `host stop` then reminds you to relaunch the desktop app, which
  restores its hooks and skills.
- **Switching back to the desktop app** needs nothing special: `remote-desk host stop`, then open
  the app. It rewrites the hooks and skills for itself when it starts.
- **Your canvases come along without an import.** A folder project keeps its canvas in
  `<repo>/.nodeterm/project.json`, and the server reads the same file. Add the same folders on the
  server (Open folder...). tmux sessions are named `nt-<node id>`, so running agents reattach.
  Not carried over: zoom, closed-session history, approvals, and folder-less projects.
- **Recent conversations** on the welcome screen list every Claude conversation on the host.
  Opening one that is still running elsewhere starts a second Claude on the same conversation.
- **The host must stay awake and reachable.** If it sleeps or leaves the network, the canvas
  freezes. Nothing is lost; it comes back when the host does.

## Android emulators on the viewer

Run the emulator where you sit and let agents on the host build onto it.

1. Viewer: boot the emulator.
2. Host: `remote-desk emu <you>@<viewer>.local 5555`. Each emulator's adb port is tunnelled to
   the host at port + 1000 and connected, so it appears in `adb devices` as `127.0.0.1:6555`.
   The script prints the AVD name it finds, so you can check it is the right one.
3. Host: `flutter run -d 127.0.0.1:6555`. Hot reload works.

- Second emulator: its port is 5557, so `remote-desk emu <viewer> 5555 5557`.
- The +1000 offset keeps the host's adb from treating a tunnel as a local emulator (adb scans
  5555-5585) and leaves those ports free for the host's own emulators.
- The script tunnels each emulator's adb port, not the viewer's adb server (5037): with a remote
  adb server, `adb forward` would open ports on the viewer and break hot reload and the debugger.
- adb has no real authentication. The tunnel keeps it off the network.
- Agents read and drive the screen with `adb -s 127.0.0.1:6555 exec-out screencap -p` and
  `adb shell input`, in place of the canvas `sim` verb.
- If your project cares which AVD runs what, pin each AVD to a port and check the printed name.

## Phone or tablet as a viewer

In an SSH app such as Termius:

1. Add the host by its wifi IP, with your user and Mac password.
2. Port Forwarding > Local: local port 8443, destination `127.0.0.1` port 8443, through that host.
3. Tap the rule to start it. Creating it does not start it.
4. Open `http://127.0.0.1:8443` in the browser. Use the IP, not `localhost`: Safari may try IPv6
   first and miss the forward.

iOS pauses SSH apps in the background, so the canvas may show "reconnecting" until you switch
back to the SSH app for a moment.

## What the browser does not have

Simulator nodes and the `sim` canvas-control verb (desktop-only), iOS simulators, the notch HUD
and native notifications.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `host start`: port in use | `lsof -nP -iTCP:8443`. Another server, or set `REMOTE_DESK_PORT` |
| `host start`: desktop app running | Quit it, or `--force` for a short test |
| Server did not start | The server log path is printed; `remote-desk status` shows it too |
| `view`: could not reach host | `ssh <you>@<host>.local` by hand. Remote Login on? Same network? |
| Tunnel up, nothing answers | The server is not running on the host: `remote-desk host start` there |
| Browser shows "reconnecting" | The host slept, the tunnel dropped, or (phone) the SSH app paused |
| `emu`: adb could not connect | Is the emulator running on the viewer, on that port? |
| Canvas looks old after a pull | `remote-desk host stop`, then `remote-desk host start --build` |

`remote-desk host status` lists connected viewers; "over ssh" means another device through a tunnel.

## Linux host (manual)

The script targets macOS (`caffeinate`, `scutil`). On Linux, run the same pieces by hand:
`npm run build && npm run server:build`, then `node out/server/main.cjs`, kept awake with
`systemd-inhibit` (or suspend disabled) and started on boot by a systemd user service. Viewers
connect with the same `ssh -N -L 8443:127.0.0.1:8443 <you>@<host>` tunnel.

## Settings

Environment variables, all optional:

| Variable | Meaning | Default |
| --- | --- | --- |
| `REMOTE_DESK_NODETERM` | nodeterm checkout to run the server from | the checkout the script lives in |
| `REMOTE_DESK_DATA` | server data folder | `~/.nodeterm-server` |
| `REMOTE_DESK_PORT` | canvas port | `8443` |
| `REMOTE_DESK_EMU_OFFSET` | local emulator port = emulator port + this | `1000` |
