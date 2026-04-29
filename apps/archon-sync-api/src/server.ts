import "./load-root-env.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { buildSyncApiApp } from "./build-app.js";
import { ensurePgConnected, disconnectPg, getDb } from "./pg.js";
import {
  envString,
  requireImageNotesEnv,
  requireJwtSecret,
} from "./server-env.js";
import { getYjsAdapter } from "./realtime/yjs-ws.js";
import { ensureMasterAdmin } from "./admin-auth.js";

const port = Number(envString("PORT", "4010")) || 4010;
const host = envString("HOST", "0.0.0.0");
const corsOrigin = envString("CORS_ORIGIN", "true");

const jwtSecret = requireJwtSecret();
requireImageNotesEnv();

const app = await buildSyncApiApp({
  jwtSecret,
  corsOrigin,
  logger: true,
});

await ensurePgConnected();

// Run drizzle migrations at boot. The migrations folder lives next to the
// schema (src/db/migrations) — relative to this file at runtime.
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "db/migrations",
);
try {
  await migrate(getDb(), { migrationsFolder });
  app.log.info({ migrationsFolder }, "drizzle migrations applied");
} catch (err) {
  app.log.error({ err }, "drizzle migrate failed at boot");
  process.exit(1);
}

// Bootstrap the master admin from env. Public signup is disabled, so a
// fresh deployment has no way in without this. See `ensureMasterAdmin()`
// for the create-vs-promote logic.
try {
  const result = await ensureMasterAdmin();
  switch (result.kind) {
    case "skipped-no-email":
      app.log.warn(
        "ARCHON_MASTER_ADMIN_EMAIL is unset — no master admin will exist on this instance. Set it in .env and restart, or seed a master admin manually.",
      );
      break;
    case "created":
      app.log.warn(
        { userId: result.userId, email: result.email },
        result.usedDefaultPassword
          ? "Master admin created with DEFAULT password = email address. mustSetPassword=true; the operator will be forced to change it on first login. Set ARCHON_MASTER_ADMIN_PASSWORD to override."
          : "Master admin created with operator-supplied ARCHON_MASTER_ADMIN_PASSWORD. mustSetPassword=true; the operator will be forced to change it on first login.",
      );
      break;
    case "promoted-existing":
      app.log.info(
        { userId: result.userId, email: result.email },
        "Existing user promoted to master admin",
      );
      break;
    case "already-master":
      app.log.info(
        { userId: result.userId, email: result.email },
        "Master admin already provisioned",
      );
      break;
    case "reset-existing":
      app.log.warn(
        { userId: result.userId, email: result.email },
        result.usedDefaultPassword
          ? "ARCHON_MASTER_ADMIN_RESET=1 honored — master admin password reset to email; mustSetPassword=true; refresh sessions cleared. UNSET ARCHON_MASTER_ADMIN_RESET in .env now or every restart will reset the password again."
          : "ARCHON_MASTER_ADMIN_RESET=1 honored — master admin password reset to ARCHON_MASTER_ADMIN_PASSWORD; mustSetPassword=true; refresh sessions cleared. UNSET ARCHON_MASTER_ADMIN_RESET in .env now or every restart will reset the password again.",
      );
      break;
  }
} catch (err) {
  app.log.error({ err }, "ensureMasterAdmin failed at boot");
  // Don't exit — the app is still usable for existing accounts. Just loud
  // about it so a deploy with a typo'd email is obvious in logs.
}

// Compaction loop for the per-note Yjs update log. `setInterval(...).unref()`
// so the timer doesn't keep the process alive on shutdown. Defaults: every
// 5 minutes, keep the most recent 200 update rows per note. Compaction also
// skips notes with active edits in the past 10 minutes (`sinceMinutes: 10`)
// so we don't fight a live editing session.
const compactInterval = Number(
  process.env.ARCHON_YJS_COMPACT_INTERVAL_MS ?? 5 * 60_000,
);
const compactKeep = Number(process.env.ARCHON_YJS_COMPACT_KEEP ?? 200);
const yjsAdapter = getYjsAdapter();
const compactTimer = setInterval(() => {
  void (async () => {
    try {
      const result = await yjsAdapter.compactUpdates({
        keepCount: compactKeep,
        sinceMinutes: 10,
      });
      if (result.notesCompacted > 0) {
        app.log.info({ result }, "yjs compaction");
      }
    } catch (err) {
      app.log.warn({ err }, "yjs compaction failed");
    }
  })();
}, compactInterval);
compactTimer.unref();

const close = async (): Promise<void> => {
  clearInterval(compactTimer);
  await app.close();
  await disconnectPg();
};

process.on("SIGINT", () => {
  void close().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void close().then(() => process.exit(0));
});

try {
  await app.listen({ port, host });
  app.log.info(
    { port, host },
    "Archon sync API listening (Fastify + Postgres)",
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
