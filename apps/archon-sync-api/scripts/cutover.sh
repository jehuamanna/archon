#!/usr/bin/env bash
# Mongo → Postgres cutover orchestrator (Plans-Phase-1 item 25).
#
# Steps:
#   1. pg_isready: confirm the local-pg compose service is up and accepting
#      connections.
#   2. drizzle-kit migrate: apply the schema migrations from
#      apps/archon-sync-api/src/db/migrations/.
#   3. tsx scripts/import-mongo-to-pg.ts: run the 4-pass importer against
#      the existing mongodump-pre-cutover-*/ snapshot. The importer mints
#      uuids, populates legacy_object_id_map, translates FKs, backfills
#      note_edges from markdown, and verifies parity. Failure exits non-zero
#      and the cutover is aborted.
#   4. Smoke test: curl /health to confirm the API is reachable.
#
# Pass `--reset` to truncate every PG table before importing (idempotent
# on re-run). Pass the dump path as the only positional arg if it isn't the
# default mongodump-pre-cutover-20260425-162501/nodex_sync/.
#
# After this script succeeds:
#   - docker compose stop mongodb (the local Mongo container is no longer
#     needed; container is stopped, not deleted, so a rollback can reattach
#     it).
#   - npm --workspace=@archon/sync-api test (PG-backed integration suite —
#     should match the pre-cutover Mongo baseline minus the 3 inherited
#     pre-existing failures).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/../.. && pwd)"
SYNC_API_DIR="$ROOT/apps/archon-sync-api"
DEFAULT_DUMP="$ROOT/mongodump-pre-cutover-20260425-162501/nodex_sync"

DUMP_DIR=""
RESET_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --reset) RESET_FLAG="--reset" ;;
    --force) RESET_FLAG="--force" ;;
    *) DUMP_DIR="$arg" ;;
  esac
done
DUMP_DIR="${DUMP_DIR:-$DEFAULT_DUMP}"

echo "[cutover] root=$ROOT"
echo "[cutover] dump=$DUMP_DIR"
echo "[cutover] sync-api=$SYNC_API_DIR"

if [ ! -d "$DUMP_DIR" ]; then
  echo "[cutover] error: dump directory not found: $DUMP_DIR" >&2
  exit 1
fi

# 1) pg_isready
echo "[cutover] step 1: pg_isready…"
if command -v pg_isready >/dev/null 2>&1; then
  pg_isready -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" -t 10
elif docker ps --format '{{.Names}}' | grep -q '^archon-postgres$'; then
  docker exec archon-postgres pg_isready -U "${POSTGRES_USER:-archon}" -d "${POSTGRES_DB:-archon_sync}"
else
  echo "[cutover] error: pg_isready unavailable on host and archon-postgres container not running" >&2
  echo "[cutover]        bring it up with: docker compose --profile local-pg up -d postgres" >&2
  exit 1
fi

# 2) drizzle-kit migrate
echo "[cutover] step 2: drizzle-kit migrate…"
(
  cd "$SYNC_API_DIR"
  npx drizzle-kit migrate
)

# 3) importer
echo "[cutover] step 3: import-mongo-to-pg.ts $RESET_FLAG…"
(
  cd "$SYNC_API_DIR"
  npx tsx scripts/import-mongo-to-pg.ts "$DUMP_DIR" $RESET_FLAG
)

# 4) /health smoke
echo "[cutover] step 4: /health smoke…"
HEALTH_URL="${ARCHON_SYNC_API_HEALTH:-http://127.0.0.1:4010/health}"
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null; then
    echo "[cutover] /health ok ($HEALTH_URL)"
  else
    echo "[cutover] warning: /health probe failed at $HEALTH_URL — server may not be running yet" >&2
    echo "[cutover] (start it with: npm run sync-api:local) — cutover otherwise complete." >&2
  fi
else
  echo "[cutover] curl not available; skipping /health probe."
fi

echo "[cutover] done."
echo "[cutover] follow-ups:"
echo "[cutover]   - docker compose stop mongodb   # release the local Mongo container"
echo "[cutover]   - npm --workspace=@archon/sync-api test   # PG-backed integration suite"
