import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, gt, inArray, lt } from "drizzle-orm";
import { requireAuth } from "./auth.js";
import { getDb } from "./pg.js";
import { notifications } from "./db/schema.js";
import {
  listNotificationsQuery,
  markNotificationsReadBody,
} from "./notification-schemas.js";
import { isUuid } from "./db/legacy-id-map.js";

type NotificationRow = typeof notifications.$inferSelect;

/**
 * Cursor parity with the legacy Mongo behavior: paginated newest-first by
 * createdAt. The Mongo route used `_id`-based cursors (ObjectId comparable
 * via createdAt prefix). On PG we use `created_at` directly which is
 * identical in ordering and cleaner across legacy/new ids.
 */
function serialize(d: NotificationRow): Record<string, unknown> {
  return {
    id: d.id,
    userId: d.userId,
    type: d.type,
    payload: d.payload,
    link: d.link,
    status: d.status,
    createdAt: d.createdAt.toISOString(),
    readAt: d.readAt ? d.readAt.toISOString() : null,
    consumedAt: d.consumedAt ? d.consumedAt.toISOString() : null,
    dismissedAt: d.dismissedAt ? d.dismissedAt.toISOString() : null,
  };
}

export function registerNotificationsRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;
  const db = (): ReturnType<typeof getDb> => getDb();

  app.get("/me/notifications", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const parsed = listNotificationsQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { since, unread, includeConsumed, limit } = parsed.data;
    // Status filter
    const conds = [eq(notifications.userId, auth.sub)];
    if (unread === "1") {
      conds.push(eq(notifications.status, "unread"));
    } else if (includeConsumed !== "1") {
      conds.push(inArray(notifications.status, ["unread", "read"]));
    }
    // Cursor: since is the createdAt ISO of the last fetched row OR a UUID id
    // (back-compat for legacy clients passing the id). Prefer ISO timestamp
    // semantics — anything that parses as a Date is used; otherwise treated
    // as a uuid pivot whose createdAt we fetch.
    let cursorDate: Date | null = null;
    if (since) {
      const asDate = new Date(since);
      if (!Number.isNaN(asDate.getTime())) {
        cursorDate = asDate;
      } else if (isUuid(since)) {
        const pivot = await db()
          .select({ createdAt: notifications.createdAt })
          .from(notifications)
          .where(eq(notifications.id, since))
          .limit(1);
        cursorDate = pivot[0]?.createdAt ?? null;
      }
    }
    if (cursorDate) {
      conds.push(lt(notifications.createdAt, cursorDate));
    }
    const rows = await db()
      .select()
      .from(notifications)
      .where(and(...conds))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
    const items = rows.map(serialize);
    const unreadCountRow = await db()
      .select({ n: count() })
      .from(notifications)
      .where(
        and(eq(notifications.userId, auth.sub), eq(notifications.status, "unread")),
      );
    const unreadCount = unreadCountRow[0]?.n ?? 0;
    const cursor =
      rows.length > 0 ? rows[rows.length - 1]!.createdAt.toISOString() : (since ?? null);
    return reply.send({ notifications: items, unreadCount, cursor });
  });

  app.post("/me/notifications/read", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const parsed = markNotificationsReadBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const ids = parsed.data.ids.filter(isUuid);
    if (ids.length === 0) {
      return reply.send({ updated: 0 });
    }
    const result = await db()
      .update(notifications)
      .set({ status: "read", readAt: new Date() })
      .where(
        and(
          inArray(notifications.id, ids),
          eq(notifications.userId, auth.sub),
          eq(notifications.status, "unread"),
        ),
      )
      .returning({ id: notifications.id });
    return reply.send({ updated: result.length });
  });

  app.post("/me/notifications/:id/dismiss", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const params = request.params as { id?: string };
    if (typeof params.id !== "string") {
      return reply.status(400).send({ error: "missing id" });
    }
    if (!isUuid(params.id)) {
      return reply.status(404).send({ error: "Not found" });
    }
    const result = await db()
      .update(notifications)
      .set({ status: "dismissed", dismissedAt: new Date() })
      .where(
        and(eq(notifications.id, params.id), eq(notifications.userId, auth.sub)),
      )
      .returning({ id: notifications.id });
    if (result.length === 0) {
      return reply.status(404).send({ error: "Not found" });
    }
    return reply.send({ ok: true });
  });

  // Suppress unused-import warning.
  void gt;
}
