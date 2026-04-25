/**
 * Phase 1 WebSocket skeleton at `GET /v1/ws/space/:spaceId`.
 *
 * Authenticates the short-TTL `typ: "spaceWs"` token via `verifyAndTranslate`,
 * gates on `effectiveRoleInSpace`, then keeps the socket alive with a 20s
 * ping and a 10s revoke-aware reverify loop. Phase 3 wires actual event
 * subscription via `realtime/listen-pool.ts`; for now the connection
 * accepts the handshake and idles.
 */
import type { FastifyInstance } from "fastify";
import { verifyAndTranslate } from "../auth-translate.js";
import { effectiveRoleInSpace } from "../permission-resolver.js";

const REVERIFY_INTERVAL_MS = 10_000;
const HEARTBEAT_MS = 20_000;

interface SpaceWsTokenPayload {
  sub: string;
  email: string;
  typ?: string;
  activeSpaceId?: string;
  exp?: number;
}

export function registerSpaceWsRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(app as any).websocketServer) {
    app.log.info(
      "realtime: skipping /v1/ws/space (@fastify/websocket not registered on this instance)",
    );
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).get(
    "/ws/space/:spaceId",
    { websocket: true },
    async (
      socket: {
        send: (data: string) => void;
        close: (code?: number, reason?: string) => void;
        on: (event: string, listener: (...args: unknown[]) => void) => void;
        ping?: () => void;
      },
      request: {
        query: { token?: string };
        params: { spaceId?: string };
      },
    ) => {
      const token = request.query.token ?? "";
      const spaceId = request.params.spaceId ?? "";
      if (!spaceId) {
        socket.close(4400, "missing spaceId");
        return;
      }
      let payload: SpaceWsTokenPayload;
      try {
        payload = (await verifyAndTranslate(
          jwtSecret,
          token,
        )) as unknown as SpaceWsTokenPayload;
      } catch {
        socket.close(4401, "invalid token");
        return;
      }
      if (payload.typ !== "spaceWs") {
        socket.close(4401, "wrong typ");
        return;
      }
      if (payload.activeSpaceId && payload.activeSpaceId !== spaceId) {
        socket.close(4401, "space mismatch");
        return;
      }
      const role = await effectiveRoleInSpace(payload.sub, spaceId);
      if (!role) {
        socket.close(4403, "no access to space");
        return;
      }
      app.log.info(
        { spaceId, sub: payload.sub, role },
        "realtime: ws/space opened",
      );

      const reverify = setInterval(() => {
        void (async () => {
          try {
            const r = await effectiveRoleInSpace(payload.sub, spaceId);
            if (!r) socket.close(4403, "access revoked");
          } catch {
            /* ignore — reverify failures shouldn't tear the socket down */
          }
        })();
      }, REVERIFY_INTERVAL_MS);
      const heartbeat = setInterval(() => {
        try {
          socket.ping?.();
        } catch {
          /* ignore */
        }
      }, HEARTBEAT_MS);

      socket.on("close", () => {
        clearInterval(reverify);
        clearInterval(heartbeat);
        // Phase 3 will release the listen-pool subscription here.
      });
    },
  );
}
