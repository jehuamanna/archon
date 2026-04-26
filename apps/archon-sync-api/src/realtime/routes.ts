/**
 * Phase 1 token-mint endpoint. The web client calls
 * `POST /v1/realtime/ws-token` with an access token in `Authorization`,
 * specifying the target `spaceId` (and optional `workspaceId` / `noteId`
 * for downstream Phase 2/3 use). The server validates space membership and
 * returns a 5-minute `typ: "spaceWs"` JWT the client uses to open the
 * WebSocket at `GET /v1/ws/space/:spaceId?token=<jwt>`.
 *
 * Splitting the access token from the WS token keeps the long-lived
 * principal token off the wire as a query string and lets the server reuse
 * its space-membership check without per-frame revalidation.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, signToken } from "../auth.js";
import { effectiveRoleInSpace } from "../permission-resolver.js";

const wsTokenBody = z.object({
  spaceId: z.string().uuid(),
  workspaceId: z.string().uuid().optional(),
  noteId: z.string().uuid().optional(),
});

export function registerRealtimeRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  app.post("/realtime/ws-token", async (req, reply) => {
    const auth = await requireAuth(req, reply, jwtSecret);
    if (!auth) return;
    const parsed = wsTokenBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const role = await effectiveRoleInSpace(auth.sub, parsed.data.spaceId);
    if (!role) {
      return reply.status(403).send({ error: "no access to space" });
    }
    const token = signToken(
      jwtSecret,
      {
        sub: auth.sub,
        email: auth.email,
        typ: "spaceWs",
        principal: auth.principal ?? { type: "user" },
        activeOrgId: auth.activeOrgId,
        activeSpaceId: parsed.data.spaceId,
      },
      "5m",
    );
    return reply.send({ token, expiresInSec: 5 * 60 });
  });
}
