import "./load-root-env.js";
import { buildSyncApiApp } from "./build-app.js";
import { closeMongo, connectMongo } from "./db.js";
import {
  envString,
  requireImageNotesEnv,
  requireJwtSecret,
} from "./server-env.js";

const port = Number(envString("PORT", "4010")) || 4010;
const host = envString("HOST", "0.0.0.0");
const mongoUri = envString("MONGODB_URI", "mongodb://127.0.0.1:27017");
const mongoDb = envString("MONGODB_DB", "archon_sync");
const corsOrigin = envString("CORS_ORIGIN", "true");

const jwtSecret = requireJwtSecret();
requireImageNotesEnv();

const app = await buildSyncApiApp({
  jwtSecret,
  corsOrigin,
  logger: true,
});

await connectMongo(mongoUri, mongoDb);

const close = async (): Promise<void> => {
  await app.close();
  await closeMongo();
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
    { port, host, mongoDb },
    "Archon sync API listening (Fastify + MongoDB)",
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
