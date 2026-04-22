import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { ARCHON_SYNC_API_V1_PREFIX } from "./api-v1-prefix.js";
import { registerRoutes } from "./routes.js";

export type BuildSyncApiAppOptions = {
  jwtSecret: string;
  /** Raw `CORS_ORIGIN` env value: `true`, `*`, or comma-separated origins. */
  corsOrigin: string;
  /** Default true for Docker; prefer false in serverless to reduce log noise. */
  logger?: boolean;
};

/**
 * Build a Fastify app with sync-api routes (including `GET /health`).
 * Does not connect Mongo — call {@link connectMongo} or {@link ensureMongoConnected} before handling traffic.
 */
export async function buildSyncApiApp(
  opts: BuildSyncApiAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });
  const corsOrigin = opts.corsOrigin;

  await app.register(cors, {
    origin:
      corsOrigin === "true" || corsOrigin === "*"
        ? true
        : corsOrigin.split(",").map((o) => o.trim()),
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "X-Requested-With",
    ],
    maxAge: 86400,
  });

  await app.register(
    async (scoped) => {
      registerRoutes(scoped, { jwtSecret: opts.jwtSecret });
    },
    { prefix: ARCHON_SYNC_API_V1_PREFIX },
  );

  app.get("/health", async (_request, reply) => {
    return reply.send({ ok: true, service: "archon-sync-api" });
  });

  await app.ready();
  return app;
}
