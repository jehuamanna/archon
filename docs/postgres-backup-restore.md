# Postgres backup & restore

Operational runbook for dumping the local `archon-postgres` container and restoring it
to another (e.g. cloud) Postgres. Format is `pg_dump -Fc` (custom, gzip-compressed) so
restores can use `pg_restore` with selective flags.

## Source assumptions

- Container: `archon-postgres` (image `postgres:16`, defined in `docker-compose.yml` under
  the `local-pg` profile).
- Role / database: `archon` / `archon_sync` (overridable via `POSTGRES_USER`,
  `POSTGRES_PASSWORD`, `POSTGRES_DB` in `.env`).
- Dumps are written to `./backups/` (gitignored).

## Backup

```bash
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
docker exec -e PGPASSWORD=archon archon-postgres \
  pg_dump -U archon -d archon_sync -Fc -Z 9 \
  > "backups/archon_sync-${TS}.dump"

ls -lh "backups/archon_sync-${TS}.dump"
```

Flags:
- `-Fc` — custom format (required for `pg_restore`'s selective options).
- `-Z 9` — max gzip compression inside the dump.
- Output is streamed to a host file via stdout — no need to bind-mount or `docker cp`.

Verify the archive's table of contents (uses the `postgres:16` image so no host
`pg_restore` is required):

```bash
DUMP=backups/archon_sync-YYYYMMDD-HHMMSS.dump
docker run --rm -v "$PWD/backups:/b" postgres:16 \
  pg_restore -l "/b/$(basename "$DUMP")" | head
```

## Restore to a cloud Postgres

The cloud target must be reachable from this host and use Postgres 16+ (matching the
dump version). Use a fresh, empty database when possible — that avoids the destructive
`--clean` path.

Set the connection URL once:

```bash
export CLOUD_URL='postgres://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require'
```

### Clean restore into an empty database (preferred)

```bash
docker run --rm -i -v "$PWD/backups:/b" postgres:16 \
  pg_restore \
    --dbname "$CLOUD_URL" \
    --no-owner --no-privileges \
    --jobs 4 \
    --verbose \
    "/b/$(basename "$DUMP")"
```

- `--no-owner --no-privileges` strips the local `archon` role from the dump so the cloud
  role owns the restored objects (most managed Postgres services don't let you create
  arbitrary roles).
- `--jobs 4` parallelises table data restore. Drop it to `1` if the cloud instance is
  small or you hit connection limits.

### Restore over an existing database (destructive)

If the cloud DB already has the schema and you want to overwrite it:

```bash
docker run --rm -i -v "$PWD/backups:/b" postgres:16 \
  pg_restore \
    --dbname "$CLOUD_URL" \
    --clean --if-exists \
    --no-owner --no-privileges \
    --jobs 4 \
    "/b/$(basename "$DUMP")"
```

`--clean --if-exists` drops each object before recreating it. Only run this against a
target you are certain you want to replace.

### Schema only / data only

```bash
# schema only
pg_restore --schema-only --dbname "$CLOUD_URL" "$DUMP"
# data only (target schema must already match)
pg_restore --data-only   --dbname "$CLOUD_URL" "$DUMP"
```

## Smoke check after restore

```bash
docker run --rm postgres:16 \
  psql "$CLOUD_URL" -c "\dt public.*" | head
docker run --rm postgres:16 \
  psql "$CLOUD_URL" -c "SELECT count(*) FROM public.notes;"
```
