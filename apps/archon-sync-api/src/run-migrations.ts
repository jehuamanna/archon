/**
 * Stand-alone migration runner. Used by the B/G deploy pipeline so the
 * schema is brought to head *before* either sync-api slot starts. Same
 * code path as the boot-time migrate in `server.ts` — kept idempotent so
 * concurrent invocations from the slot bootstraps and this runner are
 * safe (drizzle's `__drizzle_migrations` table makes already-applied
 * migrations a no-op).
 *
 * Run inside a transient container against the new image before the slot
 * containers come up:
 *
 *   docker run --rm --network archon_default \
 *     -e DATABASE_URL=... -e ARCHON_BUNDLED_DOCS_DIR=... \
 *     archon-sync-api:next \
 *     npm run migrate -w @archon/sync-api
 *
 * Exits 0 on success, 1 on failure. No HTTP server.
 */
import "./load-root-env.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { ensurePgConnected, disconnectPg, getDb } from "./pg.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "db/migrations",
);

async function main(): Promise<void> {
  await ensurePgConnected();
  try {
    await migrate(getDb(), { migrationsFolder });
    // eslint-disable-next-line no-console
    console.log(`[migrate] applied; folder=${migrationsFolder}`);
  } finally {
    await disconnectPg();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[migrate] failed:", err);
  process.exit(1);
});
