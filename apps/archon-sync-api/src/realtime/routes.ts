/**
 * Realtime WS token-mint endpoint. The web client calls
 * `POST /v1/realtime/ws-token` with an access token in `Authorization`,
 * specifying a `spaceId` (legacy parameter — preserved for client compat
 * after the spaces → projects squash) plus optional `noteId`/`workspaceId`.
 * The server returns a 5-minute `typ: "spaceWs"` JWT the client uses to
 * open the Yjs WebSocket at `GET /v1/ws/yjs?token=<jwt>`.
 *
 * Authorisation moved per-note: the spaces table no longer exists, so the
 * fine-grained gate runs in `yjs-ws.ts` `onAuthenticate`, which resolves
 * the documentName (noteId) → project and checks `effectiveRoleInProject`.
 * This route only proves identity (via `requireAuth`); a token without a
 * matching project grant gets rejected at WS open time.
 *
 * Splitting the access token from the WS token still keeps the long-lived
 * principal off the wire as a query string parameter.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, signToken } from "../auth.js";

const wsTokenBody = z.object({
  spaceId: z.string().uuid().optional(),
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
    // The minted token carries identity only — per-note authorisation runs
    // at WS open in `yjs-ws.ts onAuthenticate`. The body's `spaceId` is
    // accepted (and ignored) for client compat after the spaces squash.
    void parsed.data;
    const token = signToken(
      jwtSecret,
      {
        sub: auth.sub,
        email: auth.email,
        typ: "spaceWs",
        principal: auth.principal ?? { type: "user" },
        activeOrgId: auth.activeOrgId,
      },
      "5m",
    );
    return reply.send({ token, expiresInSec: 5 * 60 });
  });
}
