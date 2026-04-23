import type { FastifyInstance } from "fastify";
import type { ChangeStream, ResumeToken } from "mongodb";
import type { JwtPayload } from "../auth.js";
import { verifyToken } from "../auth.js";
import { getActiveDb } from "../db.js";
import { getMdxStateHead, getMdxStateWsCursors } from "./schema.js";
import { userCanWriteProject } from "../permission-resolver.js";
import { getWpnProjectsCollection } from "../db.js";

const REVERIFY_INTERVAL_MS = 10_000;
const HEARTBEAT_MS = 20_000;

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
  const project = await getWpnProjectsCollection().findOne({ id: projectId });
  if (!project) return false;
  if (project.userId === auth.sub) return true;
  return userCanWriteProject(auth, projectId);
}

/**
 * Registers the mini-app state WebSocket endpoint.
 *
 * Only mounts if `@fastify/websocket` has been registered on this Fastify
 * instance (detected via the `websocketServer` property the plugin attaches).
 * Contexts that don't support upgrade (e.g. Next.js `app.inject()` used by
 * apps/archon-web) simply skip the route — the HTTP endpoints still work and
 * clients fall back to polling via GET until they hit a deployment that
 * exposes the raw Fastify server.
 *
 * Route: `GET /v1/ws/mdx-state?token=...&projectId=...`.
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

  // v11 handler signature is `(socket, request)`. Using `any` so this file
  // compiles even when the plugin's type augmentation isn't loaded.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).get(
    "/ws/mdx-state",
    { websocket: true },
    async (socket: {
      send: (data: string) => void;
      close: (code?: number, reason?: string) => void;
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      ping?: () => void;
    }, request: { query: { token?: string; projectId?: string } }) => {
      const token = request.query.token ?? "";
      const projectId = request.query.projectId ?? "";
      let payload: WsTokenPayload;
      try {
        payload = verifyToken(jwtSecret, token) as unknown as WsTokenPayload;
      } catch {
        socket.close(4401, "invalid token");
        return;
      }
      if (payload.typ !== "mdxWs" || payload.projectId !== projectId) {
        socket.close(4401, "token/project mismatch");
        return;
      }
      const userId = payload.sub;
      const auth: JwtPayload = { sub: payload.sub, email: payload.email };

      // Initial access check.
      if (!(await hasProjectAccess(auth, projectId))) {
        socket.close(4403, "no access to project");
        return;
      }

      const db = getActiveDb();
      const head = getMdxStateHead(db);
      const cursorsCol = getMdxStateWsCursors(db);
      const connectionId = `${userId}:${projectId}:${Date.now()}:${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      // Resume from last-stored token if present.
      const cursorDoc = await cursorsCol.findOne({ connectionId });
      let changeStream: ChangeStream | null = null;
      const startAfter = cursorDoc?.resumeToken as ResumeToken | undefined;
      try {
        changeStream = head.watch(
          [{ $match: { "fullDocument.projectId": projectId } }],
          {
            fullDocument: "updateLookup",
            ...(startAfter ? { startAfter } : {}),
          },
        );
      } catch (err) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: `change-stream-open-failed: ${(err as Error).message}`,
          }),
        );
        socket.close(4500, "change stream failed");
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

      const onEvent = async (evt: unknown): Promise<void> => {
        const e = evt as {
          fullDocument?: {
            projectId: string;
            key: string;
            mode: "inline" | "chunked";
            version: number;
            value?: unknown;
            updatedAt: Date;
            updatedBy: { userId: string; email: string };
          };
          _id?: ResumeToken;
        };
        const d = e.fullDocument;
        if (!d || d.projectId !== projectId) return;
        const frame: Record<string, unknown> = {
          projectId: d.projectId,
          key: d.key,
          version: d.version,
          mode: d.mode,
          updatedAt: d.updatedAt.toISOString(),
          updatedBy: d.updatedBy,
        };
        if (d.mode === "inline") {
          frame.value = d.value;
        }
        try {
          socket.send(JSON.stringify(frame));
        } catch {
          /* client gone */
        }
        if (e._id) {
          await cursorsCol.updateOne(
            { connectionId },
            {
              $set: {
                connectionId,
                projectId,
                resumeToken: e._id,
                updatedAt: new Date(),
              },
            },
            { upsert: true },
          );
        }
      };

      changeStream.on("change", (evt) => {
        void onEvent(evt);
      });
      changeStream.on("error", (err) => {
        socket.send(JSON.stringify({ type: "error", message: String(err) }));
        socket.close(4500, "change-stream-error");
      });

      socket.on("close", () => {
        clearInterval(reverifyTimer);
        clearInterval(heartbeatTimer);
        void changeStream?.close();
      });
    },
  );
}
