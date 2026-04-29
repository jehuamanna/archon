/**
 * Realtime WS token-mint endpoint. The client calls
 * `POST /v1/realtime/ws-token` with an access token in `Authorization`,
 * optionally specifying an `orgId`/`noteId` for diagnostics. The server
 * returns a 5-minute `typ: "wsClient"` JWT used to open one of:
 *   - `GET /v1/ws/yjs?token=<jwt>`           — Yjs collab (per note)
 *   - `GET /v1/ws/realtime/:orgId?token=<jwt>` — org-scoped presence + events
 *
 * Authorisation is per-resource at WS open time:
 *   - Yjs: `yjs-ws.ts onAuthenticate` resolves documentName → project and
 *     checks `effectiveRoleInProject`.
 *   - Realtime/org: `ws-skeleton.ts` accepts any valid wsClient token; the
 *     per-event filter (`canDeliverToSubscriber`) checks project read
 *     rights for every event before forwarding.
 *
 * Splitting the access token from the WS token keeps the long-lived
 * principal off the wire as a query string parameter.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, signToken } from "../auth.js";

const wsTokenBody = z.object({
  orgId: z.string().uuid().optional(),
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
    // Body fields are advisory only — per-resource authorisation runs at
    // WS open time. The token carries identity (sub/email/principal) plus
    // activeOrgId for the org-scoped channel claim.
    void parsed.data;
    const token = signToken(
      jwtSecret,
      {
        sub: auth.sub,
        email: auth.email,
        typ: "wsClient",
        principal: auth.principal ?? { type: "user" },
        activeOrgId: auth.activeOrgId,
      },
      "5m",
    );
    return reply.send({ token, expiresInSec: 5 * 60 });
  });
}
