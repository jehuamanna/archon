import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  asc,
  count,
  eq,
  and,
  gt,
  ilike,
  inArray,
  ne,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { requireMasterAdmin } from "./admin-auth.js";
import { getDb } from "./pg.js";
import {
  organizations,
  orgMemberships,
  projectShares,
  spaceMemberships,
  spaces,
  teamMemberships,
  users,
  workspaceShares,
  wpnExplorerState,
  wpnNotes,
  wpnProjects,
  wpnWorkspaces,
} from "./db/schema.js";
import { recordAudit } from "./audit.js";
import { isUuid } from "./db/legacy-id-map.js";

function generateTempPassword(): string {
  return randomBytes(9).toString("base64url");
}

const upsertMasterBody = z
  .object({
    email: z.string().email().optional(),
    userId: z.string().min(1).optional(),
    password: z.string().min(8).max(256).optional(),
  })
  .refine((d) => d.email || d.userId, {
    message: "email or userId required",
  });

const upsertOrgAdminBody = z
  .object({
    email: z.string().email().optional(),
    userId: z.string().min(1).optional(),
    password: z.string().min(8).max(256).optional(),
  })
  .refine((d) => d.email || d.userId, {
    message: "email or userId required",
  });

async function countMasterAdmins(): Promise<number> {
  const rows = await getDb()
    .select({ n: count() })
    .from(users)
    .where(eq(users.isMasterAdmin, true));
  return rows[0]?.n ?? 0;
}

export function registerMasterAdminRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;
  const db = (): ReturnType<typeof getDb> => getDb();

  /** Master-only: list every org on the platform (metadata only). */
  app.get("/master/orgs", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const orgs = await db()
      .select()
      .from(organizations)
      .orderBy(asc(organizations.name));
    return reply.send({
      orgs: orgs.map((o) => ({
        orgId: o.id,
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
    const userRows = await db()
      .select()
      .from(users)
      .where(eq(users.isMasterAdmin, true))
      .orderBy(asc(users.email));
    return reply.send({
      admins: userRows.map((u) => ({
        userId: u.id,
        email: u.email,
        displayName: u.displayName ?? null,
      })),
    });
  });

  /**
   * Master-only: create a new master admin (promote existing or mint fresh).
   */
  app.post("/master/admins", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const parsed = upsertMasterBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    if (parsed.data.userId) {
      if (!isUuid(parsed.data.userId)) {
        return reply.status(400).send({ error: "Invalid user id" });
      }
      const rows = await db()
        .select()
        .from(users)
        .where(eq(users.id, parsed.data.userId))
        .limit(1);
      const u = rows[0];
      if (!u) return reply.status(404).send({ error: "User not found" });
      await db()
        .update(users)
        .set({ isMasterAdmin: true })
        .where(eq(users.id, u.id));
      return reply.send({
        userId: u.id,
        email: u.email,
        isMasterAdmin: true,
        createdUser: false,
      });
    }

    const email = parsed.data.email!.trim().toLowerCase();
    const existingRows = await db()
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existingRows[0]) {
      return reply.status(409).send({
        error:
          "Email already registered; pass userId to promote the existing account",
      });
    }
    const password = parsed.data.password ?? generateTempPassword();
    const passwordHash = await bcrypt.hash(password, 12);
    const newUserId = randomUUID();
    await db().insert(users).values({
      id: newUserId,
      email,
      passwordHash,
      mustSetPassword: parsed.data.password ? false : true,
      isMasterAdmin: true,
    });
    return reply.send({
      userId: newUserId,
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
    if (!isUuid(userId)) {
      return reply.status(400).send({ error: "Invalid user id" });
    }
    const total = await countMasterAdmins();
    if (total <= 1) {
      return reply
        .status(409)
        .send({ error: "Cannot demote the last master admin" });
    }
    const result = await db()
      .update(users)
      .set({ isMasterAdmin: null })
      .where(and(eq(users.id, userId), eq(users.isMasterAdmin, true)))
      .returning({ id: users.id });
    if (result.length === 0) {
      return reply.status(404).send({ error: "Master admin not found" });
    }
    return reply.status(204).send();
  });

  /** Master-only: list admins of a given org. */
  app.get("/master/orgs/:orgId/admins", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const { orgId } = request.params as { orgId: string };
    const rows = await db()
      .select()
      .from(orgMemberships)
      .where(
        and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, "admin")),
      );
    const userIds = rows.map((r) => r.userId);
    const userRows = userIds.length
      ? await db()
          .select({
            id: users.id,
            email: users.email,
            displayName: users.displayName,
          })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];
    const byId = new Map(userRows.map((u) => [u.id, u]));
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

  /** Master-only: create or promote an org admin. */
  app.post("/master/orgs/:orgId/admins", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const { orgId } = request.params as { orgId: string };
    if (!isUuid(orgId)) {
      return reply.status(400).send({ error: "Invalid org id" });
    }
    const orgRows = await db()
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!orgRows[0]) {
      return reply.status(404).send({ error: "Organization not found" });
    }
    const parsed = upsertOrgAdminBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    let userId: string;
    let createdUser = false;
    let mintedPassword: string | undefined;

    if (parsed.data.userId) {
      if (!isUuid(parsed.data.userId)) {
        return reply.status(400).send({ error: "Invalid user id" });
      }
      const uRows = await db()
        .select()
        .from(users)
        .where(eq(users.id, parsed.data.userId))
        .limit(1);
      if (!uRows[0]) {
        return reply.status(404).send({ error: "User not found" });
      }
      userId = uRows[0].id;
    } else {
      const email = parsed.data.email!.trim().toLowerCase();
      const existing = await db()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (existing[0]) {
        return reply.status(409).send({
          error:
            "Email already registered; pass userId to promote that account",
        });
      }
      const password = parsed.data.password ?? generateTempPassword();
      const passwordHash = await bcrypt.hash(password, 12);
      userId = randomUUID();
      await db().insert(users).values({
        id: userId,
        email,
        passwordHash,
        mustSetPassword: parsed.data.password ? false : true,
        lockedOrgId: orgId,
        defaultOrgId: orgId,
      });
      createdUser = true;
      mintedPassword = parsed.data.password ? undefined : password;
    }

    await db()
      .insert(orgMemberships)
      .values({
        orgId,
        userId,
        role: "admin",
        joinedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [orgMemberships.orgId, orgMemberships.userId],
        set: { role: "admin" },
      });

    await recordAudit({
      orgId,
      actorUserId: ctx.auth.sub,
      principal: ctx.auth.principal ?? { type: "user" },
      action: createdUser
        ? "master.org_admin.create_with_password"
        : "master.org_admin.promote",
      targetType: "org_membership",
      targetId: userId,
    });

    const finalUserRows = await db()
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return reply.send({
      userId,
      email: finalUserRows[0]?.email ?? "",
      role: "admin",
      createdUser,
      password: mintedPassword,
    });
  });

  /** Master-only: demote an org admin (sets role to member). */
  app.delete(
    "/master/orgs/:orgId/admins/:userId",
    async (request, reply) => {
      const ctx = await requireMasterAdmin(request, reply, jwtSecret);
      if (!ctx) return;
      const { orgId, userId } = request.params as {
        orgId: string;
        userId: string;
      };
      const result = await db()
        .update(orgMemberships)
        .set({ role: "member" })
        .where(
          and(
            eq(orgMemberships.orgId, orgId),
            eq(orgMemberships.userId, userId),
            eq(orgMemberships.role, "admin"),
          ),
        )
        .returning({ orgId: orgMemberships.orgId });
      if (result.length === 0) {
        return reply.status(404).send({ error: "Org admin not found" });
      }
      await recordAudit({
        orgId,
        actorUserId: ctx.auth.sub,
        principal: ctx.auth.principal ?? { type: "user" },
        action: "master.org_admin.demote",
        targetType: "org_membership",
        targetId: userId,
      });
      return reply.status(204).send();
    },
  );

  /** Master-only: paginated platform-wide user listing. */
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
    const conds = [] as ReturnType<typeof eq>[];
    if (q.data.q && q.data.q.length > 0) {
      conds.push(ilike(users.email, `%${q.data.q}%`));
    }
    if (q.data.cursor && isUuid(q.data.cursor)) {
      conds.push(gt(users.id, q.data.cursor));
    }
    const where = conds.length > 0 ? and(...conds) : undefined;
    const docs = await (where
      ? db()
          .select()
          .from(users)
          .where(where)
          .orderBy(asc(users.id))
          .limit(limit + 1)
      : db().select().from(users).orderBy(asc(users.id)).limit(limit + 1));
    const hasMore = docs.length > limit;
    const rows = hasMore ? docs.slice(0, limit) : docs;
    const userIds = rows.map((u) => u.id);
    const orgCountRows = userIds.length
      ? await db()
          .select({
            userId: orgMemberships.userId,
            n: sql<number>`count(*)::int`,
          })
          .from(orgMemberships)
          .where(inArray(orgMemberships.userId, userIds))
          .groupBy(orgMemberships.userId)
      : [];
    const orgCountByUser = new Map<string, number>(
      orgCountRows.map((m) => [m.userId, m.n]),
    );
    return reply.send({
      users: rows.map((u) => ({
        userId: u.id,
        email: u.email,
        displayName: u.displayName ?? null,
        isMasterAdmin: u.isMasterAdmin === true,
        lockedOrgId: u.lockedOrgId ?? null,
        disabled: u.disabled === true,
        mustSetPassword: u.mustSetPassword === true,
        orgCount: orgCountByUser.get(u.id) ?? 0,
      })),
      nextCursor: hasMore ? rows[rows.length - 1]!.id : null,
    });
  });

  /** Master-only: disable a user. */
  app.post("/master/users/:userId/disable", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const { userId } = request.params as { userId: string };
    if (!isUuid(userId)) {
      return reply.status(400).send({ error: "Invalid user id" });
    }
    if (userId === ctx.auth.sub) {
      return reply
        .status(400)
        .send({ error: "Cannot disable your own account" });
    }
    const targetRows = await db()
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const target = targetRows[0];
    if (!target) {
      return reply.status(404).send({ error: "User not found" });
    }
    if (target.isMasterAdmin === true) {
      return reply.status(409).send({
        error: "Demote the master admin before disabling the account",
      });
    }
    await db()
      .update(users)
      .set({
        disabled: true,
        refreshSessions: null,
        activeRefreshJti: null,
      })
      .where(eq(users.id, userId));
    return reply.send({ userId, disabled: true });
  });

  /** Master-only: re-enable a disabled user. */
  app.post("/master/users/:userId/enable", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const { userId } = request.params as { userId: string };
    if (!isUuid(userId)) {
      return reply.status(400).send({ error: "Invalid user id" });
    }
    const result = await db()
      .update(users)
      .set({ disabled: null })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    if (result.length === 0) {
      return reply.status(404).send({ error: "User not found" });
    }
    return reply.send({ userId, disabled: false });
  });

  /**
   * Master-only: hard-delete a user. Cascades content the user solely owned
   * and reassigns sole-owner spaces to an admin of the parent org. Returns
   * 409 with the un-reassignable list when no replacement owner exists.
   */
  app.delete("/master/users/:userId", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const { userId } = request.params as { userId: string };
    if (!isUuid(userId)) {
      return reply.status(400).send({ error: "Invalid user id" });
    }
    if (userId === ctx.auth.sub) {
      return reply
        .status(400)
        .send({ error: "Cannot delete your own account" });
    }
    const targetRows = await db()
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const target = targetRows[0];
    if (!target) {
      return reply.status(404).send({ error: "User not found" });
    }
    if (target.isMasterAdmin === true) {
      return reply.status(409).send({
        error: "Demote the master admin before deleting the account",
      });
    }

    // Find spaces where target is sole owner.
    const ownedSpaces = await db()
      .select()
      .from(spaceMemberships)
      .where(
        and(
          eq(spaceMemberships.userId, userId),
          eq(spaceMemberships.role, "owner"),
        ),
      );
    const reassignments: { spaceId: string; newOwnerId: string }[] = [];
    const unresolved: { spaceId: string; name: string }[] = [];
    for (const m of ownedSpaces) {
      const otherOwnersRow = await db()
        .select({ n: count() })
        .from(spaceMemberships)
        .where(
          and(
            eq(spaceMemberships.spaceId, m.spaceId),
            eq(spaceMemberships.role, "owner"),
            ne(spaceMemberships.userId, userId),
          ),
        );
      const otherOwners = otherOwnersRow[0]?.n ?? 0;
      if (otherOwners > 0) continue;
      const spaceRows = await db()
        .select()
        .from(spaces)
        .where(eq(spaces.id, m.spaceId))
        .limit(1);
      const space = spaceRows[0];
      if (!space) continue;
      const replacementRows = await db()
        .select({ userId: orgMemberships.userId })
        .from(orgMemberships)
        .where(
          and(
            eq(orgMemberships.orgId, space.orgId),
            eq(orgMemberships.role, "admin"),
            ne(orgMemberships.userId, userId),
          ),
        )
        .limit(1);
      const replacement = replacementRows[0];
      if (!replacement) {
        unresolved.push({ spaceId: m.spaceId, name: space.name });
        continue;
      }
      reassignments.push({
        spaceId: m.spaceId,
        newOwnerId: replacement.userId,
      });
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
      await db()
        .insert(spaceMemberships)
        .values({
          spaceId: r.spaceId,
          userId: r.newOwnerId,
          role: "owner",
          addedByUserId: ctx.auth.sub,
          joinedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [spaceMemberships.spaceId, spaceMemberships.userId],
          set: { role: "owner" },
        });
    }

    // Cascade the user's owned WPN content.
    const ownedWorkspaces = await db()
      .select({ id: wpnWorkspaces.id })
      .from(wpnWorkspaces)
      .where(eq(wpnWorkspaces.userId, userId));
    const wsIds = ownedWorkspaces.map((w) => w.id);
    if (wsIds.length > 0) {
      const projects = await db()
        .select({ id: wpnProjects.id })
        .from(wpnProjects)
        .where(inArray(wpnProjects.workspace_id, wsIds));
      const projectIds = projects.map((p) => p.id);
      if (projectIds.length > 0) {
        await db()
          .delete(wpnNotes)
          .where(inArray(wpnNotes.project_id, projectIds));
        await db()
          .delete(wpnExplorerState)
          .where(inArray(wpnExplorerState.project_id, projectIds));
        await db()
          .delete(projectShares)
          .where(inArray(projectShares.projectId, projectIds));
      }
      await db()
        .delete(wpnProjects)
        .where(inArray(wpnProjects.workspace_id, wsIds));
      await db()
        .delete(workspaceShares)
        .where(inArray(workspaceShares.workspaceId, wsIds));
      await db().delete(wpnWorkspaces).where(inArray(wpnWorkspaces.id, wsIds));
    }
    await db().delete(workspaceShares).where(eq(workspaceShares.userId, userId));
    await db().delete(orgMemberships).where(eq(orgMemberships.userId, userId));
    await db().delete(spaceMemberships).where(eq(spaceMemberships.userId, userId));
    await db().delete(teamMemberships).where(eq(teamMemberships.userId, userId));
    await db().delete(users).where(eq(users.id, userId));

    return reply.send({
      userId,
      deleted: true,
      reassignedSpaces: reassignments.length,
      deletedWorkspaces: wsIds.length,
    });
  });
}
