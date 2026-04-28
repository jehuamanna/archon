#!/usr/bin/env bash
# Switch live UI traffic between archon-web-blue and archon-web-green (zero-downtime deploy).
# Usage (from repo root):
#   ./scripts/docker-web-swap.sh blue
#   ./scripts/docker-web-swap.sh green
# Optional: --stop-old  remove the inactive container after reload (saves RAM; allows image prune).
#
# Prerequisites:
#   - Stack running: postgres, archon-sync-api, archon-web-blue, archon-gateway
#   - For green: docker compose --profile green up -d archon-web-green (or this script starts it)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTIVE_FILE="${REPO_ROOT}/deploy/nginx-active-web.upstream.conf"
GATEWAY="${ARCHON_GATEWAY_CONTAINER:-archon-gateway}"

usage() {
  echo "Usage: $0 blue|green [--stop-old]" >&2
  exit 1
}

TARGET=""
STOP_OLD=false
for arg in "$@"; do
  case "$arg" in
    blue|green) TARGET="$arg" ;;
    --stop-old) STOP_OLD=true ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage
      ;;
  esac
done

[[ -n "$TARGET" ]] || usage

if ! docker container inspect "$GATEWAY" &>/dev/null; then
  echo "Error: container '$GATEWAY' does not exist." >&2
  echo "The swap script reloads nginx inside the gateway; start the full stack first:" >&2
  echo "  npm run docker:api:up:detached" >&2
  echo "  # or: docker compose up -d" >&2
  exit 1
fi

if [[ "$(docker container inspect -f '{{.State.Running}}' "$GATEWAY" 2>/dev/null)" != "true" ]]; then
  echo "Error: container '$GATEWAY' is not running. Start it with: docker compose up -d archon-gateway" >&2
  exit 1
fi

wait_web_healthy() {
  local name="$1"
  echo "Waiting for ${name} health..."
  for _ in $(seq 1 90); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo missing)"
    if [[ "$status" == "healthy" ]]; then
      return 0
    fi
    if [[ "$status" == "unhealthy" ]]; then
      echo "${name} is unhealthy." >&2
      exit 1
    fi
    sleep 2
  done
  echo "Timed out waiting for ${name} to become healthy." >&2
  exit 1
}

write_upstream() {
  local color="$1"
  local host
  if [[ "$color" == "blue" ]]; then
    host="archon-web-blue:3000"
  else
    host="archon-web-green:3000"
  fi
  cat >"$ACTIVE_FILE" <<EOF
# Active web backend host:port — managed by scripts/docker-web-swap.sh
set \$archon_web_backend "${host}";
EOF
}

if [[ "$TARGET" == "green" ]]; then
  echo "Ensuring archon-web-green is up (profile green)..."
  (cd "$REPO_ROOT" && docker compose --profile green up -d archon-web-green)
  wait_web_healthy archon-web-green
fi

if [[ "$TARGET" == "blue" ]]; then
  echo "Ensuring archon-web-blue is up..."
  (cd "$REPO_ROOT" && docker compose up -d archon-web-blue)
  wait_web_healthy archon-web-blue
fi

write_upstream "$TARGET"

if ! docker exec "$GATEWAY" nginx -t; then
  echo "nginx -t failed; restoring previous upstream manually if needed." >&2
  exit 1
fi

# Same as docker-web-deploy.sh: avoid nginx -s reload when pid file is empty under daemon off.
docker kill --signal=HUP "$GATEWAY" >/dev/null
echo "Active UI upstream: archon-web-${TARGET} (gateway reloaded)."

if [[ "$STOP_OLD" == "true" ]]; then
  if [[ "$TARGET" == "green" ]]; then
    echo "Removing archon-web-blue (--stop-old)..."
    docker rm -f archon-web-blue 2>/dev/null || true
  else
    echo "Removing archon-web-green (--stop-old)..."
    docker rm -f archon-web-green 2>/dev/null || true
  fi
  docker image prune -f
fi
