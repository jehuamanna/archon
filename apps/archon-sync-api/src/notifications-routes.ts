import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { requireAuth } from "./auth.js";
import { getNotificationsCollection } from "./db.js";
import type { NotificationDoc } from "./notification-schemas.js";
import {
  listNotificationsQuery,
  markNotificationsReadBody,
} from "./notification-schemas.js";

function toObjectIds(ids: string[]): ObjectId[] {
  const out: ObjectId[] = [];
  for (const id of ids) {
    try {
      out.push(new ObjectId(id));
    } catch {
      /* skip invalid ids silently — treated as no-match */
    }
  }
  return out;
}

function serialize(doc: NotificationDoc): Record<string, unknown> {
  const { _id, consumedAt, readAt, dismissedAt, dedupeKey, ...rest } = doc;
  return {
    id: _id.toHexString(),
    ...rest,
    createdAt: doc.createdAt.toISOString(),
    readAt: readAt ? readAt.toISOString() : null,
    consumedAt: consumedAt ? consumedAt.toISOString() : null,
    dismissedAt: dismissedAt ? dismissedAt.toISOString() : null,
  };
}

export function registerNotificationsRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  app.get("/me/notifications", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const parsed = listNotificationsQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { since, unread, includeConsumed, limit } = parsed.data;
    const col = getNotificationsCollection();
    const filter: Record<string, unknown> = { userId: auth.sub };
    if (unread === "1") {
      filter.status = "unread";
    } else if (includeConsumed !== "1") {
      filter.status = { $in: ["unread", "read"] };
    }
    if (since) {
      try {
        filter._id = { $gt: new ObjectId(since) };
      } catch {
        /* ignore invalid cursor */
      }
    }
    const rows = await col
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit)
      .toArray();
    const notifications = rows.map(serialize);
    const unreadCount = await col.countDocuments({
      userId: auth.sub,
      status: "unread",
    });
    const cursor =
      rows.length > 0 ? rows[0]!._id.toHexString() : (since ?? null);
    return reply.send({ notifications, unreadCount, cursor });
  });

  app.post("/me/notifications/read", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const parsed = markNotificationsReadBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const ids = toObjectIds(parsed.data.ids);
    if (ids.length === 0) {
      return reply.send({ updated: 0 });
    }
    const col = getNotificationsCollection();
    const res = await col.updateMany(
      { _id: { $in: ids }, userId: auth.sub, status: "unread" },
      { $set: { status: "read", readAt: new Date() } },
    );
    return reply.send({ updated: res.modifiedCount });
  });

  app.post("/me/notifications/:id/dismiss", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const params = request.params as { id?: string };
    if (typeof params.id !== "string") {
      return reply.status(400).send({ error: "missing id" });
    }
    let oid: ObjectId;
    try {
      oid = new ObjectId(params.id);
    } catch {
      return reply.status(404).send({ error: "Not found" });
    }
    const col = getNotificationsCollection();
    const res = await col.updateOne(
      { _id: oid, userId: auth.sub },
      { $set: { status: "dismissed", dismissedAt: new Date() } },
    );
    if (res.matchedCount === 0) {
      return reply.status(404).send({ error: "Not found" });
    }
    return reply.send({ ok: true });
  });
}
