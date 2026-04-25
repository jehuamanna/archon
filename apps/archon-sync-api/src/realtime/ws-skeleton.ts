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
import type { JwtPayload } from "../auth.js";
import { verifyAndTranslate } from "../auth-translate.js";
import { effectiveRoleInSpace } from "../permission-resolver.js";
import { acquireChannel } from "./listen-pool.js";
import { channelForSpace, type RealtimeEvent } from "./events.js";
import { canDeliverToSubscriber } from "./filter.js";
import {
  setPresence,
  dropPresence,
  onPresenceChange,
  startPresenceReaper,
  type PresenceState,
} from "./presence.js";

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

      // Subscribe to the space channel; route delivered events through the
      // ACL filter and onto the socket. Held until the close handler runs.
      const authPayload: JwtPayload = {
        sub: payload.sub,
        email: payload.email,
        typ: payload.typ,
        activeOrgId: payload.activeSpaceId,
        activeSpaceId: payload.activeSpaceId,
      };
      const release = await acquireChannel(channelForSpace(spaceId), (raw) => {
        let evt: RealtimeEvent;
        try {
          evt = JSON.parse(raw) as RealtimeEvent;
        } catch {
          return;
        }
        void (async () => {
          try {
            if (!(await canDeliverToSubscriber(authPayload, evt))) return;
            socket.send(JSON.stringify({ type: "event", payload: evt }));
          } catch {
            /* socket gone or filter failure — drop silently */
          }
        })();
      });

      startPresenceReaper();
      const unsubscribePresence = onPresenceChange(spaceId, (snapshot) => {
        try {
          socket.send(
            JSON.stringify({ type: "presence.update", subscribers: snapshot }),
          );
        } catch {
          /* socket gone */
        }
      });

      socket.on("message", (...args: unknown[]) => {
        const raw = args[0];
        let bufStr: string;
        if (typeof raw === "string") bufStr = raw;
        else if (Buffer.isBuffer(raw)) bufStr = raw.toString("utf8");
        else return;
        let msg: { type?: string; state?: unknown };
        try {
          msg = JSON.parse(bufStr);
        } catch {
          return;
        }
        if (
          msg.type === "presence.set" &&
          msg.state &&
          typeof msg.state === "object"
        ) {
          setPresence(
            spaceId,
            payload.sub,
            msg.state as Omit<PresenceState, "lastSeenAt">,
          );
        }
      });

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
        unsubscribePresence();
        dropPresence(spaceId, payload.sub);
        void release();
      });
    },
  );
}
