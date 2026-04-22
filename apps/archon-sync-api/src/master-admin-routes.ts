import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireMasterAdmin } from "./admin-auth.js";
import {
  getOrgMembershipsCollection,
  getOrgsCollection,
  getSpaceMembershipsCollection,
  getSpacesCollection,
  getTeamMembershipsCollection,
  getUsersCollection,
  getWorkspaceSharesCollection,
  getWpnExplorerStateCollection,
  getWpnNotesCollection,
  getWpnProjectsCollection,
  getWpnWorkspacesCollection,
  type UserDoc,
} from "./db.js";
import { recordAudit } from "./audit.js";

function generateTempPassword(): string {
  return randomBytes(9).toString("base64url");
}

const upsertMasterBody = z.object({
  email: z.string().email().optional(),
  userId: z.string().min(1).optional(),
  password: z.string().min(8).max(256).optional(),
}).refine((d) => d.email || d.userId, {
  message: "email or userId required",
});

const upsertOrgAdminBody = z.object({
  email: z.string().email().optional(),
  userId: z.string().min(1).optional(),
  password: z.string().min(8).max(256).optional(),
}).refine((d) => d.email || d.userId, {
  message: "email or userId required",
});

function isObjectIdHex(s: string): boolean {
  return /^[a-f0-9]{24}$/i.test(s);
}

async function countMasterAdmins(): Promise<number> {
  return getUsersCollection().countDocuments({ isMasterAdmin: true });
}

export function registerMasterAdminRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  /** Master-only: list every org on the platform (metadata only, no content). */
  app.get("/master/orgs", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const orgs = await getOrgsCollection()
      .find({})
      .sort({ name: 1 })
      .toArray();
    return reply.send({
      orgs: orgs.map((o) => ({
        orgId: o._id.toHexString(),
        name: o.name,
        slug: o.slug,
        createdAt: o.createdAt,
      })),
    });
  });

  /** Master-only: list every master admin. */
  app.get("/master/admins", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const users = (await getUsersCollection()
      .find({ isMasterAdmin: true })
      .sort({ email: 1 })
      .toArray()) as UserDoc[];
    return reply.send({
      admins: users.map((u) => ({
        userId: u._id.toHexString(),
        email: u.email,
        displayName: u.displayName ?? null,
      })),
    });
  });

  /**
   * Master-only: create a new master admin, either by promoting an existing
   * user (body.userId) or minting a fresh account (body.email, optional
   * body.password — otherwise a temp password is generated and returned once).
   */
  app.post("/master/admins", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const parsed = upsertMasterBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const users = getUsersCollection();

    if (parsed.data.userId) {
      if (!isObjectIdHex(parsed.data.userId)) {
        return reply.status(400).send({ error: "Invalid user id" });
      }
      const u = (await users.findOne({
        _id: new ObjectId(parsed.data.userId),
      })) as UserDoc | null;
      if (!u) {
        return reply.status(404).send({ error: "User not found" });
      }
      await users.updateOne(
        { _id: u._id },
        { $set: { isMasterAdmin: true } },
      );
      return reply.send({
        userId: u._id.toHexString(),
        email: u.email,
        isMasterAdmin: true,
        createdUser: false,
      });
    }

    const email = parsed.data.email!.trim().toLowerCase();
    const existing = (await users.findOne({ email })) as UserDoc | null;
    if (existing) {
      return reply.status(409).send({
        error: "Email already registered; pass userId to promote the existing account",
      });
    }
    const password = parsed.data.password ?? generateTempPassword();
    const passwordHash = await bcrypt.hash(password, 12);
    const ins = await users.insertOne({
      email,
      passwordHash,
      mustSetPassword: parsed.data.password ? false : true,
      isMasterAdmin: true,
    } as Omit<UserDoc, "_id">);
    return reply.send({
      userId: ins.insertedId.toHexString(),
      email,
      isMasterAdmin: true,
      createdUser: true,
      password: parsed.data.password ? undefined : password,
    });
  });

  /** Master-only: demote another master admin. Blocks removing the last one. */
  app.delete("/master/admins/:userId", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const { userId } = request.params as { userId: string };
    if (!isObjectIdHex(userId)) {
      return reply.status(400).send({ error: "Invalid user id" });
    }
    const total = await countMasterAdmins();
    if (total <= 1) {
      return reply
        .status(409)
        .send({ error: "Cannot demote the last master admin" });
    }
    const result = await getUsersCollection().updateOne(
      { _id: new ObjectId(userId), isMasterAdmin: true },
      { $unset: { isMasterAdmin: "" } },
    );
    if (result.matchedCount === 0) {
      return reply.status(404).send({ error: "Master admin not found" });
    }
    return reply.status(204).send();
  });

  /** Master-only: list admins of a given org. */
  app.get("/master/orgs/:orgId/admins", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const { orgId } = request.params as { orgId: string };
    const rows = await getOrgMembershipsCollection()
      .find({ orgId, role: "admin" })
      .toArray();
    const userIds = rows.map((r) => r.userId).filter(isObjectIdHex);
    const users = (await getUsersCollection()
      .find({ _id: { $in: userIds.map((id) => new ObjectId(id)) } })
      .toArray()) as UserDoc[];
    const byId = new Map(users.map((u) => [u._id.toHexString(), u]));
    return reply.send({
      admins: rows.map((r) => {
        const u = byId.get(r.userId);
        return {
          userId: r.userId,
          email: u?.email ?? "(unknown)",
          displayName: u?.displayName ?? null,
          joinedAt: r.joinedAt,
        };
      }),
    });
  });

  /**
   * Master-only: create or promote an org admin. Body accepts either
   * `userId` (promote existing user) or `email` + optional `password` (mint
   * a new user locked to this org, return the temp password once).
   */
  app.post("/master/orgs/:orgId/admins", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const { orgId } = request.params as { orgId: string };
    if (!isObjectIdHex(orgId)) {
      return reply.status(400).send({ error: "Invalid org id" });
    }
    const org = await getOrgsCollection().findOne({ _id: new ObjectId(orgId) });
    if (!org) {
      return reply.status(404).send({ error: "Organization not found" });
    }
    const parsed = upsertOrgAdminBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const users = getUsersCollection();
    const memberships = getOrgMembershipsCollection();

    let userIdHex: string;
    let createdUser = false;
    let mintedPassword: string | undefined;

    if (parsed.data.userId) {
      if (!isObjectIdHex(parsed.data.userId)) {
        return reply.status(400).send({ error: "Invalid user id" });
      }
      const u = (await users.findOne({
        _id: new ObjectId(parsed.data.userId),
      })) as UserDoc | null;
      if (!u) {
        return reply.status(404).send({ error: "User not found" });
      }
      userIdHex = u._id.toHexString();
    } else {
      const email = parsed.data.email!.trim().toLowerCase();
      const existing = (await users.findOne({ email })) as UserDoc | null;
      if (existing) {
        return reply.status(409).send({
          error: "Email already registered; pass userId to promote that account",
        });
      }
      const password = parsed.data.password ?? generateTempPassword();
      const passwordHash = await bcrypt.hash(password, 12);
      const ins = await users.insertOne({
        email,
        passwordHash,
        mustSetPassword: parsed.data.password ? false : true,
        lockedOrgId: orgId,
        defaultOrgId: orgId,
      } as Omit<UserDoc, "_id">);
      userIdHex = ins.insertedId.toHexString();
      createdUser = true;
      mintedPassword = parsed.data.password ? undefined : password;
    }

    await memberships.updateOne(
      { orgId, userId: userIdHex },
      {
        $set: { role: "admin" },
        $setOnInsert: {
          orgId,
          userId: userIdHex,
          joinedAt: new Date(),
        },
      },
      { upsert: true },
    );

    await recordAudit({
      orgId,
      actorUserId: ctx.auth.sub,
      action: createdUser
        ? "master.org_admin.create_with_password"
        : "master.org_admin.promote",
      targetType: "org_membership",
      targetId: userIdHex,
    });

    const u = (await users.findOne({ _id: new ObjectId(userIdHex) })) as UserDoc;
    return reply.send({
      userId: userIdHex,
      email: u.email,
      role: "admin",
      createdUser,
      password: mintedPassword,
    });
  });

  /**
   * Master-only: demote an org admin (set their membership role to `member`).
   * Does not remove them from the org.
   */
  app.delete("/master/orgs/:orgId/admins/:userId", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const { orgId, userId } = request.params as { orgId: string; userId: string };
    const result = await getOrgMembershipsCollection().updateOne(
      { orgId, userId, role: "admin" },
      { $set: { role: "member" } },
    );
    if (result.matchedCount === 0) {
      return reply.status(404).send({ error: "Org admin not found" });
    }
    await recordAudit({
      orgId,
      actorUserId: ctx.auth.sub,
      action: "master.org_admin.demote",
      targetType: "org_membership",
      targetId: userId,
    });
    return reply.status(204).send();
  });

  /**
   * Master-only: paginated platform-wide user listing. Optional `q` filters
   * by case-insensitive email substring. Cursor is the last returned `userId`.
   */
  app.get("/master/users", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const q = z
      .object({
        q: z.string().trim().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
      })
      .safeParse(request.query);
    if (!q.success) {
      return reply.status(400).send({ error: q.error.flatten() });
    }
    const limit = q.data.limit ?? 50;
    const filter: Record<string, unknown> = {};
    if (q.data.q && q.data.q.length > 0) {
      const escaped = q.data.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.email = { $regex: escaped, $options: "i" };
    }
    if (q.data.cursor && isObjectIdHex(q.data.cursor)) {
      filter._id = { $gt: new ObjectId(q.data.cursor) };
    }
    const docs = (await getUsersCollection()
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .toArray()) as UserDoc[];
    const hasMore = docs.length > limit;
    const rows = hasMore ? docs.slice(0, limit) : docs;
    const orgMemberships = (await getOrgMembershipsCollection()
      .aggregate([
        { $match: { userId: { $in: rows.map((u) => u._id.toHexString()) } } },
        { $group: { _id: "$userId", count: { $sum: 1 } } },
      ])
      .toArray()) as Array<{ _id: string; count: number }>;
    const orgCountByUser = new Map<string, number>(
      orgMemberships.map((m) => [m._id, m.count]),
    );
    return reply.send({
      users: rows.map((u) => ({
        userId: u._id.toHexString(),
        email: u.email,
        displayName: u.displayName ?? null,
        isMasterAdmin: u.isMasterAdmin === true,
        lockedOrgId: u.lockedOrgId ?? null,
        disabled: u.disabled === true,
        mustSetPassword: u.mustSetPassword === true,
        orgCount: orgCountByUser.get(u._id.toHexString()) ?? 0,
      })),
      nextCursor: hasMore ? rows[rows.length - 1]!._id.toHexString() : null,
    });
  });

  /** Master-only: disable a user account. Idempotent. Rejects self + other masters. */
  app.post("/master/users/:userId/disable", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const { userId } = request.params as { userId: string };
    if (!isObjectIdHex(userId)) {
      return reply.status(400).send({ error: "Invalid user id" });
    }
    if (userId === ctx.auth.sub) {
      return reply.status(400).send({ error: "Cannot disable your own account" });
    }
    const target = (await getUsersCollection().findOne({
      _id: new ObjectId(userId),
    })) as UserDoc | null;
    if (!target) {
      return reply.status(404).send({ error: "User not found" });
    }
    if (target.isMasterAdmin === true) {
      return reply.status(409).send({
        error: "Demote the master admin before disabling the account",
      });
    }
    await getUsersCollection().updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: { disabled: true },
        $unset: { refreshSessions: "", activeRefreshJti: "" },
      },
    );
    return reply.send({ userId, disabled: true });
  });

  /** Master-only: re-enable a disabled user account. Idempotent. */
  app.post("/master/users/:userId/enable", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const { userId } = request.params as { userId: string };
    if (!isObjectIdHex(userId)) {
      return reply.status(400).send({ error: "Invalid user id" });
    }
    const result = await getUsersCollection().updateOne(
      { _id: new ObjectId(userId) },
      { $unset: { disabled: "" } },
    );
    if (result.matchedCount === 0) {
      return reply.status(404).send({ error: "User not found" });
    }
    return reply.send({ userId, disabled: false });
  });

  /**
   * Master-only: hard-delete a user. Cascades content the user solely owned
   * and, for spaces where they're the sole owner, reassigns ownership to an
   * admin of the parent org. Returns 409 with a list of un-reassignable
   * spaces when no replacement owner exists in their parent orgs.
   */
  app.delete("/master/users/:userId", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const { userId } = request.params as { userId: string };
    if (!isObjectIdHex(userId)) {
      return reply.status(400).send({ error: "Invalid user id" });
    }
    if (userId === ctx.auth.sub) {
      return reply.status(400).send({ error: "Cannot delete your own account" });
    }
    const targetOid = new ObjectId(userId);
    const target = (await getUsersCollection().findOne({ _id: targetOid })) as UserDoc | null;
    if (!target) {
      return reply.status(404).send({ error: "User not found" });
    }
    if (target.isMasterAdmin === true) {
      return reply.status(409).send({
        error: "Demote the master admin before deleting the account",
      });
    }

    // Pre-flight: find spaces where target is a sole owner and try to pick a new owner.
    const ownedSpaces = await getSpaceMembershipsCollection()
      .find({ userId, role: "owner" })
      .toArray();
    const reassignments: { spaceId: string; newOwnerId: string }[] = [];
    const unresolved: { spaceId: string; name: string }[] = [];
    for (const m of ownedSpaces) {
      const otherOwners = await getSpaceMembershipsCollection().countDocuments({
        spaceId: m.spaceId,
        role: "owner",
        userId: { $ne: userId },
      });
      if (otherOwners > 0) continue;
      if (!isObjectIdHex(m.spaceId)) continue;
      const space = await getSpacesCollection().findOne({ _id: new ObjectId(m.spaceId) });
      if (!space) continue;
      const replacement = await getOrgMembershipsCollection().findOne({
        orgId: space.orgId,
        role: "admin",
        userId: { $ne: userId },
      });
      if (!replacement) {
        unresolved.push({ spaceId: m.spaceId, name: space.name });
        continue;
      }
      reassignments.push({ spaceId: m.spaceId, newOwnerId: replacement.userId });
    }
    if (unresolved.length > 0) {
      return reply.status(409).send({
        error:
          "Target owns spaces with no eligible replacement org admin; resolve them manually first",
        unresolvedSpaces: unresolved,
      });
    }

    // Apply space-ownership transfers.
    for (const r of reassignments) {
      await getSpaceMembershipsCollection().updateOne(
        { spaceId: r.spaceId, userId: r.newOwnerId },
        {
          $set: { role: "owner" },
          $setOnInsert: {
            spaceId: r.spaceId,
            userId: r.newOwnerId,
            addedByUserId: ctx.auth.sub,
            joinedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }

    // Cascade the user's owned WPN content.
    const ownedWorkspaces = await getWpnWorkspacesCollection().find({ userId }).toArray();
    const wsIds = ownedWorkspaces.map((w) => w.id);
    if (wsIds.length > 0) {
      const projects = await getWpnProjectsCollection()
        .find({ workspace_id: { $in: wsIds } })
        .toArray();
      const projectIds = projects.map((p) => p.id);
      if (projectIds.length > 0) {
        await getWpnNotesCollection().deleteMany({ project_id: { $in: projectIds } });
        await getWpnExplorerStateCollection().deleteMany({
          project_id: { $in: projectIds },
        });
      }
      await getWpnProjectsCollection().deleteMany({ workspace_id: { $in: wsIds } });
      await getWorkspaceSharesCollection().deleteMany({ workspaceId: { $in: wsIds } });
      await getWpnWorkspacesCollection().deleteMany({ id: { $in: wsIds } });
    }
    // Remove target from any workspace-share allow lists.
    await getWorkspaceSharesCollection().deleteMany({ userId });
    // Remove all org/space/team memberships.
    await getOrgMembershipsCollection().deleteMany({ userId });
    await getSpaceMembershipsCollection().deleteMany({ userId });
    await getTeamMembershipsCollection().deleteMany({ userId });
    // Delete the user doc itself.
    await getUsersCollection().deleteOne({ _id: targetOid });

    return reply.send({
      userId,
      deleted: true,
      reassignedSpaces: reassignments.length,
      deletedWorkspaces: wsIds.length,
    });
  });
}
