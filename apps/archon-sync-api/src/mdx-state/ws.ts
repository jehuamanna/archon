import type { FastifyInstance } from "fastify";
import type { JwtPayload } from "../auth.js";
import { verifyAndTranslate } from "../auth-translate.js";
import { acquireDedicatedClient, getDb } from "../pg.js";
import { eq } from "drizzle-orm";
import { wpnProjects } from "../db/schema.js";
import { userCanWriteProject } from "../permission-resolver.js";
import { MdxStateService } from "./service.js";

const REVERIFY_INTERVAL_MS = 10_000;
const HEARTBEAT_MS = 20_000;
const IDLE_RELEASE_MS = 60_000;

interface WsTokenPayload {
  sub: string;
  email: string;
  typ?: string;
  projectId?: string;
  exp?: number;
}

async function hasProjectAccess(
  auth: JwtPayload,
  projectId: string,
): Promise<boolean> {
  const projectRows = await getDb()
    .select({ userId: wpnProjects.userId })
    .from(wpnProjects)
    .where(eq(wpnProjects.id, projectId))
    .limit(1);
  const project = projectRows[0];
  if (!project) return false;
  if (project.userId === auth.sub) return true;
  return userCanWriteProject(auth, projectId);
}

/**
 * Refcounted LISTEN/NOTIFY channel manager. One dedicated `pg.Client` per
 * `mdx:<projectId>` channel; subscribers register a callback and get
 * notification frames re-fetched from the head row. When the last subscriber
 * disconnects the channel is released after a short idle window so a quick
 * reconnect doesn't pay the LISTEN setup cost.
 */
type ChannelEntry = {
  refcount: number;
  client: import("pg").PoolClient;
  subscribers: Set<(payload: string) => void>;
  idleTimer: NodeJS.Timeout | null;
};
const channels = new Map<string, ChannelEntry>();

async function acquireChannel(
  projectId: string,
  onNotify: (payload: string) => void,
): Promise<() => Promise<void>> {
  const channelName = `mdx:${projectId}`;
  let entry = channels.get(channelName);
  if (!entry) {
    const client = await acquireDedicatedClient();
    const subscribers = new Set<(p: string) => void>();
    client.on("notification", (msg) => {
      if (msg.channel !== channelName) return;
      const payload = msg.payload ?? "";
      for (const cb of subscribers) {
        try {
          cb(payload);
        } catch {
          /* ignore subscriber errors */
        }
      }
    });
    // Channel name needs SQL-quoting via identifier safe-chars; mdx:<uuid>
    // contains a colon which needs double-quoting at the SQL layer.
    await client.query(`LISTEN "${channelName.replace(/"/g, '""')}"`);
    entry = { refcount: 0, client, subscribers, idleTimer: null };
    channels.set(channelName, entry);
  }
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  entry.refcount++;
  entry.subscribers.add(onNotify);
  return async () => {
    if (!entry) return;
    entry.subscribers.delete(onNotify);
    entry.refcount--;
    if (entry.refcount <= 0) {
      // Schedule release after an idle window.
      entry.idleTimer = setTimeout(() => {
        const stillIdle = entry!.refcount <= 0;
        if (!stillIdle) return;
        channels.delete(channelName);
        void (async () => {
          try {
            await entry!.client.query(
              `UNLISTEN "${channelName.replace(/"/g, '""')}"`,
            );
          } catch {
            /* ignore */
          }
          entry!.client.release();
        })();
      }, IDLE_RELEASE_MS);
    }
  };
}

/**
 * Registers the mini-app state WebSocket endpoint at GET /v1/ws/mdx-state.
 * Path matches the legacy Mongo Change Streams endpoint so the web client
 * doesn't need to change.
 */
export function registerMdxStateWsRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(app as any).websocketServer) {
    app.log.info(
      "mdx-state: skipping WebSocket route (@fastify/websocket not registered on this instance)",
    );
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).get(
    "/ws/mdx-state",
    { websocket: true },
    async (
      socket: {
        send: (data: string) => void;
        close: (code?: number, reason?: string) => void;
        on: (event: string, listener: (...args: unknown[]) => void) => void;
        off?: (event: string, listener: (...args: unknown[]) => void) => void;
        ping?: () => void;
      },
      request: { query: { token?: string; projectId?: string } },
    ) => {
      const token = request.query.token ?? "";
      const projectId = request.query.projectId ?? "";
      let payload: WsTokenPayload;
      try {
        payload = (await verifyAndTranslate(jwtSecret, token)) as unknown as WsTokenPayload;
      } catch {
        socket.close(4401, "invalid token");
        return;
      }
      if (payload.typ !== "mdxWs" || payload.projectId !== projectId) {
        socket.close(4401, "token/project mismatch");
        return;
      }
      const auth: JwtPayload = { sub: payload.sub, email: payload.email };

      if (!(await hasProjectAccess(auth, projectId))) {
        socket.close(4403, "no access to project");
        return;
      }

      const svc = new MdxStateService();

      const onNotify = (payloadJson: string): void => {
        let parsed: { key?: string; version?: number };
        try {
          parsed = JSON.parse(payloadJson) as { key?: string; version?: number };
        } catch {
          return;
        }
        const key = parsed.key;
        if (typeof key !== "string") return;
        // Re-fetch the head row to deliver the value frame to clients.
        void (async () => {
          try {
            const res = await svc.get(projectId, key);
            const frame = {
              projectId,
              key,
              version: res.version,
              mode: res.mode,
              ...(res.mode === "inline" ? { value: res.value } : {}),
            };
            try {
              socket.send(JSON.stringify(frame));
            } catch {
              /* client gone */
            }
          } catch (err) {
            try {
              socket.send(
                JSON.stringify({
                  type: "error",
                  message: `head-fetch-failed: ${(err as Error).message}`,
                }),
              );
            } catch {
              /* ignore */
            }
          }
        })();
      };

      let release: (() => Promise<void>) | null = null;
      try {
        release = await acquireChannel(projectId, onNotify);
      } catch (err) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: `listen-open-failed: ${(err as Error).message}`,
          }),
        );
        socket.close(4500, "listen failed");
        return;
      }

      const reverifyTimer = setInterval(async () => {
        if (!(await hasProjectAccess(auth, projectId))) {
          socket.close(4403, "access revoked");
        }
      }, REVERIFY_INTERVAL_MS);

      const heartbeatTimer = setInterval(() => {
        try {
          socket.ping?.();
        } catch {
          /* ignore */
        }
      }, HEARTBEAT_MS);

      socket.on("close", () => {
        clearInterval(reverifyTimer);
        clearInterval(heartbeatTimer);
        if (release) void release();
      });
    },
  );
}
