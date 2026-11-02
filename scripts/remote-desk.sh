#!/bin/bash
# remote-desk: work from one Mac while another Mac runs nodeterm.
#
#   HOST   (the Mac that does the work)
#     remote-desk host start [--build] [--force] [--canvas-control]
#                                                  start nodeterm Server Edition + keep the Mac awake
#     remote-desk host stop                        stop the server (agents keep running in tmux)
#     remote-desk host status
#
#   VIEWER (the Mac you sit at)
#     remote-desk view <host>                      open an SSH tunnel to the host and the canvas in a browser
#     remote-desk view stop
#
#   EMULATORS (run on the HOST, emulators live on the viewer)
#     remote-desk emu <viewer> [port ...]          tunnel each emulator's adb port and `adb connect` it
#     remote-desk emu stop
#
#   SETUP
#     remote-desk install [--force]                put remote-desk on PATH and the agent skill in ~/.claude/skills
#     remote-desk uninstall
#     remote-desk keys <other-mac>                 make an SSH key if needed and install it on the other Mac
#
#   remote-desk status                             everything this Mac is running for remote-desk
#   remote-desk guide                              the full walkthrough (docs/REMOTE-DESK.md)
#
# <host>/<viewer> is anything ssh accepts: user@name.local, an IP, or a ~/.ssh/config alias.
#
# Settings (environment variables, all optional):
#   REMOTE_DESK_NODETERM  nodeterm checkout   (default: the checkout this script lives in)
#   REMOTE_DESK_DATA      server data folder  (default ~/.nodeterm-server)
#   REMOTE_DESK_PORT      canvas port         (default 8443)
#   REMOTE_DESK_EMU_OFFSET  local port = emulator port + this (default 1000, so 5555 -> 6555)

set -u

# Resolve this script through any symlink (`install` links it into ~/.local/bin) to find its checkout.
self="$0"
while [ -L "$self" ]; do
  target="$(readlink "$self")"
  case "$target" in /*) self="$target" ;; *) self="$(dirname "$self")/$target" ;; esac
done
SCRIPT_PATH="$(cd "$(dirname "$self")" && pwd)/$(basename "$self")"
REPO_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
SKILL_SRC="$REPO_DIR/skills/remote-desk"
GUIDE_DOC="$REPO_DIR/docs/REMOTE-DESK.md"

NODETERM_DIR="${REMOTE_DESK_NODETERM:-$REPO_DIR}"
DATA_DIR="${REMOTE_DESK_DATA:-$HOME/.nodeterm-server}"
PORT="${REMOTE_DESK_PORT:-8443}"
EMU_OFFSET="${REMOTE_DESK_EMU_OFFSET:-1000}"
STATE_DIR="$HOME/.remote-desk"
SERVER_PID="$STATE_DIR/server.pid"
AWAKE_PID="$STATE_DIR/caffeinate.pid"
VIEW_PID="$STATE_DIR/view.pid"
EMU_PIDS="$STATE_DIR/emu.pids"     # lines: "<ssh pid> <local port> <remote port>"
SERVER_LOG="$DATA_DIR/server.log"

mkdir -p "$STATE_DIR"

say()  { printf '%s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
pid_of() { [ -f "$1" ] && cat "$1" 2>/dev/null; }
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
desktop_app_running() { pgrep -f 'nodeterm[^/]*\.app/Contents/MacOS/' >/dev/null 2>&1; }

ssh_opts=(-o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3)

# ---------------------------------------------------------------- host

host_start() {
  local build=0 force=0 control=0
  for a in "$@"; do
    case "$a" in
      --build) build=1 ;;
      --force) force=1 ;;
      --canvas-control) control=1 ;;
      *) die "unknown option: $a" ;;
    esac
  done

  if alive "$(pid_of "$SERVER_PID")"; then
    ok "server already running (pid $(pid_of "$SERVER_PID")) on 127.0.0.1:$PORT"
    return 0
  fi
  [ -f "$NODETERM_DIR/package.json" ] || die "no nodeterm checkout at $NODETERM_DIR (set REMOTE_DESK_NODETERM)"
  port_busy "$PORT" && die "port $PORT is already in use. Something else is listening (another server?). Check: lsof -nP -iTCP:$PORT"

  # The desktop app and the server share the node-terminal tmux socket. Running both lets each
  # app's idle-session reaper kill the other's detached sessions, and opening the same project in
  # both makes them fight over the same tmux sessions.
  local extra_env=()
  if desktop_app_running; then
    if [ "$force" -eq 1 ]; then
      warn "the nodeterm desktop app is running. Starting anyway with the idle-session reaper off."
      warn "Don't open the same project in both, or they will fight over its terminals."
      warn "The server re-points the agent hooks and skills (~/.nodeterm/agent-hooks, ~/.claude/skills, …)"
      warn "at itself, so the desktop app's agent badges and canvas skill break until you relaunch the app."
      : > "$STATE_DIR/forced"
      extra_env=(NODETERM_SESSION_REAP_DISABLED=1)
    else
      die "the nodeterm desktop app is running. Quit it first (they share one tmux socket), or pass --force for a short test."
    fi
  fi
  # Canvas control (agents opening nodes, replying to orchestrators) is off by default on the
  # Server Edition. It lets an agent session act on the canvas, so it stays an explicit choice.
  [ "$control" -eq 1 ] && extra_env+=(NODETERM_SERVER_CANVAS_CONTROL=1)

  if [ "$build" -eq 1 ] || [ ! -f "$NODETERM_DIR/out/server/main.cjs" ]; then
    say "building nodeterm ($(git -C "$NODETERM_DIR" branch --show-current 2>/dev/null))…"
    ( cd "$NODETERM_DIR" && npm run build >/dev/null && npm run server:build >/dev/null ) \
      || die "build failed. Run 'npm run build' in $NODETERM_DIR to see why."
    ok "built"
  fi

  mkdir -p "$DATA_DIR"
  : > "$SERVER_LOG"
  # `exec` inside the subshell makes the background process BE the server: no wrapper left holding
  # this terminal's stdout, and $! is the server's own pid.
  ( cd "$NODETERM_DIR" && exec env NODETERM_DATA_DIR="$DATA_DIR" NODETERM_PORT="$PORT" \
      ${extra_env[@]+"${extra_env[@]}"} nohup node out/server/main.cjs >>"$SERVER_LOG" 2>&1 </dev/null ) &
  local pid=$!
  echo "$pid" >"$SERVER_PID"

  local i
  for i in $(seq 1 40); do
    grep -q "listening on" "$SERVER_LOG" 2>/dev/null && break
    alive "$pid" || break
    sleep 0.25
  done
  if ! grep -q "listening on" "$SERVER_LOG" 2>/dev/null; then
    tail -20 "$SERVER_LOG" >&2
    die "server did not start. Full log: $SERVER_LOG"
  fi
  # The pid captured above can be a wrapper; record the process that actually holds the port.
  pid="$(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
  [ -n "$pid" ] || die "server says it is listening but no process holds port $PORT. Log: $SERVER_LOG"
  echo "$pid" >"$SERVER_PID"

  # Keep the Mac awake for exactly as long as the server runs.
  nohup caffeinate -dims -w "$pid" >/dev/null 2>&1 & echo $! >"$AWAKE_PID"

  ok "server running on 127.0.0.1:$PORT (pid $pid), Mac kept awake while it runs"
  local setup; setup="$(grep -o 'http://[^ ]*/setup?token=[0-9a-f]*' "$SERVER_LOG" | head -1)"
  if [ -n "$setup" ]; then
    say ""
    say "First run: choose a password at"
    say "  $setup"
  fi
  say ""
  say "From the other Mac:  remote-desk view $(whoami)@$(scutil --get LocalHostName 2>/dev/null).local"
  say "Log: $SERVER_LOG"
}

host_stop() {
  local pid; pid="$(pid_of "$SERVER_PID")"
  if alive "$pid"; then
    kill "$pid" && ok "server stopped. Agents and terminals keep running in tmux."
  else
    say "server not running"
  fi
  rm -f "$SERVER_PID"
  local c; c="$(pid_of "$AWAKE_PID")"; alive "$c" && kill "$c" 2>/dev/null
  rm -f "$AWAKE_PID"
  if [ -f "$STATE_DIR/forced" ]; then
    rm -f "$STATE_DIR/forced"
    desktop_app_running && warn "Relaunch the nodeterm desktop app now: it rewrites the agent hooks and skills the server took over."
  fi
}

host_status() {
  local pid; pid="$(pid_of "$SERVER_PID")"
  if alive "$pid"; then
    ok "server running on 127.0.0.1:$PORT (pid $pid)"
    local viewers
    viewers="$(lsof -nP -iTCP:"$PORT" -sTCP:ESTABLISHED 2>/dev/null | awk -v p=":$PORT" 'NR>1 && $9 ~ ("->127.0.0.1" p "$") {print $1}' | sort | uniq -c | awk '{printf "%s %s, ", $1, ($2 ~ /^sshd/ ? "over ssh" : $2)}')"
    say "  viewers: ${viewers:-none}"
    alive "$(pid_of "$AWAKE_PID")" && say "  keeping the Mac awake"
    say "  log: $SERVER_LOG"
  else
    say "server: not running"
  fi
  desktop_app_running && warn "the nodeterm desktop app is running on this Mac"
  local n; n="$(tmux -L node-terminal ls 2>/dev/null | wc -l | tr -d ' ')"
  say "  tmux sessions: $n"
}

# ---------------------------------------------------------------- viewer

view_start() {
  local target="${1:-}"
  [ -n "$target" ] || die "usage: remote-desk view <host>   (e.g. you@host-name.local)"
  if alive "$(pid_of "$VIEW_PID")"; then
    ok "tunnel already open"
  else
    port_busy "$PORT" && die "port $PORT is already in use on this Mac. Is a server running here too? Set REMOTE_DESK_PORT to use another port."
    say "opening tunnel to $target…"
    ssh -f -N "${ssh_opts[@]}" -L "$PORT:127.0.0.1:$PORT" "$target" \
      || die "could not reach $target over SSH. Is Remote Login on there? Try: ssh $target"
    # ssh -f forks; find the backgrounded process by its forward spec.
    pgrep -f "ssh -f -N .*-L $PORT:127.0.0.1:$PORT $target" | tail -1 >"$VIEW_PID"
    ok "tunnel open (pid $(pid_of "$VIEW_PID"))"
  fi
  local i
  for i in $(seq 1 20); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
    sleep 0.25
  done
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" \
    || warn "tunnel is up but nothing answers on the host. Run 'remote-desk host start' there."
  open "http://127.0.0.1:$PORT/"
  ok "canvas opened at http://127.0.0.1:$PORT"
  say "Close the tunnel with: remote-desk view stop"
}

view_stop() {
  local pid; pid="$(pid_of "$VIEW_PID")"
  if alive "$pid"; then kill "$pid" && ok "tunnel closed"; else say "no tunnel open"; fi
  rm -f "$VIEW_PID"
}

# ---------------------------------------------------------------- emulators (on the host)

emu_start() {
  local target="${1:-}"; shift || true
  [ -n "$target" ] || die "usage: remote-desk emu <viewer> [port ...]   (default port 5555)"
  command -v adb >/dev/null || die "adb not found. Install Android platform-tools."
  local ports=("$@"); [ "${#ports[@]}" -gt 0 ] || ports=(5555)

  # Local port = remote + offset, so the host's own adb never mistakes a tunnel for a local emulator
  # (adb auto-scans 5555-5585) and a host emulator can still use those ports.
  local rp lp pid
  for rp in "${ports[@]}"; do
    case "$rp" in *[!0-9]*|'') die "not a port: $rp" ;; esac
    lp=$((rp + EMU_OFFSET))
    if port_busy "$lp"; then
      warn "local port $lp already in use, assuming it is an existing tunnel"
    else
      ssh -f -N "${ssh_opts[@]}" -L "$lp:127.0.0.1:$rp" "$target" \
        || die "could not reach $target over SSH. Is Remote Login on there?"
      pid="$(pgrep -f "ssh -f -N .*-L $lp:127.0.0.1:$rp $target" | tail -1)"
      echo "$pid $lp $rp" >>"$EMU_PIDS"
    fi
    if adb connect "127.0.0.1:$lp" | grep -qE 'connected to|already connected'; then
      local avd
      avd="$(adb -s "127.0.0.1:$lp" shell getprop ro.boot.qemu.avd_name 2>/dev/null | tr -d '\r')"
      ok "emulator port $rp on $target → adb device 127.0.0.1:$lp${avd:+  (AVD: $avd)}"
    else
      warn "tunnel for port $rp is up, but adb could not connect. Is an emulator running on $target with that port?"
    fi
  done
  say ""
  say "Use it like:  flutter run -d 127.0.0.1:$(( ${ports[0]} + EMU_OFFSET ))"
}

emu_stop() {
  [ -f "$EMU_PIDS" ] || { say "no emulator tunnels"; return 0; }
  local pid lp rp
  while read -r pid lp rp; do
    adb disconnect "127.0.0.1:$lp" >/dev/null 2>&1
    alive "$pid" && kill "$pid" 2>/dev/null
    ok "closed emulator tunnel $lp → $rp"
  done <"$EMU_PIDS"
  rm -f "$EMU_PIDS"
}

emu_status() {
  [ -f "$EMU_PIDS" ] || return 0
  local pid lp rp
  while read -r pid lp rp; do
    if alive "$pid"; then say "  emulator tunnel 127.0.0.1:$lp → port $rp"; fi
  done <"$EMU_PIDS"
}

# ---------------------------------------------------------------- keys

keys() {
  local target="${1:-}"
  [ -n "$target" ] || die "usage: remote-desk keys <other-mac>"
  local key="$HOME/.ssh/id_ed25519"
  if [ ! -f "$key" ]; then
    say "no SSH key yet, making one at $key"
    ssh-keygen -t ed25519 -f "$key" -C "$(whoami)@$(scutil --get LocalHostName 2>/dev/null)" || die "ssh-keygen failed"
  fi
  say "installing your key on $target (asks for its login password once)…"
  ssh-copy-id -i "$key.pub" "$target" || die "could not install the key on $target"
  ssh -o BatchMode=yes "$target" true && ok "key login to $target works, no more password prompts"
}

# ---------------------------------------------------------------- status

status_all() {
  host_status
  if alive "$(pid_of "$VIEW_PID")"; then say "  viewer tunnel open on 127.0.0.1:$PORT"; fi
  emu_status
}

usage() {
  sed -n '2,32p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'
}

guide() {
  local pager="cat"
  [ -t 1 ] && pager="${PAGER:-less}"
  {
    say "This Mac: $(whoami)@$(scutil --get LocalHostName 2>/dev/null).local"
    say "nodeterm checkout: $NODETERM_DIR   data: $DATA_DIR   port: $PORT"
    say ""
    if [ -f "$GUIDE_DOC" ]; then
      cat "$GUIDE_DOC"
    else
      say "The guide is docs/REMOTE-DESK.md in the nodeterm repository (not found next to this script)."
    fi
  } | $pager
}

# ---------------------------------------------------------------- install

BIN_DIR="$HOME/.local/bin"
BIN_LINK="$BIN_DIR/remote-desk"
SKILL_LINK="$HOME/.claude/skills/remote-desk"

# Replace $2 with a symlink to $1. An existing link of ours is refreshed; anything else is left
# alone unless --force, and then moved aside rather than deleted.
link_into_place() {
  local src="$1" dst="$2" force="$3"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    ok "already linked: $dst"
    return 0
  fi
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    [ "$force" -eq 1 ] || die "$dst already exists and is not this checkout's. Re-run with --force to move it aside."
    mv "$dst" "$dst.bak.$(date +%Y%m%d%H%M%S)" && warn "moved the old $dst aside (.bak)"
  fi
  mkdir -p "$(dirname "$dst")"
  ln -s "$src" "$dst" && ok "linked $dst -> $src"
}

install() {
  local force=0
  [ "${1:-}" = "--force" ] && force=1
  [ -f "$SKILL_SRC/SKILL.md" ] || die "skill not found at $SKILL_SRC. Run install from a nodeterm checkout."
  link_into_place "$SCRIPT_PATH" "$BIN_LINK" "$force"
  link_into_place "$SKILL_SRC" "$SKILL_LINK" "$force"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR is not on your PATH. Add it to your shell profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
  say ""
  say "Both are links into this checkout, so a git pull updates them."
  say "Next: remote-desk guide"
}

uninstall() {
  local dst
  for dst in "$BIN_LINK" "$SKILL_LINK"; do
    if [ -L "$dst" ] && case "$(readlink "$dst")" in "$REPO_DIR"/*) true ;; *) false ;; esac; then
      rm "$dst" && ok "removed $dst"
    elif [ -e "$dst" ]; then
      warn "left $dst alone: it does not point into this checkout"
    fi
  done
}

# ---------------------------------------------------------------- dispatch

case "${1:-}" in
  host)
    shift
    case "${1:-}" in
      start) shift; host_start "$@" ;;
      stop) host_stop ;;
      status|'') host_status ;;
      *) die "unknown: remote-desk host ${1}" ;;
    esac ;;
  view)
    shift
    case "${1:-}" in
      stop) view_stop ;;
      *) view_start "${1:-}" ;;
    esac ;;
  emu)
    shift
    case "${1:-}" in
      stop) emu_stop ;;
      *) emu_start "$@" ;;
    esac ;;
  keys) shift; keys "${1:-}" ;;
  status) status_all ;;
  -h|--help|help|'') usage ;;
  guide|brief) guide ;;
  install) shift; install "${1:-}" ;;
  uninstall) uninstall ;;
  *) die "unknown command: $1 (try: remote-desk help)" ;;
esac
