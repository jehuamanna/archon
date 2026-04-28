#!/usr/bin/env bash
# Full stack + zero-downtime UI deploy (Postgres, sync-api, gateway, web; WPN in Postgres).
#
# Usage:
#   npm run deploy
#   npm run deploy -- --stop-old
#
# Bare git server (mirror to GitHub + tag-triggered deploy): deploy/git-server/MIGRATION.md (full steps), SERVER-LAYOUT.md (layout)
#
# What it does:
#   1. Ensures dist/plugins exists (used by optional marketplace profile / plugin builds).
#   2. Ensures ./.archon-docker-workspace exists (local scratch path for scripts that expect it).
#   3. Brings up archon-sync-api, archon-web-blue, archon-gateway (and postgres when ARCHON_LOCAL_PG=1).
#      Then always runs `compose up --no-deps archon-gateway` so :8080 is listening after partial stacks.
#   4. Runs scripts/docker-web-deploy.sh to build the web image, blue/green swap, and prune dangling images.
#
# Bundled Documentation (Guides): baked into the sync-api image (`ARCHON_BUNDLED_DOCS_DIR`).
#
# Override URL or secrets via repo root `.env` (Compose loads it; see `.env.example`).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -f "${REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/.env"
  set +a
fi

# Local Postgres container is opt-in via ARCHON_LOCAL_PG=1 — set it in .env to bring up `postgres`
# alongside the rest of the stack via the `local-pg` compose profile.
ARCHON_LOCAL_PG="${ARCHON_LOCAL_PG:-0}"
if [[ "$ARCHON_LOCAL_PG" == "1" ]]; then
  compose_pf=(--profile local-pg)
  pg_svc=(postgres)
else
  compose_pf=()
  pg_svc=()
fi
export ARCHON_LOCAL_PG

# Match docker compose project isolation (default: checkout directory basename). Jenkins sets
# COMPOSE_PROJECT_NAME=archon so jobs under varying workspace paths reuse one stack; containers
# from another project name would otherwise block fixed container_name values.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$REPO_ROOT")}"

export ARCHON_WPN_DEFAULT_OWNER="${ARCHON_WPN_DEFAULT_OWNER:-jehu}"

if [[ -z "${JWT_SECRET:-}" ]]; then
  JWT_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")"
  export JWT_SECRET
  echo "[archon] Generated JWT_SECRET for sync-api (export it to persist auth across container recreates)."
fi

mkdir -p dist/plugins
mkdir -p .archon-docker-workspace

# Orphan from an old compose service name (e.g. archon-web) — safe to drop.
docker rm -f archon-web 2>/dev/null || true

remove_if_not_this_compose_project() {
  local cname="$1"
  if ! docker container inspect "$cname" &>/dev/null; then
    return 0
  fi
  local proj
  proj="$(docker container inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$cname" 2>/dev/null || true)"
  if [[ "$proj" == "$COMPOSE_PROJECT_NAME" ]]; then
    return 0
  fi
  echo "[archon] Removing ${cname} (compose project '${proj:-none}' != this run '${COMPOSE_PROJECT_NAME}'; named volumes unchanged)."
  docker rm -f "$cname" >/dev/null 2>&1 || true
}

clear_foreign_compose_containers() {
  remove_if_not_this_compose_project archon-gateway
  remove_if_not_this_compose_project archon-postgres
  remove_if_not_this_compose_project archon-sync-api
  remove_if_not_this_compose_project archon-api
  remove_if_not_this_compose_project archon-web-blue
  remove_if_not_this_compose_project archon-web-green
}

clear_foreign_compose_containers

# Stopped archon-web-blue / archon-web-green still hold fixed container_name values; compose then
# errors with "already in use". Remove only slots that are not serving traffic: always remove if
# stopped; if running, remove only when not the active upstream in deploy/nginx-active-web.upstream.conf
# (same source the gateway uses). Running gateway/sync/postgres are only removed above when their
# compose project differs from COMPOSE_PROJECT_NAME.
ACTIVE_FILE="${REPO_ROOT}/deploy/nginx-active-web.upstream.conf"

# Checkout resets this file to git (usually blue) while the live slot may still be green from the
# last deploy — do not remove the only running web container based on the file alone.
reconcile_active_web_container() {
  local hint="$1"
  local blue_run=false green_run=false
  if docker container inspect archon-web-blue &>/dev/null \
    && [[ "$(docker inspect -f '{{.State.Running}}' archon-web-blue 2>/dev/null)" == "true" ]]; then
    blue_run=true
  fi
  if docker container inspect archon-web-green &>/dev/null \
    && [[ "$(docker inspect -f '{{.State.Running}}' archon-web-green 2>/dev/null)" == "true" ]]; then
    green_run=true
  fi
  if [[ "$blue_run" == "true" && "$green_run" != "true" ]]; then
    echo "archon-web-blue"
  elif [[ "$green_run" == "true" && "$blue_run" != "true" ]]; then
    echo "archon-web-green"
  else
    echo "${hint}"
  fi
}

active_line=""
file_line=""
if [[ -f "$ACTIVE_FILE" ]]; then
  file_line="$(grep -oE 'archon-web-(blue|green)' "$ACTIVE_FILE" | head -1 || true)"
  active_line="$(reconcile_active_web_container "${file_line:-}")"
  if [[ -n "$active_line" && "$active_line" != "${file_line:-}" ]]; then
    echo "[archon] Aligning ${ACTIVE_FILE} with running UI (${active_line}; file implied ${file_line:-none})."
    cat >"$ACTIVE_FILE" <<EOF
# Active web backend host:port — aligned with the running web container (e.g. after git checkout)
set \$archon_web_backend "${active_line}:3000";
EOF
  fi
fi

running_web_slots=0
for c in archon-web-blue archon-web-green; do
  if docker container inspect "$c" &>/dev/null \
    && [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" == "true" ]]; then
    running_web_slots=$((running_web_slots + 1))
  fi
done

remove_stale_web_slot() {
  local name="$1"
  if ! docker container inspect "$name" &>/dev/null; then
    return 0
  fi
  local running
  running="$(docker container inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)"
  if [[ "$running" != "true" ]]; then
    echo "[archon] Removing stopped ${name} (frees fixed container name for compose)."
    docker rm -f "$name" >/dev/null 2>&1 || true
    return 0
  fi
  # Blue and green may both be up during a handoff; git/ACTIVE_FILE can still say "blue".
  if [[ "$running_web_slots" -ge 2 ]]; then
    return 0
  fi
  if [[ -n "$active_line" && "$name" != "$active_line" ]]; then
    echo "[archon] Removing inactive ${name} (not in ${ACTIVE_FILE}; live UI stays on ${active_line})."
    docker rm -f "$name" >/dev/null 2>&1 || true
  fi
}

remove_stale_web_slot archon-web-blue
remove_stale_web_slot archon-web-green

# UI blue/green swap uses `docker run`, so slots lose compose labels. Compose then tries to
# create the same container_name and hits "already in use". Drop only non-compose slots.
remove_docker_run_web_slot() {
  local name="$1"
  if ! docker container inspect "$name" &>/dev/null; then
    return 0
  fi
  local running
  running="$(docker container inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)"
  if [[ "$running" == "true" && "$running_web_slots" -ge 2 ]]; then
    return 0
  fi
  # Never remove the active UI slot — that would cause avoidable downtime.
  if [[ -n "$active_line" && "$name" == "$active_line" ]]; then
    return 0
  fi
  local proj
  proj="$(docker container inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$name" 2>/dev/null || true)"
  if [[ -z "$proj" ]]; then
    echo "[archon] Removing ${name} (not compose-managed; frees fixed name for compose)."
    docker rm -f "$name" >/dev/null 2>&1 || true
  fi
}
remove_docker_run_web_slot archon-web-blue
remove_docker_run_web_slot archon-web-green

echo "[archon] Starting archon-sync-api + web (blue) + gateway (ARCHON_LOCAL_PG=${ARCHON_LOCAL_PG})..."
active_is_docker_run=false
if [[ -n "$active_line" ]]; then
  active_proj="$(docker container inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$active_line" 2>/dev/null || true)"
  if [[ -z "$active_proj" ]]; then
    active_is_docker_run=true
  fi
fi

compose_up() {
  if [[ "$active_is_docker_run" == "true" ]]; then
    # Avoid pulling in archon-web-blue via depends_on (would conflict with an active docker-run slot).
    docker compose "${compose_pf[@]}" up -d --build --remove-orphans "${pg_svc[@]}" archon-sync-api
    docker compose "${compose_pf[@]}" up -d --build --remove-orphans --no-deps archon-gateway
  else
    docker compose "${compose_pf[@]}" up -d --build --remove-orphans "${pg_svc[@]}" archon-sync-api archon-web-blue archon-gateway
  fi
}

if ! compose_up; then
  echo "[archon] Compose failed — clearing foreign-project / stale slots and retrying once..."
  clear_foreign_compose_containers
  remove_stale_web_slot archon-web-blue
  remove_stale_web_slot archon-web-green
  remove_docker_run_web_slot archon-web-blue
  remove_docker_run_web_slot archon-web-green
  compose_up
fi

# Idempotent: compose_up usually starts the gateway, but partial `docker compose up` or a stopped
# gateway leaves the stack without :8080. --no-deps avoids recreating archon-web-blue when it is a
# docker-run slot (blue/green) rather than a compose-managed container.
echo "[archon] Ensuring archon-gateway is up (host port ${ARCHON_GATEWAY_PORT:-8080})..."
docker compose "${compose_pf[@]}" up -d --build --remove-orphans --no-deps archon-gateway

echo "[archon] Waiting for archon-gateway to be running..."
for _ in $(seq 1 60); do
  if docker container inspect archon-gateway &>/dev/null; then
    running="$(docker container inspect -f '{{.State.Running}}' archon-gateway 2>/dev/null || echo false)"
    if [[ "$running" == "true" ]]; then
      break
    fi
  fi
  sleep 2
done

if [[ "$(docker container inspect -f '{{.State.Running}}' archon-gateway 2>/dev/null || echo false)" != "true" ]]; then
  echo "Error: archon-gateway did not become running. Check: docker compose logs" >&2
  exit 1
fi

echo "[archon] Gateway is up. Running UI blue/green deploy..."
exec bash "${REPO_ROOT}/scripts/docker-web-deploy.sh" "$@"
