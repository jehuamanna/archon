#!/usr/bin/env bash
# Toggle active UI between blue and green based on deploy/nginx-active-web.upstream.conf.
# Usage:
#   npm run switch
#   npm run switch -- --stop-old
#
# Prints current active color, then runs docker-web-swap.sh to the opposite color.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTIVE_FILE="${REPO_ROOT}/deploy/nginx-active-web.upstream.conf"
SWAP="${REPO_ROOT}/scripts/docker-web-swap.sh"
GATEWAY="${ARCHON_GATEWAY_CONTAINER:-archon-gateway}"

STOP_OLD=false
for arg in "$@"; do
  case "$arg" in
    --stop-old) STOP_OLD=true ;;
    *)
      echo "Usage: $0 [--stop-old]" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$ACTIVE_FILE" ]]; then
  echo "Error: missing ${ACTIVE_FILE}" >&2
  exit 1
fi

# Fail before printing "switching to …" so output is not misleading when the stack is down.
if ! docker container inspect "$GATEWAY" &>/dev/null; then
  echo "Error: container '$GATEWAY' does not exist." >&2
  echo "Start the full stack first (swap reloads nginx in the gateway):" >&2
  echo "  npm run docker:api:up:detached" >&2
  exit 1
fi
if [[ "$(docker container inspect -f '{{.State.Running}}' "$GATEWAY" 2>/dev/null)" != "true" ]]; then
  echo "Error: container '$GATEWAY' is not running. Start it with: docker compose up -d archon-gateway" >&2
  exit 1
fi

line="$(grep -oE 'archon-web-(blue|green)' "$ACTIVE_FILE" | head -1 || true)"
case "$line" in
  archon-web-blue) current="blue" ;;
  archon-web-green) current="green" ;;
  *)
    echo "Error: could not detect active color from ${ACTIVE_FILE} (expected archon-web-blue or archon-web-green)." >&2
    exit 1
    ;;
esac

if [[ "$current" == "blue" ]]; then
  next="green"
else
  next="blue"
fi

echo "[archon] Active UI: ${current} → switching to ${next}"

args=("$next")
if [[ "$STOP_OLD" == "true" ]]; then
  args+=("--stop-old")
fi

bash "$SWAP" "${args[@]}"

echo "[archon] Active UI is now: ${next}"
