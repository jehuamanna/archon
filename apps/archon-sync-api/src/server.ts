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

const close = async (): Promise<void> => {
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
