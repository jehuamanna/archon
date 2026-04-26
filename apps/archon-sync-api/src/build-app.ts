import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { ARCHON_SYNC_API_V1_PREFIX } from "./api-v1-prefix.js";
import { registerRoutes } from "./routes.js";

// @fastify/websocket is loaded dynamically so tooling that type-checks
// without the dep installed doesn't fail. In dev/prod the dependency is
// required (see package.json).
async function registerWebSocketPlugin(app: FastifyInstance): Promise<void> {
  try {
    const mod = await import("@fastify/websocket");
    const plugin = (mod as unknown as { default?: unknown }).default ?? mod;
    await app.register(plugin as never);
  } catch (err) {
    app.log.warn(
      { err: (err as Error).message },
      "MDX mini-app WebSocket endpoint disabled — @fastify/websocket not installed",
    );
  }
}

export type BuildSyncApiAppOptions = {
  jwtSecret: string;
  /** Raw `CORS_ORIGIN` env value: `true`, `*`, or comma-separated origins. */
  corsOrigin: string;
  /** Default true for Docker; prefer false in serverless to reduce log noise. */
  logger?: boolean;
};

/**
 * Build a Fastify app with sync-api routes (including `GET /health`).
 * Does not connect to Postgres — call {@link ensurePgConnected} from
 * `./pg.js` before handling traffic.
 */
export async function buildSyncApiApp(
  opts: BuildSyncApiAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });
  const corsOrigin = opts.corsOrigin;

  await registerWebSocketPlugin(app);

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
