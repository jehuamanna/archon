#!/usr/bin/env bash
# Build @archon/web, start archon-sync-api + Next production server, run Playwright smoke tests.
# Requires Mongo at MONGODB_URI (default mongodb://127.0.0.1:27017).
#
# Ports (override if busy):
#   PORT / E2E_SYNC_API_PORT — sync-api (default 4010)
#   E2E_WEB_PORT — Next.js (default 3456; avoids clashing with dev on :3000)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export MONGODB_URI="${MONGODB_URI:-mongodb://127.0.0.1:27017}"
export JWT_SECRET="${JWT_SECRET:-dev-only-archon-sync-secret-min-32-chars!!}"
export PORT="${PORT:-${E2E_SYNC_API_PORT:-4010}}"
export HOST="${HOST:-127.0.0.1}"
WEB_PORT="${E2E_WEB_PORT:-3456}"

# PIDs with LISTEN on $1 (best-effort; Linux + macOS via lsof).
pids_listening_on_port() {
  local port=$1
  command -v lsof >/dev/null 2>&1 || return 0
  {
    lsof -ti ":${port}" -sTCP:LISTEN 2>/dev/null || true
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null || true
  } | sort -u
}

# Kill a process and any direct children (npx often leaves a node child).
kill_tree() {
  local root=$1
  [ -z "$root" ] && return 0
  kill -0 "$root" 2>/dev/null || return 0
  local c
  c=$(pgrep -P "$root" 2>/dev/null || true)
  for child in $c; do
    kill_tree "$child"
  done
  kill -TERM "$root" 2>/dev/null || true
}

cleanup() {
  set +e
  # Stop what we started by PID (subshell may be npx; children keep ports open).
  for pid in "${WEB_PID:-}" "${API_PID:-}"; do
    [ -n "$pid" ] && kill_tree "$pid"
  done
  sleep 0.4
  # Anything still bound to our ports (orphan node, etc.)
  for port in "${PORT}" "${WEB_PORT}"; do
    for p in $(pids_listening_on_port "$port"); do
      kill -TERM "$p" 2>/dev/null || true
    done
  done
  sleep 0.4
  for port in "${PORT}" "${WEB_PORT}"; do
    for p in $(pids_listening_on_port "$port"); do
      kill -KILL "$p" 2>/dev/null || true
    done
  done
  wait "${WEB_PID:-}" 2>/dev/null || true
  wait "${API_PID:-}" 2>/dev/null || true
  set -e
}

trap cleanup EXIT INT TERM

(
  cd apps/archon-sync-api
  exec npx tsx src/server.ts
) &
API_PID=$!

for _ in $(seq 1 90); do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null; then
    break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "sync-api exited before becoming healthy" >&2
    exit 1
  fi
  sleep 1
done
if ! curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null; then
  echo "Timed out waiting for sync-api /health" >&2
  exit 1
fi

export NEXT_PUBLIC_ARCHON_SYNC_API_URL="http://127.0.0.1:${PORT}/api/v1"
export NEXT_PUBLIC_ARCHON_WPN_USE_SYNC_API=1
export NEXT_PUBLIC_ARCHON_WEB_BACKEND=sync-only

npm run build -w @archon/web

(
  cd apps/archon-web
  exec env \
    NEXT_PUBLIC_ARCHON_SYNC_API_URL="$NEXT_PUBLIC_ARCHON_SYNC_API_URL" \
    NEXT_PUBLIC_ARCHON_WPN_USE_SYNC_API="$NEXT_PUBLIC_ARCHON_WPN_USE_SYNC_API" \
    NEXT_PUBLIC_ARCHON_WEB_BACKEND="$NEXT_PUBLIC_ARCHON_WEB_BACKEND" \
    npx next start -p "$WEB_PORT" -H 0.0.0.0
) &
WEB_PID=$!

for _ in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:${WEB_PORT}/" >/dev/null; then
    break
  fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo "Next.js server exited before becoming ready" >&2
    exit 1
  fi
  sleep 1
done
if ! curl -sf "http://127.0.0.1:${WEB_PORT}/" >/dev/null; then
  echo "Timed out waiting for Next.js on :${WEB_PORT}" >&2
  exit 1
fi

export PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL:-http://127.0.0.1:${WEB_PORT}}"
npx playwright install chromium
npx playwright test -c e2e/playwright.config.ts
