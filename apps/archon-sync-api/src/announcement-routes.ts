import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { requireAuth } from "./auth.js";
import { getSpaceAnnouncementsCollection } from "./db.js";
import {
  createAnnouncementBody,
  updateAnnouncementBody,
} from "./org-schemas.js";
import {
  requireSpaceMember,
  requireSpaceRole,
} from "./space-auth.js";

function isObjectIdHex(s: string): boolean {
  return /^[a-f0-9]{24}$/i.test(s);
}

export function registerAnnouncementRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  /** Any space member may read announcements (pinned first, newest first). */
  app.get("/spaces/:spaceId/announcements", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { spaceId } = request.params as { spaceId: string };
    const ctx = await requireSpaceMember(request, reply, auth, spaceId);
    if (!ctx) {
      return;
    }
    const rows = await getSpaceAnnouncementsCollection()
      .find({ spaceId })
      .sort({ pinned: -1, createdAt: -1 })
      .limit(200)
      .toArray();
    return reply.send({
      announcements: rows.map((r) => ({
        announcementId: r._id.toHexString(),
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

  /** Owner-only: post a new announcement to the space. */
  app.post("/spaces/:spaceId/announcements", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { spaceId } = request.params as { spaceId: string };
    const ctx = await requireSpaceRole(request, reply, auth, spaceId, "owner");
    if (!ctx) {
      return;
    }
    const parsed = createAnnouncementBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const now = new Date();
    const ins = await getSpaceAnnouncementsCollection().insertOne({
      spaceId,
      authorUserId: auth.sub,
      title: parsed.data.title,
      contentMarkdown: parsed.data.contentMarkdown,
      pinned: parsed.data.pinned ?? false,
      createdAt: now,
      updatedAt: now,
    } as never);
    return reply.send({
      announcementId: ins.insertedId.toHexString(),
      spaceId,
      title: parsed.data.title,
      pinned: parsed.data.pinned ?? false,
      createdAt: now,
    });
  });

  /** Owner-only: edit an announcement. (Author or any owner can edit.) */
  app.patch(
    "/spaces/:spaceId/announcements/:announcementId",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) {
        return;
      }
      const { spaceId, announcementId } = request.params as {
        spaceId: string;
        announcementId: string;
      };
      const ctx = await requireSpaceRole(request, reply, auth, spaceId, "owner");
      if (!ctx) {
        return;
      }
      if (!isObjectIdHex(announcementId)) {
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
      const result = await getSpaceAnnouncementsCollection().updateOne(
        { _id: new ObjectId(announcementId), spaceId },
        { $set: set },
      );
      if (result.matchedCount === 0) {
        return reply.status(404).send({ error: "Announcement not found" });
      }
      return reply.status(204).send();
    },
  );

  /** Owner-only: delete an announcement. */
  app.delete(
    "/spaces/:spaceId/announcements/:announcementId",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) {
        return;
      }
      const { spaceId, announcementId } = request.params as {
        spaceId: string;
        announcementId: string;
      };
      const ctx = await requireSpaceRole(request, reply, auth, spaceId, "owner");
      if (!ctx) {
        return;
      }
      if (!isObjectIdHex(announcementId)) {
        return reply.status(404).send({ error: "Announcement not found" });
      }
      const result = await getSpaceAnnouncementsCollection().deleteOne({
        _id: new ObjectId(announcementId),
        spaceId,
      });
      if (result.deletedCount === 0) {
        return reply.status(404).send({ error: "Announcement not found" });
      }
      return reply.status(204).send();
    },
  );
}
