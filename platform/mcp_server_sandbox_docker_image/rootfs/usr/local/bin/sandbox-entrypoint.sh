#!/usr/bin/env bash
#
# Sandbox supervisor.
#
# tini runs as PID 1 (declared via Dockerfile ENTRYPOINT) and execs this
# script. The script fan-spawns the in-pod processes the sandbox needs:
#
#   - tmux server (single persistent session named `sandbox`)
#   - ttyd attached to that session, listening on 0.0.0.0:7681 (read-only)
#   - in-pod MCP server on 0.0.0.0:8080
#   - idle daemon that SIGTERMs PID 1 when the activity file is stale
#
# The MCP server and idle daemon are optional — the supervisor checks
# for their presence at startup and skips them if missing, so the same
# entrypoint works for a minimal image (just tmux + ttyd) and a full
# image with all four processes.
#
# Signal propagation: tini forwards SIGTERM/SIGINT to this script as PID 2.
# We trap them, fan-kill our children, and wait for them to exit so the
# pod terminates cleanly when K8s evicts it (or when the idle daemon
# decides we're done).

set -euo pipefail

TTY_PORT="${TTY_PORT:-7681}"
MCP_PORT="${MCP_PORT:-8080}"
TMUX_SOCKET="${TMUX_SOCKET:-/var/run/tmux/sandbox.sock}"
TMUX_SESSION="${TMUX_SESSION:-sandbox}"
ACTIVITY_FILE="${ACTIVITY_FILE:-/var/run/sandbox/activity}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"

# Per-conversation runtime state lives in tmpfs `emptyDir` mounts when
# running under K8s. Re-create the directory tree defensively here so a
# standalone `docker run` smoke test also works.
mkdir -p "$(dirname "$TMUX_SOCKET")" "$(dirname "$ACTIVITY_FILE")" "$WORKSPACE_DIR"
touch "$ACTIVITY_FILE"

children=()

cleanup() {
  echo "sandbox-entrypoint: SIGTERM received, terminating children" >&2
  for pid in "${children[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  wait
  exit 0
}
trap cleanup TERM INT

# 1. Start the tmux server with the sandbox session.
#
# `tmux new-session -d` creates a detached session that ttyd can attach
# to. Agent-driven windows are created later via `tmux new-window` from
# the in-pod MCP server; the bootstrap session has a single shell window
# so a fresh attach lands on a usable prompt.
tmux -S "$TMUX_SOCKET" -f /etc/tmux.conf \
  new-session -d -s "$TMUX_SESSION" -n shell \
  -c "$WORKSPACE_DIR"

# 2. Start ttyd in read-only mode, attached to the sandbox session.
#
# `--writable` is a boolean toggle in ttyd 1.7.x — its absence (the
# default) is what makes the user-facing leg read-only. Do not pass
# `--writable=false`; ttyd's option parser rejects the value form.
#
# Auth happens at the WebSocket layer via the backend bridge's JSON
# init message, so ttyd's own `--credential` flag is unused.
ttyd \
  --port "$TTY_PORT" \
  --interface 0.0.0.0 \
  --max-clients 8 \
  --terminal-type screen-256color \
  -- tmux -S "$TMUX_SOCKET" attach-session -t "$TMUX_SESSION" \
  &
children+=($!)

# 3. Start the in-pod MCP server if its bundle is present.
if [ -d /opt/sandbox-mcp ] && [ -f /opt/sandbox-mcp/dist/server.js ]; then
  cd /opt/sandbox-mcp
  node dist/server.js \
    --port "$MCP_PORT" \
    --host 0.0.0.0 \
    --tmux-socket "$TMUX_SOCKET" \
    --tmux-session "$TMUX_SESSION" \
    --activity-file "$ACTIVITY_FILE" \
    --workspace "$WORKSPACE_DIR" \
    &
  children+=($!)
  cd "$WORKSPACE_DIR"
else
  echo "sandbox-entrypoint: in-pod MCP server bundle not present at /opt/sandbox-mcp/dist/server.js — skipping" >&2
fi

# 4. Start the idle daemon if installed.
if [ -x /usr/local/bin/sandbox-idle-daemon ]; then
  /usr/local/bin/sandbox-idle-daemon &
  children+=($!)
else
  echo "sandbox-entrypoint: idle daemon binary not present at /usr/local/bin/sandbox-idle-daemon — skipping" >&2
fi

# Wait for any child to exit. If tmux or ttyd dies we want the pod to
# die with it so K8s can replace it; same for the idle daemon raising
# SIGTERM against PID 1 to terminate the Job cleanly.
wait -n
exit_code=$?
echo "sandbox-entrypoint: child exited with code $exit_code, terminating remaining children" >&2
cleanup
