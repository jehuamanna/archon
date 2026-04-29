import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  asc,
  count,
  desc,
  eq,
  and,
  gt,
  ilike,
  inArray,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { isBootstrapMasterAdminEmail, requireMasterAdmin } from "./admin-auth.js";
import { getDb } from "./pg.js";
import {
  masterInvites,
  organizations,
  orgMemberships,
  users,
} from "./db/schema.js";
import { recordAudit } from "./audit.js";
import { isUuid } from "./db/legacy-id-map.js";

function generateTempPassword(): string {
  return randomBytes(9).toString("base64url");
}

/** 7-day invite TTL — matches `org_invites` so admins have one mental model. */
const MASTER_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashMasterInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newMasterInviteToken(): { plain: string; hash: string } {
  const plain = randomBytes(32).toString("base64url");
  return { plain, hash: hashMasterInviteToken(plain) };
}

const createMasterInviteBody = z.object({
  email: z.string().email(),
});

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
        isBootstrap: isBootstrapMasterAdminEmail(u.email),
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
      // Email already maps to a user — promote-in-place instead of forcing
      // the operator to look up a UUID. Idempotent if they're already a
      // master admin.
      const u = existingRows[0];
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

  /**
   * Master-only: demote another master admin.
   *
   * Two safety rails:
   *  - Cannot demote the bootstrap admin (the account whose email matches
   *    `ARCHON_MASTER_ADMIN_EMAIL`). `ensureMasterAdmin` re-promotes that row
   *    on every boot, so demoting it would either be churn-only or, if the
   *    env var is later changed, leave the platform without its operator.
   *  - Cannot demote the last remaining master admin (count guard kept as a
   *    fallback for deployments that boot without the env var set).
   */
  app.delete("/master/admins/:userId", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const { userId } = request.params as { userId: string };
    if (!isUuid(userId)) {
      return reply.status(400).send({ error: "Invalid user id" });
    }
    const targetRows = await db()
      .select({ id: users.id, email: users.email, isMasterAdmin: users.isMasterAdmin })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const target = targetRows[0];
    if (!target || target.isMasterAdmin !== true) {
      return reply.status(404).send({ error: "Master admin not found" });
    }
    if (isBootstrapMasterAdminEmail(target.email)) {
      return reply
        .status(409)
        .send({ error: "Cannot demote the bootstrap master admin" });
    }
    const total = await countMasterAdmins();
    if (total <= 1) {
      return reply
        .status(409)
        .send({ error: "Cannot demote the last master admin" });
    }
    await db()
      .update(users)
      .set({ isMasterAdmin: null })
      .where(eq(users.id, target.id));
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
        // Email already maps to a user (e.g. another org's member, or a
        // master admin). Promote-in-place instead of forcing the operator
        // to look up a UUID — the audit action below stays `promote`,
        // distinct from `create_with_password`, so attribution is clean.
        userId = existing[0].id;
      } else {
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
    await recordAudit({
      orgId: target.defaultOrgId ?? target.lastActiveOrgId ?? "",
      actorUserId: ctx.auth.sub,
      principal: ctx.auth.principal ?? { type: "user" },
      action: "master.user.disable",
      targetType: "user",
      targetId: userId,
    });
    return reply.send({ userId, disabled: true });
  });

  /**
   * Master-only: reset any user's password. Optionally accepts an explicit
   * `password`; otherwise a temp password is minted and returned in the
   * response body for one-time hand-off. Always sets `mustSetPassword=true`
   * and clears refresh sessions so the target re-authenticates and is forced
   * through the change-password flow on next login.
   *
   * Refuses to reset another master admin (must demote first), mirroring the
   * disable rule — privileged accounts shouldn't be silently mutable.
   */
  app.post("/master/users/:userId/reset-password", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const { userId } = request.params as { userId: string };
    if (!isUuid(userId)) {
      return reply.status(400).send({ error: "Invalid user id" });
    }
    const parsed = z
      .object({ password: z.string().min(8).max(256).optional() })
      .safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
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
    if (target.isMasterAdmin === true && userId !== ctx.auth.sub) {
      return reply.status(409).send({
        error: "Demote the master admin before resetting their password",
      });
    }
    const password = parsed.data.password ?? generateTempPassword();
    const passwordHash = await bcrypt.hash(password, 12);
    await db()
      .update(users)
      .set({
        passwordHash,
        mustSetPassword: true,
        refreshSessions: null,
        activeRefreshJti: null,
      })
      .where(eq(users.id, userId));
    await recordAudit({
      // Audit row needs an org scope; the user's default org is the most
      // meaningful anchor. Fall back to a synthetic null-org id when neither
      // default nor last-active org exists (rare — newly-minted master admin
      // who never picked an org). The audit_events column is text so an
      // empty string is acceptable for "platform-wide" events.
      orgId: target.defaultOrgId ?? target.lastActiveOrgId ?? "",
      actorUserId: ctx.auth.sub,
      principal: ctx.auth.principal ?? { type: "user" },
      action: "master.user.password_reset",
      targetType: "user",
      targetId: userId,
    });
    return reply.send({
      userId,
      mustSetPassword: true,
      password: parsed.data.password ? undefined : password,
    });
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
   * Master-only: hard user-delete is unsupported by design.
   *
   * Soft-delete is the supported model — call
   * `POST /master/users/:userId/disable` instead. The new schema's audit
   * trail keeps `created_by_user_id` / `granted_by_user_id` /
   * `added_by_user_id` / `invited_by_user_id` as FK RESTRICT on purpose,
   * and `audit_events.actor_user_id` is permanently RESTRICT — none of
   * those should be scrubbed when a user leaves. Soft-delete preserves
   * the references; rendering "[Deleted user]" for surfaces that show
   * creator names is the client-side concern.
   *
   * Returns 410 Gone (not 405) because this method *did* exist
   * pre-migration; the new policy is the answer, not a temporary gap.
   */
  app.delete("/master/users/:userId", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    return reply.status(410).send({
      error:
        "Hard user-delete is not supported. Use POST /master/users/:userId/disable " +
        "to soft-delete; FK RESTRICT on creator/granter columns intentionally " +
        "preserves audit identity.",
    });
  });

  // -------------------------------------------------------------------------
  // Master-admin invites
  // -------------------------------------------------------------------------
  // Parallel to `org_invites`. Accepting a master invite promotes the user to
  // platform-wide master admin (`users.is_master_admin = true`) and triggers
  // the same first-login `mustSetPassword=true` flow. The temp-password path
  // (`POST /master/admins`) remains for cases where invite-link delivery
  // isn't viable.

  /** Master-only: list master invites (defaults to pending; query: ?status=). */
  app.get("/master/invites", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const q = z
      .object({
        status: z
          .enum(["pending", "accepted", "revoked", "expired"])
          .optional(),
      })
      .safeParse(request.query);
    if (!q.success) {
      return reply.status(400).send({ error: q.error.flatten() });
    }
    const wantedStatus = q.data.status ?? "pending";
    const rows = await db()
      .select()
      .from(masterInvites)
      .where(eq(masterInvites.status, wantedStatus))
      .orderBy(desc(masterInvites.createdAt))
      .limit(200);
    return reply.send({
      invites: rows.map((i) => ({
        inviteId: i.id,
        email: i.email,
        status: i.status,
        invitedByUserId: i.invitedByUserId,
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
        acceptedAt: i.acceptedAt ?? null,
      })),
    });
  });

  /**
   * Master-only: create a master-admin invite. Returns the plain token once
   * (caller composes the URL `/invite/master/:token`). Token is stored as
   * SHA-256 hash; the plaintext is not retrievable later — admins regenerate
   * if lost.
   */
  app.post("/master/invites", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const parsed = createMasterInviteBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const email = parsed.data.email.toLowerCase();
    // Block creating an invite for an existing master admin — promote them
    // via POST /master/admins {userId} instead, which is idempotent.
    const existing = await db()
      .select({ id: users.id, isMasterAdmin: users.isMasterAdmin })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing[0]?.isMasterAdmin === true) {
      return reply.status(409).send({
        error: "User is already a master admin",
      });
    }
    const existingPending = await db()
      .select({ id: masterInvites.id })
      .from(masterInvites)
      .where(
        and(
          eq(masterInvites.email, email),
          eq(masterInvites.status, "pending"),
        ),
      )
      .limit(1);
    if (existingPending.length > 0) {
      return reply.status(409).send({
        error: "Invite already pending for this email",
      });
    }
    const { plain, hash } = newMasterInviteToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + MASTER_INVITE_TTL_MS);
    const inviteId = randomUUID();
    await db().insert(masterInvites).values({
      id: inviteId,
      email,
      tokenHash: hash,
      status: "pending",
      invitedByUserId: ctx.auth.sub,
      createdAt: now,
      expiresAt,
    });
    await recordAudit({
      orgId: "",
      actorUserId: ctx.auth.sub,
      principal: ctx.auth.principal ?? { type: "user" },
      action: "master.invite.create",
      targetType: "master_invite",
      targetId: inviteId,
      metadata: { email },
    });
    return reply.send({
      inviteId,
      email,
      token: plain,
      expiresAt,
    });
  });

  /** Master-only: revoke a pending invite. */
  app.delete("/master/invites/:inviteId", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const { inviteId } = request.params as { inviteId: string };
    if (!isUuid(inviteId)) {
      return reply.status(400).send({ error: "Invalid invite id" });
    }
    const result = await db()
      .update(masterInvites)
      .set({ status: "revoked" })
      .where(
        and(eq(masterInvites.id, inviteId), eq(masterInvites.status, "pending")),
      )
      .returning({ id: masterInvites.id });
    if (result.length === 0) {
      return reply
        .status(404)
        .send({ error: "Invite not found or already settled" });
    }
    await recordAudit({
      orgId: "",
      actorUserId: ctx.auth.sub,
      principal: ctx.auth.principal ?? { type: "user" },
      action: "master.invite.revoke",
      targetType: "master_invite",
      targetId: inviteId,
    });
    return reply.status(204).send();
  });

  /**
   * Master-only: rotate a pending invite's token. The old token instantly
   * stops working (its hash is replaced); the new plaintext is returned once
   * and used to compose a fresh URL. TTL resets so the regenerated link
   * isn't immediately stale if the original was near expiry.
   */
  app.post("/master/invites/:inviteId/regenerate", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const { inviteId } = request.params as { inviteId: string };
    if (!isUuid(inviteId)) {
      return reply.status(400).send({ error: "Invalid invite id" });
    }
    const { plain, hash } = newMasterInviteToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + MASTER_INVITE_TTL_MS);
    const result = await db()
      .update(masterInvites)
      .set({ tokenHash: hash, expiresAt, createdAt: now })
      .where(
        and(eq(masterInvites.id, inviteId), eq(masterInvites.status, "pending")),
      )
      .returning({ email: masterInvites.email });
    if (result.length === 0) {
      return reply
        .status(404)
        .send({ error: "Invite not found or already settled" });
    }
    await recordAudit({
      orgId: "",
      actorUserId: ctx.auth.sub,
      principal: ctx.auth.principal ?? { type: "user" },
      action: "master.invite.regenerate",
      targetType: "master_invite",
      targetId: inviteId,
    });
    return reply.send({
      inviteId,
      email: result[0].email,
      token: plain,
      expiresAt,
    });
  });

  /**
   * Public: accept a master-admin invite. Auto-creates the user if needed
   * and sets `mustSetPassword=true` so the invitee is forced through the
   * change-password flow on first login. Always promotes to master admin.
   * Body: `{ token, password }`. The supplied password is the bootstrap;
   * the first-login flow will require them to change it.
   */
  app.post("/auth/accept-master-invite", async (request, reply) => {
    const parsed = z
      .object({
        token: z.string().min(10),
        password: z.string().min(8).max(256),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tokenHash = hashMasterInviteToken(parsed.data.token);
    const inviteRows = await db()
      .select()
      .from(masterInvites)
      .where(
        and(
          eq(masterInvites.tokenHash, tokenHash),
          eq(masterInvites.status, "pending"),
        ),
      )
      .limit(1);
    const invite = inviteRows[0];
    if (!invite) {
      return reply.status(404).send({ error: "Invite not found or expired" });
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      // Mark as expired so listing reflects reality. Best-effort.
      await db()
        .update(masterInvites)
        .set({ status: "expired" })
        .where(eq(masterInvites.id, invite.id));
      return reply.status(404).send({ error: "Invite not found or expired" });
    }
    const email = invite.email.toLowerCase();
    const existing = await db()
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    let userId: string;
    if (existing[0]) {
      userId = existing[0].id;
      // Promote in place. Don't touch their password — they can already log in.
      await db()
        .update(users)
        .set({ isMasterAdmin: true })
        .where(eq(users.id, userId));
    } else {
      const passwordHash = await bcrypt.hash(parsed.data.password, 12);
      userId = randomUUID();
      await db().insert(users).values({
        id: userId,
        email,
        passwordHash,
        // Force first-login change so the bootstrap password (which the
        // inviter may know) is rotated before the account is fully active.
        mustSetPassword: true,
        isMasterAdmin: true,
      });
    }
    await db()
      .update(masterInvites)
      .set({
        status: "accepted",
        acceptedAt: new Date(),
        acceptedByUserId: userId,
      })
      .where(eq(masterInvites.id, invite.id));
    await recordAudit({
      orgId: "",
      actorUserId: userId,
      principal: { type: "user" },
      action: "master.invite.accept",
      targetType: "master_invite",
      targetId: invite.id,
    });
    return reply.send({
      userId,
      email,
      isMasterAdmin: true,
      createdUser: !existing[0],
      mustSetPassword: !existing[0],
    });
  });
}
