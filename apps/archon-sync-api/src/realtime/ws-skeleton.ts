/**
 * WebSocket skeleton at `GET /v1/ws/space/:spaceId`.
 *
 * Authenticates the short-TTL `typ: "spaceWs"` token via `verifyAndTranslate`.
 * Per-event ACL is in `filter.ts` (`userCanReadProject`), so the route
 * accepts any valid `spaceWs` token and the per-event filter handles
 * read-rights. The `:spaceId` URL parameter is now a vestigial channel key
 * — kept for client compatibility while the post-migration routing settles.
 *
 * Heartbeat is a 20s ping; the legacy 10s space-reverify loop is gone with
 * the spaces table.
 */
import type { FastifyInstance } from "fastify";
import type { JwtPayload } from "../auth.js";
import { verifyAndTranslate } from "../auth-translate.js";
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
      // Identity is enough to open the structural-event WS; per-event
      // delivery is gated by `canDeliverToSubscriber` in `filter.ts`, which
      // checks project read rights for every event before forwarding. The
      // pre-squash space-membership check is gone with the spaces table —
      // the route's `:spaceId` URL parameter is now a vestigial channel key,
      // kept for client compatibility while the broader auth migration
      // settles. Token validity (above) still proves principal.
      app.log.info(
        { spaceId, sub: payload.sub },
        "realtime: ws/space opened",
      );

      // Subscribe to the space channel; route delivered events through the
      // ACL filter and onto the socket. Held until the close handler runs.
      // The token's `activeSpaceId` is preserved on its own type so the
      // protocol stays stable; the JwtPayload we hand `canDeliverToSubscriber`
      // only carries identity — per-event filtering does its own project
      // lookup via `userCanReadProject`.
      const authPayload: JwtPayload = {
        sub: payload.sub,
        email: payload.email,
        typ: payload.typ,
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

      // Per-event ACL lives in `filter.ts` (`userCanReadProject`), so a user
      // whose project access is revoked simply stops seeing events on this
      // socket. The space-level reverify loop is gone with the spaces table.
      // Heartbeat keeps the connection alive for liveness detection.
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
        dropPresence(spaceId, payload.sub);
        void release();
      });
    },
  );
}
