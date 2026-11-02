---
name: remote-desk
description: Set up or fix nodeterm on a second computer, where one machine runs nodeterm and the agents (the host) and another opens the same canvas in a browser (the viewer). Use when the user wants to work from another Mac, PC, phone or tablet, connect two Macs, reach the canvas over wifi or SSH, run Android emulators on the machine they sit at, or when a `remote-desk` command fails.
---

# Remote desk

The user works at a **viewer** (any browser) while a **host** runs nodeterm's Server Edition, every
agent and terminal in tmux, and the builds. `remote-desk` (in `scripts/remote-desk.sh` of the
nodeterm checkout) wraps the whole thing. The full walkthrough is `remote-desk guide`
(`docs/REMOTE-DESK.md`); `remote-desk help` lists the commands. Read the guide before advising on
anything it covers, and run `remote-desk status` before diagnosing anything.

## Steps

1. **Place yourself.** Find out which machine you are on (`scutil --get LocalHostName`), which
   machine is the host and which the viewer, and whether the viewer is a computer or a phone.
   Commands differ per role: `host …` and `emu …` run on the host, `view …` on the viewer.
   Done when you can name both machines and their roles.
2. **Install.** `command -v remote-desk`; if missing, run `scripts/remote-desk.sh install` from
   the nodeterm checkout on each Mac. Done when `remote-desk help` runs on the machine you are on.
3. **Hand the user the steps only they can do**, one at a time, with the exact clicks:
   - Remote Login on the host (System Settings > General > Sharing): it needs an administrator.
   - Anything that prompts for a password: the first `ssh`, `remote-desk keys <other-mac>`.
     Ask them to run it with the `!` prefix so the output lands in the conversation.
   - Quitting the nodeterm desktop app on the host. You may be running inside it; let them choose
     when.
   - Opening the one-time setup link `host start` prints, and choosing the nodeterm password.
4. **Run the rest yourself and verify each with evidence, not the exit code:**
   - host: `remote-desk host start`, then `remote-desk host status` shows the server running.
   - SSH: `nc -z -G 3 <host-ip> 22` from anywhere reaches port 22.
   - viewer: after `remote-desk view <user>@<host>`, `host status` on the host lists a viewer
     "over ssh". For a phone, the same line appears once its SSH app's forward is started.
   - emulators: `remote-desk emu …` prints the AVD name for each port; check it is the one the
     project expects before installing.
   Done when the user can see and type in the canvas on the viewer and you have seen the "over ssh"
   viewer yourself.

## Rules

- **One core per host.** The desktop app and the server share the `node-terminal` tmux socket, and
  whichever starts last points every agent's hooks and skills (`~/.nodeterm/agent-hooks`,
  `~/.claude/skills`, …) at itself. `host start` refuses while the app runs. Offer `--force` only
  for a short test, say that the same project must not be open in both, and that the desktop app
  must be relaunched afterwards to take its hooks and skills back. You may be running inside that
  app, so a `--force` start also breaks your own canvas skill until then.
- **Moving projects needs no import**: add the same folders on the server (Open folder...). Their
  `.nodeterm/project.json` brings the canvas, and running agents reattach by node id.
- **Recent conversations** on the server's welcome screen include sessions still running in the
  desktop app or other nodes. Opening one starts a second Claude on the same conversation, so warn
  the user before they click.
- **Canvas control is off** on the Server Edition. If the user's agents open nodes or reply to
  orchestrators on the canvas, offer `host start --canvas-control`, and say it lets agent sessions
  act on the canvas.
- **Keep everything on loopback plus a tunnel.** The server binds `127.0.0.1`; viewers arrive
  through `ssh -L`. For reach beyond the local network, point to Tailscale or a TLS reverse proxy
  (`docs/SERVER.md`).
- A phone's browser must open `http://127.0.0.1:8443`, not `localhost`, and its SSH app's forward
  rule must be started, not just created.

## When something fails

Match the symptom against the Troubleshooting table in `remote-desk guide` first. If it is not
there, read the server log (`remote-desk host status` and `host start` print its path) and
`lsof -nP -iTCP:<port>` on both machines to find which hop is missing: server not listening,
tunnel not open, or the browser pointed at the wrong address.
