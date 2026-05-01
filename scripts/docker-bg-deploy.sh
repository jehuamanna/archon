#!/usr/bin/env bash
# Full blue/green deploy for both tiers (sync-api + web).
#
# Differs from scripts/docker-full-deploy.sh in one critical way: the live
# sync-api slot is NEVER recreated to apply a new image. Cutover is an
# nginx-upstream rewrite + SIGHUP — same pattern the web tier already uses.
# Result: no /api/v1 502 window during deploy.
#
# Usage:
#   bash scripts/docker-bg-deploy.sh
#   bash scripts/docker-bg-deploy.sh --stop-old    # tear down old slots after a 60s drain
#
# Pipeline:
#   1. Build both runtime images (sync-api + web) in parallel — does NOT
#      touch any live container.
#   2. Run drizzle migrations once via a transient container against the
#      new image (`archon-migrate`, profile=migrate). MUST be backward-
#      compatible with the live (old) sync-api slot — see deploy/ZERO-DOWNTIME.md.
#   3. Detect current colors (web + api) from the include files.
#   4. Spin up the inactive color of BOTH tiers in parallel via
#      `docker run` (mirrors the existing web-deploy approach to avoid
#      compose container_name collisions during slot turnover).
#   5. Wait for both new slots to pass health.
#   6. Atomic cutover: rewrite both active-upstream include files in-place
#      (preserves the bind-mount inode), then `docker kill -s HUP archon-gateway`
#      ONCE so nginx flips both tiers in the same reload tick.
#   7. Drain old slots for 60s; with --stop-old, remove them; otherwise
#      leave them running so the next deploy can cut back to them instantly
#      if the new release has to be rolled back.
#
# Requires the gateway + at least one blue slot of each tier already running.
# Bootstrap with: `npm run docker:api:up:detached` (compose up; brings up
# blue slots + gateway + redis + optional postgres) before the first
# blue/green cutover.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_ACTIVE="${REPO_ROOT}/deploy/nginx-active-web.upstream.conf"
API_ACTIVE="${REPO_ROOT}/deploy/nginx-active-api.upstream.conf"
GATEWAY="${ARCHON_GATEWAY_CONTAINER:-archon-gateway}"
NETWORK="${ARCHON_DOCKER_NETWORK:-archon_default}"
WEB_IMAGE="${ARCHON_WEB_IMAGE:-archon-web:local}"
API_IMAGE="${ARCHON_SYNC_API_IMAGE:-archon-sync-api:local}"
DRAIN_SECONDS="${ARCHON_BG_DRAIN_SECONDS:-60}"

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

# ---------- preflight ----------
for f in "$WEB_ACTIVE" "$API_ACTIVE"; do
  if [[ ! -f "$f" ]]; then
    echo "Error: missing ${f} (bootstrap with 'npm run docker:api:up:detached' first)." >&2
    exit 1
  fi
done

if ! docker container inspect "$GATEWAY" &>/dev/null \
  || [[ "$(docker container inspect -f '{{.State.Running}}' "$GATEWAY" 2>/dev/null)" != "true" ]]; then
  echo "Error: '$GATEWAY' is not running. Bootstrap: npm run docker:api:up:detached" >&2
  exit 1
fi

if ! docker network inspect "$NETWORK" &>/dev/null; then
  echo "Error: docker network '$NETWORK' not found. Bootstrap: npm run docker:api:up:detached" >&2
  exit 1
fi

current_color_from_file() {
  local file="$1" pattern="$2"
  grep -oE "${pattern}-(blue|green)" "$file" | head -1 || true
}

current_web="$(current_color_from_file "$WEB_ACTIVE" "archon-web")"
current_api="$(current_color_from_file "$API_ACTIVE" "archon-sync-api")"
case "$current_web" in
  archon-web-blue|archon-web-green) ;;
  *) echo "Error: cannot detect web color from ${WEB_ACTIVE}." >&2 ; exit 1 ;;
esac
case "$current_api" in
  archon-sync-api-blue|archon-sync-api-green) ;;
  *) echo "Error: cannot detect api color from ${API_ACTIVE}." >&2 ; exit 1 ;;
esac

if [[ "$current_web" == "archon-web-blue" ]]; then next_web="archon-web-green"; else next_web="archon-web-blue"; fi
if [[ "$current_api" == "archon-sync-api-blue" ]]; then next_api="archon-sync-api-green"; else next_api="archon-sync-api-blue"; fi

echo "[bg] web:  ${current_web} -> ${next_web}"
echo "[bg] api:  ${current_api} -> ${next_api}"

# ---------- 1. parallel build ----------
echo "[bg] building images in parallel..."
(
  cd "$REPO_ROOT" && DOCKER_BUILDKIT=1 docker build --target web -t "$WEB_IMAGE" -f Dockerfile . 2>&1 \
    | sed 's/^/[bg:web-build] /'
) &
WEB_BUILD_PID=$!
(
  cd "$REPO_ROOT" && DOCKER_BUILDKIT=1 docker build --target sync-api -t "$API_IMAGE" -f Dockerfile . 2>&1 \
    | sed 's/^/[bg:api-build] /'
) &
API_BUILD_PID=$!

build_failed=false
wait "$WEB_BUILD_PID" || build_failed=true
wait "$API_BUILD_PID" || build_failed=true
if [[ "$build_failed" == "true" ]]; then
  echo "[bg] image build failed" >&2
  exit 1
fi

# ---------- 2. migrations (one-shot, against new image) ----------
echo "[bg] running migrations..."
if ! (cd "$REPO_ROOT" && docker compose --profile migrate run --rm archon-migrate); then
  echo "[bg] migrations failed — aborting (no slot has been touched)." >&2
  exit 1
fi

# ---------- 3+4. spin up inactive slots in parallel ----------
remove_inactive_if_present() {
  local name="$1"
  if docker container inspect "$name" &>/dev/null; then
    echo "[bg] removing existing ${name} (will recreate)..."
    docker rm -f "$name" >/dev/null
  fi
}
remove_inactive_if_present "$next_web"
remove_inactive_if_present "$next_api"

start_api_slot() {
  local name="$1"
  local replica_id
  if [[ "$name" == "archon-sync-api-blue" ]]; then
    replica_id="${ARCHON_REPLICA_ID_BLUE:-archon-sync-blue}"
  else
    replica_id="${ARCHON_REPLICA_ID_GREEN:-archon-sync-green}"
  fi
  docker run -d \
    --name "$name" \
    --network "$NETWORK" \
    -e HOST=0.0.0.0 \
    -e PORT=4010 \
    -e DATABASE_URL="${ARCHON_DATABASE_URL_OVERRIDE:-postgres://archon:archon@postgres:5432/archon_sync}" \
    -e REDIS_URL="${ARCHON_REDIS_URL_OVERRIDE:-redis://redis:6379}" \
    -e JWT_SECRET="${JWT_SECRET:-dev-only-archon-sync-secret-min-32-chars!!}" \
    -e ARCHON_REPLICA_ID="$replica_id" \
    -e ARCHON_MASTER_ADMIN_EMAIL="${ARCHON_MASTER_ADMIN_EMAIL:-}" \
    -e ARCHON_BUNDLED_DOCS_DIR=/app/docs/bundled-plugin-authoring \
    "$API_IMAGE" >/dev/null
}

start_web_slot() {
  local name="$1"
  docker run -d \
    --name "$name" \
    --network "$NETWORK" \
    -e NODE_ENV=production \
    "$WEB_IMAGE" >/dev/null
}

echo "[bg] starting ${next_api}..."
start_api_slot "$next_api"
echo "[bg] starting ${next_web}..."
start_web_slot "$next_web"

# ---------- 5. wait for both new slots to be healthy ----------
wait_healthy() {
  local name="$1" port="$2" tries="${3:-90}"
  for _ in $(seq 1 "$tries"); do
    if ! docker container inspect "$name" &>/dev/null; then
      echo "[bg] ${name} disappeared while waiting." >&2
      return 1
    fi
    local state
    state="$(docker container inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo missing)"
    case "$state" in
      exited|dead)
        echo "[bg] ${name} stopped while waiting (state=${state}). Recent logs:" >&2
        docker logs --tail 200 "$name" 2>&1 || true
        return 1
        ;;
      running) ;;
      *) sleep 2 ; continue ;;
    esac
    if docker exec "$name" node -e "const http=require('http');const r=http.get('http://127.0.0.1:${port}/'+(${port}==='4010'?'health':''),(res)=>{res.resume();res.on('end',()=>process.exit(res.statusCode>=200&&res.statusCode<500?0:1));});r.on('error',()=>process.exit(1));r.setTimeout(8000,()=>{r.destroy();process.exit(1);});" &>/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "[bg] ${name} did not become healthy in time. Recent logs:" >&2
  docker logs --tail 200 "$name" 2>&1 || true
  return 1
}

echo "[bg] waiting for ${next_api} :4010/health..."
if ! wait_healthy "$next_api" 4010; then
  echo "[bg] ${next_api} unhealthy — leaving live slot ${current_api} in place; aborting." >&2
  docker rm -f "$next_api" >/dev/null 2>&1 || true
  exit 1
fi
echo "[bg] waiting for ${next_web} :3000..."
if ! wait_healthy "$next_web" 3000; then
  echo "[bg] ${next_web} unhealthy — leaving live slots in place; aborting." >&2
  docker rm -f "$next_web" >/dev/null 2>&1 || true
  exit 1
fi

# ---------- 6. atomic upstream rewrite + single SIGHUP ----------
# Rewrite in-place (truncate + write) to keep the bind-mount inode stable,
# so the gateway container sees the new content without a remount. Editor
# atomic-replace would create a new inode; the old container would still
# see the old file until restart. See `docs/deploy-archon-sync.md`.
write_inplace() {
  local file="$1" content="$2"
  printf '%s' "$content" > "$file"
}

write_inplace "$API_ACTIVE" "$(cat <<EOF
# Active sync-api backend host:port — managed by scripts/docker-bg-deploy.sh.
set \$archon_sync_api_backend "${next_api}:4010";
EOF
)"
write_inplace "$WEB_ACTIVE" "$(cat <<EOF
# Active web backend host:port — managed by scripts/docker-bg-deploy.sh.
set \$archon_web_backend "${next_web}:3000";
EOF
)"

if ! docker exec "$GATEWAY" nginx -t >/dev/null; then
  echo "[bg] nginx -t failed in ${GATEWAY}. Reverting include files." >&2
  write_inplace "$API_ACTIVE" "$(cat <<EOF
# Active sync-api backend host:port — managed by scripts/docker-bg-deploy.sh.
set \$archon_sync_api_backend "${current_api}:4010";
EOF
)"
  write_inplace "$WEB_ACTIVE" "$(cat <<EOF
# Active web backend host:port — managed by scripts/docker-bg-deploy.sh.
set \$archon_web_backend "${current_web}:3000";
EOF
)"
  docker rm -f "$next_api" "$next_web" >/dev/null 2>&1 || true
  exit 1
fi
docker kill --signal=HUP "$GATEWAY" >/dev/null
echo "[bg] cutover done. live: api=${next_api} web=${next_web}"

# ---------- 7. drain + (optional) tear down old slots ----------
echo "[bg] draining old slots for ${DRAIN_SECONDS}s..."
sleep "$DRAIN_SECONDS"

if [[ "$STOP_OLD" == "true" ]]; then
  echo "[bg] removing ${current_api} and ${current_web} (--stop-old)..."
  docker rm -f "$current_api" "$current_web" >/dev/null 2>&1 || true
fi

# Untag dangling parents from rebuilds.
docker image prune -f >/dev/null 2>&1 || true

echo "[bg] done."
