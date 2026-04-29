/**
 * Org-scoped realtime WebSocket at `GET /v1/ws/realtime/:orgId`. Carries
 * structural events (note created/moved/etc.) and presence updates.
 *
 * Authenticates the short-TTL `typ: "wsClient"` token via `verifyAndTranslate`.
 * Per-event ACL is in `filter.ts` (`userCanReadProject`), so the route
 * accepts any valid `wsClient` token and the per-event filter handles
 * read-rights. The `:orgId` URL slot keys the per-org realtime channel
 * (`channelForOrg`).
 *
 * Heartbeat is a 20s ping; the legacy 10s space-reverify loop is gone with
 * the spaces table.
 */
import type { FastifyInstance } from "fastify";
import type { JwtPayload } from "../auth.js";
import { verifyAndTranslate } from "../auth-translate.js";
import { acquireChannel } from "./listen-pool.js";
import { channelForOrg, type RealtimeEvent } from "./events.js";
import { canDeliverToSubscriber } from "./filter.js";
import {
  setPresence,
  dropPresence,
  onPresenceChange,
  startPresenceReaper,
  type PresenceState,
} from "./presence.js";

const HEARTBEAT_MS = 20_000;

interface WsClientTokenPayload {
  sub: string;
  email: string;
  typ?: string;
  activeOrgId?: string;
  exp?: number;
}

export function registerRealtimeWsRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(app as any).websocketServer) {
    app.log.info(
      "realtime: skipping /v1/ws/realtime (@fastify/websocket not registered on this instance)",
    );
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).get(
    "/ws/realtime/:orgId",
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
        params: { orgId?: string };
      },
    ) => {
      const token = request.query.token ?? "";
      const orgId = request.params.orgId ?? "";
      if (!orgId) {
        socket.close(4400, "missing orgId");
        return;
      }
      let payload: WsClientTokenPayload;
      try {
        payload = (await verifyAndTranslate(
          jwtSecret,
          token,
        )) as unknown as WsClientTokenPayload;
      } catch {
        socket.close(4401, "invalid token");
        return;
      }
      if (payload.typ !== "wsClient") {
        socket.close(4401, "wrong typ");
        return;
      }
      if (payload.activeOrgId && payload.activeOrgId !== orgId) {
        socket.close(4401, "scope mismatch");
        return;
      }
      // Identity is enough to open the structural-event WS; per-event
      // delivery is gated by `canDeliverToSubscriber` in `filter.ts`, which
      // checks project read rights for every event before forwarding. Token
      // validity (above) still proves principal.
      app.log.info(
        { orgId, sub: payload.sub },
        "realtime: ws opened",
      );

      // Subscribe to the org channel; route delivered events through the
      // ACL filter and onto the socket. Held until the close handler runs.
      // The token's `activeSpaceId` claim is retained on its own type so
      // the wire protocol stays stable; the JwtPayload we hand
      // `canDeliverToSubscriber` only carries identity — per-event
      // filtering does its own project lookup via `userCanReadProject`.
      const authPayload: JwtPayload = {
        sub: payload.sub,
        email: payload.email,
        typ: payload.typ,
      };
      const release = await acquireChannel(channelForOrg(orgId), (raw) => {
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
      const unsubscribePresence = onPresenceChange(orgId, (snapshot) => {
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
            orgId,
            payload.sub,
            msg.state as Omit<PresenceState, "lastSeenAt">,
          );
        }
      });

      // Per-event ACL lives in `filter.ts` (`userCanReadProject`), so a user
      // whose project access is revoked simply stops seeing events on this
      // socket. Heartbeat keeps the connection alive for liveness detection.
      const heartbeat = setInterval(() => {
        try {
          socket.ping?.();
        } catch {
          /* ignore */
        }
      }, HEARTBEAT_MS);

      socket.on("close", () => {
        clearInterval(heartbeat);
        unsubscribePresence();
        dropPresence(orgId, payload.sub);
        void release();
      });
    },
  );
}
