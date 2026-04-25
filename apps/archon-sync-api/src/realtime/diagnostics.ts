/**
 * `GET /v1/realtime/diagnostics` — master-admin-only snapshot of every
 * active LISTEN channel: name, refcount, subscriber count, idle-timer state.
 * Used to validate that the fanout pool isn't leaking client connections
 * after long-running editing sessions.
 */
import type { FastifyInstance } from "fastify";
import { requireMasterAdmin } from "../admin-auth.js";
import { getChannelDiagnostics } from "./listen-pool.js";

export function registerRealtimeDiagnosticsRoute(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;
  app.get("/realtime/diagnostics", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    return reply.send({ channels: getChannelDiagnostics() });
  });
}
