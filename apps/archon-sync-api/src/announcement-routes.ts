import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { requireAuth } from "./auth.js";
import { getDb } from "./pg.js";
import { spaceAnnouncements } from "./db/schema.js";
import {
  createAnnouncementBody,
  updateAnnouncementBody,
} from "./org-schemas.js";
import { requireSpaceMember, requireSpaceRole } from "./space-auth.js";
import { isUuid } from "./db/legacy-id-map.js";

export function registerAnnouncementRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;
  const db = (): ReturnType<typeof getDb> => getDb();

  app.get("/spaces/:spaceId/announcements", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { spaceId } = request.params as { spaceId: string };
    const ctx = await requireSpaceMember(request, reply, auth, spaceId);
    if (!ctx) return;
    const rows = await db()
      .select()
      .from(spaceAnnouncements)
      .where(eq(spaceAnnouncements.spaceId, ctx.space.id))
      .orderBy(desc(spaceAnnouncements.pinned), desc(spaceAnnouncements.createdAt))
      .limit(200);
    return reply.send({
      announcements: rows.map((r) => ({
        announcementId: r.id,
        spaceId: r.spaceId,
        authorUserId: r.authorUserId,
        title: r.title,
        contentMarkdown: r.contentMarkdown,
        pinned: r.pinned,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  });

  app.post("/spaces/:spaceId/announcements", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { spaceId } = request.params as { spaceId: string };
    const ctx = await requireSpaceRole(request, reply, auth, spaceId, "owner");
    if (!ctx) return;
    const parsed = createAnnouncementBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const now = new Date();
    const announcementId = randomUUID();
    await db().insert(spaceAnnouncements).values({
      id: announcementId,
      spaceId: ctx.space.id,
      authorUserId: auth.sub,
      title: parsed.data.title,
      contentMarkdown: parsed.data.contentMarkdown,
      pinned: parsed.data.pinned ?? false,
      createdAt: now,
      updatedAt: now,
    });
    return reply.send({
      announcementId,
      spaceId: ctx.space.id,
      title: parsed.data.title,
      pinned: parsed.data.pinned ?? false,
      createdAt: now,
    });
  });

  app.patch(
    "/spaces/:spaceId/announcements/:announcementId",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { spaceId, announcementId } = request.params as {
        spaceId: string;
        announcementId: string;
      };
      const ctx = await requireSpaceRole(request, reply, auth, spaceId, "owner");
      if (!ctx) return;
      if (!isUuid(announcementId)) {
        return reply.status(404).send({ error: "Announcement not found" });
      }
      const parsed = updateAnnouncementBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.title !== undefined) set.title = parsed.data.title;
      if (parsed.data.contentMarkdown !== undefined)
        set.contentMarkdown = parsed.data.contentMarkdown;
      if (parsed.data.pinned !== undefined) set.pinned = parsed.data.pinned;
      const result = await db()
        .update(spaceAnnouncements)
        .set(set)
        .where(
          and(
            eq(spaceAnnouncements.id, announcementId),
            eq(spaceAnnouncements.spaceId, ctx.space.id),
          ),
        )
        .returning({ id: spaceAnnouncements.id });
      if (result.length === 0) {
        return reply.status(404).send({ error: "Announcement not found" });
      }
      return reply.status(204).send();
    },
  );

  app.delete(
    "/spaces/:spaceId/announcements/:announcementId",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { spaceId, announcementId } = request.params as {
        spaceId: string;
        announcementId: string;
      };
      const ctx = await requireSpaceRole(request, reply, auth, spaceId, "owner");
      if (!ctx) return;
      if (!isUuid(announcementId)) {
        return reply.status(404).send({ error: "Announcement not found" });
      }
      const result = await db()
        .delete(spaceAnnouncements)
        .where(
          and(
            eq(spaceAnnouncements.id, announcementId),
            eq(spaceAnnouncements.spaceId, ctx.space.id),
          ),
        )
        .returning({ id: spaceAnnouncements.id });
      if (result.length === 0) {
        return reply.status(404).send({ error: "Announcement not found" });
      }
      return reply.status(204).send();
    },
  );
}
