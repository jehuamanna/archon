import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  ne,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  requireAuth,
  signAccessToken,
  signRefreshToken,
} from "./auth.js";
import { getDb } from "./pg.js";
import {
  auditEvents,
  notifications,
  organizations,
  orgInvites,
  orgMemberships,
  projectShares,
  spaceMemberships,
  spaces,
  teams,
  users,
  workspaceShares,
  wpnProjects,
  wpnWorkspaces,
} from "./db/schema.js";
import { effectiveRoleInSpace } from "./permission-resolver.js";
import {
  acceptInviteBody,
  createInviteBody,
  createOrgBody,
  createOrgMemberBody,
  declineInviteBody,
  resetMemberPasswordBody,
  setActiveOrgBody,
  setMemberRoleBody,
  updateOrgBody,
  type InviteSpaceGrant,
  type OrgRole,
} from "./org-schemas.js";
import type { OrgInviteNotificationPayload } from "./notification-schemas.js";
import {
  listMembershipsForUser,
  requireOrgAdminOrMaster,
  requireOrgRole,
} from "./org-auth.js";
import { recordAudit } from "./audit.js";
import { buildSessionsAfterAppend } from "./refresh-sessions.js";
import {
  ensureUserHasDefaultOrg,
  getDefaultSpaceIdForOrg,
} from "./org-defaults.js";
import { isUuid } from "./db/legacy-id-map.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newInviteToken(): { plain: string; hash: string } {
  const plain = randomBytes(32).toString("base64url");
  return { plain, hash: hashInviteToken(plain) };
}

function inviteNotificationDedupeKey(inviteId: string): string {
  return `org_invite:${inviteId}`;
}

async function consumeInviteNotification(inviteId: string): Promise<void> {
  await getDb()
    .update(notifications)
    .set({ status: "consumed", consumedAt: new Date() })
    .where(eq(notifications.dedupeKey, inviteNotificationDedupeKey(inviteId)));
}

/**
 * Phase 8: pick the space the caller lands in when their `activeOrgId` changes.
 * Prefers a remembered per-org space (still accessible), falls back to the
 * org's default space.
 */
async function resolveSpaceForOrgEntry(
  user: typeof users.$inferSelect,
  orgId: string,
): Promise<string | null> {
  const remembered = (user.lastActiveSpaceByOrg as Record<string, string> | null)?.[orgId];
  if (remembered && isUuid(remembered)) {
    const direct = await effectiveRoleInSpace(user.id, remembered);
    if (direct) return remembered;
    const orgRows = await getDb()
      .select({ role: orgMemberships.role })
      .from(orgMemberships)
      .where(
        and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, user.id)),
      )
      .limit(1);
    if (orgRows[0]?.role === "admin") return remembered;
  }
  return getDefaultSpaceIdForOrg(orgId);
}

export function registerOrgRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;
  const db = (): ReturnType<typeof getDb> => getDb();

  /** List orgs the caller belongs to plus role + active selection. */
  app.get("/orgs/me", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    let memberships = await listMembershipsForUser(auth.sub);
    if (memberships.length === 0) {
      const userRows = await db()
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, auth.sub))
        .limit(1);
      if (userRows[0]) {
        await ensureUserHasDefaultOrg(auth.sub, userRows[0].email);
      }
      memberships = await listMembershipsForUser(auth.sub);
    }
    const orgIds = memberships.map((m) => m.orgId);
    const orgRows =
      orgIds.length === 0
        ? []
        : await db()
            .select()
            .from(organizations)
            .where(inArray(organizations.id, orgIds));
    const orgsById = new Map(orgRows.map((o) => [o.id, o]));
    const userRows = await db()
      .select({
        defaultOrgId: users.defaultOrgId,
        lockedOrgId: users.lockedOrgId,
      })
      .from(users)
      .where(eq(users.id, auth.sub))
      .limit(1);
    const userDoc = userRows[0];
    const activeOrgId = auth.activeOrgId ?? userDoc?.defaultOrgId ?? null;
    return reply.send({
      orgs: memberships.map((m) => {
        const o = orgsById.get(m.orgId);
        return {
          orgId: m.orgId,
          name: o?.name ?? "(unknown org)",
          slug: o?.slug ?? "",
          role: m.role,
          isDefault: userDoc?.defaultOrgId === m.orgId,
        };
      }),
      activeOrgId,
      defaultOrgId: userDoc?.defaultOrgId ?? null,
      lockedOrgId: userDoc?.lockedOrgId ?? null,
    });
  });

  /** Create a new Org. Caller becomes admin and owner. */
  app.post("/orgs", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const parsed = createOrgBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    if (!isUuid(auth.sub)) {
      return reply.status(401).send({ error: "Invalid session" });
    }
    const callerRows = await db()
      .select({ lockedOrgId: users.lockedOrgId })
      .from(users)
      .where(eq(users.id, auth.sub))
      .limit(1);
    if (callerRows[0]?.lockedOrgId) {
      return reply.status(403).send({
        error: "Organization creation is disabled for invited members",
      });
    }
    const slugFromName = parsed.data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56);
    const slug =
      parsed.data.slug ??
      (slugFromName.length >= 2
        ? slugFromName
        : `org-${randomUUID().slice(0, 8)}`);
    const slugTaken = await db()
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    if (slugTaken.length > 0) {
      return reply.status(409).send({ error: "Slug already in use" });
    }
    const orgId = randomUUID();
    await db().insert(organizations).values({
      id: orgId,
      name: parsed.data.name,
      slug,
      ownerUserId: auth.sub,
      createdAt: new Date(),
    });
    await db().insert(orgMemberships).values({
      orgId,
      userId: auth.sub,
      role: "admin" as OrgRole,
      joinedAt: new Date(),
    });
    return reply.send({ orgId, name: parsed.data.name, slug });
  });

  /** Rename an Org and/or change its slug. Gated by org-admin OR master-admin. */
  app.patch("/orgs/:orgId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { orgId } = request.params as { orgId: string };
    if (!isUuid(orgId)) {
      return reply.status(404).send({ error: "Organization not found" });
    }
    const ctx = await requireOrgAdminOrMaster(request, reply, auth, orgId);
    if (!ctx) return;
    const parsed = updateOrgBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const patch: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.slug !== undefined) {
      const existing = await db()
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(
            eq(organizations.slug, parsed.data.slug),
            ne(organizations.id, orgId),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        return reply.status(409).send({ error: "Slug already in use" });
      }
      patch.slug = parsed.data.slug;
    }
    if (Object.keys(patch).length === 0) {
      return reply.status(400).send({ error: "No fields to update" });
    }
    const result = await db()
      .update(organizations)
      .set(patch)
      .where(eq(organizations.id, orgId))
      .returning({ id: organizations.id });
    if (result.length === 0) {
      return reply.status(404).send({ error: "Organization not found" });
    }
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "org.update",
      targetType: "org",
      targetId: orgId,
      metadata: patch,
    });
    return reply.status(204).send();
  });

  /** Delete an Org with cascading checks + cleanup. */
  app.delete("/orgs/:orgId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { orgId } = request.params as { orgId: string };
    if (!isUuid(orgId)) {
      return reply.status(404).send({ error: "Organization not found" });
    }
    const ctx = await requireOrgAdminOrMaster(request, reply, auth, orgId);
    if (!ctx) return;
    const orgRows = await db()
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    const org = orgRows[0];
    if (!org) {
      return reply.status(404).send({ error: "Organization not found" });
    }
    const nonDefault =
      (
        await db()
          .select({ n: count() })
          .from(spaces)
          .where(and(eq(spaces.orgId, orgId), ne(spaces.kind, "default")))
      )[0]?.n ?? 0;
    if (nonDefault > 0) {
      return reply.status(409).send({
        error: "Organization still has spaces; delete them first",
      });
    }
    const wsCount =
      (
        await db()
          .select({ n: count() })
          .from(wpnWorkspaces)
          .where(eq(wpnWorkspaces.orgId, orgId))
      )[0]?.n ?? 0;
    if (wsCount > 0) {
      return reply.status(409).send({
        error: "Organization still has workspaces; move or delete them first",
      });
    }
    const teamCount =
      (
        await db()
          .select({ n: count() })
          .from(teams)
          .where(eq(teams.orgId, orgId))
      )[0]?.n ?? 0;
    if (teamCount > 0) {
      return reply
        .status(409)
        .send({ error: "Organization still has teams; delete them first" });
    }
    const otherMembers =
      (
        await db()
          .select({ n: count() })
          .from(orgMemberships)
          .where(
            and(
              eq(orgMemberships.orgId, orgId),
              ne(orgMemberships.userId, auth.sub),
            ),
          )
      )[0]?.n ?? 0;
    if (otherMembers > 0) {
      return reply.status(409).send({
        error: "Organization still has other members; remove them first",
      });
    }
    const defaultSpaceRows = await db()
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.orgId, orgId), eq(spaces.kind, "default")));
    const defaultSpaceIds = defaultSpaceRows.map((s) => s.id);
    if (defaultSpaceIds.length > 0) {
      await db()
        .delete(spaceMemberships)
        .where(inArray(spaceMemberships.spaceId, defaultSpaceIds));
      await db()
        .delete(spaces)
        .where(and(eq(spaces.orgId, orgId), eq(spaces.kind, "default")));
    }
    await db().delete(orgMemberships).where(eq(orgMemberships.orgId, orgId));
    await db().delete(orgInvites).where(eq(orgInvites.orgId, orgId));
    // Record the deletion before scrubbing audit history.
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "org.delete",
      targetType: "org",
      targetId: orgId,
      metadata: { name: org.name, slug: org.slug },
    });
    await db()
      .delete(auditEvents)
      .where(
        and(eq(auditEvents.orgId, orgId), ne(auditEvents.action, "org.delete")),
      );
    await db().delete(organizations).where(eq(organizations.id, orgId));
    // Clear dangling user pointers.
    await db()
      .update(users)
      .set({ defaultOrgId: null })
      .where(eq(users.defaultOrgId, orgId));
    await db()
      .update(users)
      .set({ lastActiveOrgId: null, lastActiveSpaceId: null })
      .where(eq(users.lastActiveOrgId, orgId));
    await db()
      .update(users)
      .set({ lockedOrgId: null })
      .where(eq(users.lockedOrgId, orgId));
    return reply.status(204).send();
  });

  /** Switch active org. Mints a new access token with both org + space claims. */
  app.post("/orgs/active", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const parsed = setActiveOrgBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const ctx = await requireOrgRole(
      request,
      reply,
      auth,
      parsed.data.orgId,
      "member",
    );
    if (!ctx) return;
    const userRows = await db()
      .select()
      .from(users)
      .where(eq(users.id, auth.sub))
      .limit(1);
    const user = userRows[0];
    if (!user) {
      return reply.status(404).send({ error: "User not found" });
    }
    const nextSpaceId = await resolveSpaceForOrgEntry(user, parsed.data.orgId);
    const lastActiveSpaceByOrg = {
      ...((user.lastActiveSpaceByOrg as Record<string, string> | null) ?? {}),
    };
    if (nextSpaceId) {
      lastActiveSpaceByOrg[parsed.data.orgId] = nextSpaceId;
    }
    await db()
      .update(users)
      .set({
        lastActiveOrgId: parsed.data.orgId,
        lastActiveSpaceId: nextSpaceId ?? null,
        lastActiveSpaceByOrg,
      })
      .where(eq(users.id, user.id));
    const token = signAccessToken(jwtSecret, {
      sub: auth.sub,
      email: auth.email,
      activeOrgId: parsed.data.orgId,
      ...(nextSpaceId ? { activeSpaceId: nextSpaceId } : {}),
    });
    return reply.send({
      token,
      activeOrgId: parsed.data.orgId,
      activeSpaceId: nextSpaceId,
    });
  });

  /** Admin-only: list invites for an Org. */
  app.get("/orgs/:orgId/invites", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { orgId } = request.params as { orgId: string };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) return;
    const list = await db()
      .select()
      .from(orgInvites)
      .where(eq(orgInvites.orgId, orgId))
      .orderBy(desc(orgInvites.createdAt))
      .limit(200);
    return reply.send({
      invites: list.map((i) => ({
        inviteId: i.id,
        email: i.email,
        role: i.role,
        status: i.status,
        invitedByUserId: i.invitedByUserId,
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
        acceptedAt: i.acceptedAt ?? null,
        declinedAt: i.declinedAt ?? null,
        spaceGrants: i.spaceGrants ?? [],
      })),
    });
  });

  /** Admin-only: create an invite. */
  app.post("/orgs/:orgId/invites", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { orgId } = request.params as { orgId: string };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) return;
    const parsed = createInviteBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const email = parsed.data.email.toLowerCase();
    const spaceGrants: InviteSpaceGrant[] = parsed.data.spaceGrants ?? [];
    for (const grant of spaceGrants) {
      if (!isUuid(grant.spaceId)) {
        return reply
          .status(400)
          .send({ error: `Invalid space id: ${grant.spaceId}` });
      }
    }
    const spaceDocs = spaceGrants.length
      ? await db()
          .select()
          .from(spaces)
          .where(inArray(spaces.id, spaceGrants.map((g) => g.spaceId)))
      : [];
    for (const grant of spaceGrants) {
      const doc = spaceDocs.find((s) => s.id === grant.spaceId);
      if (!doc || doc.orgId !== orgId) {
        return reply
          .status(400)
          .send({ error: `Space ${grant.spaceId} does not belong to this org` });
      }
    }
    const existingPending = await db()
      .select({ id: orgInvites.id })
      .from(orgInvites)
      .where(
        and(
          eq(orgInvites.orgId, orgId),
          eq(orgInvites.email, email),
          eq(orgInvites.status, "pending"),
        ),
      )
      .limit(1);
    if (existingPending.length > 0) {
      return reply
        .status(409)
        .send({ error: "Invite already pending for this email" });
    }
    const { plain, hash } = newInviteToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    const inviteId = randomUUID();
    await db().insert(orgInvites).values({
      id: inviteId,
      orgId,
      email,
      role: parsed.data.role,
      tokenHash: hash,
      status: "pending",
      invitedByUserId: auth.sub,
      createdAt: now,
      expiresAt,
      spaceGrants,
    });
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "org.invite.create",
      targetType: "org_invite",
      targetId: inviteId,
      metadata: { email, role: parsed.data.role, spaceGrants: spaceGrants.length },
    });

    // Phase 8: notify if invitee already has an account.
    const existingUserRows = await db()
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    const existingUser = existingUserRows[0];
    if (existingUser) {
      const orgRow = (
        await db()
          .select()
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1)
      )[0];
      const inviterRow = (
        await db()
          .select({ email: users.email, displayName: users.displayName })
          .from(users)
          .where(eq(users.id, auth.sub))
          .limit(1)
      )[0];
      const spaceNameById = new Map(spaceDocs.map((s) => [s.id, s.name]));
      const payload: OrgInviteNotificationPayload = {
        inviteId,
        orgId,
        orgName: orgRow?.name ?? "(unknown org)",
        inviterUserId: auth.sub,
        inviterDisplayName:
          inviterRow?.displayName ?? inviterRow?.email ?? "(someone)",
        inviterEmail: inviterRow?.email ?? "",
        role: parsed.data.role,
        spaceGrants: spaceGrants.map((g) => ({
          spaceId: g.spaceId,
          spaceName: spaceNameById.get(g.spaceId) ?? "(unknown space)",
          role: g.role,
        })),
        expiresAt: expiresAt.toISOString(),
      };
      // Manual dedupe: ON CONFLICT can't target a partial unique index in
      // PG (notifications_dedupe_key_unique is `WHERE dedupe_key IS NOT
      // NULL`). Pre-check + insert is fine here because invites are admin-
      // gated low-frequency.
      const dedupeKey = inviteNotificationDedupeKey(inviteId);
      const existingNotif = await db()
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.dedupeKey, dedupeKey))
        .limit(1);
      if (existingNotif.length === 0) {
        const notificationId = randomUUID();
        await db().insert(notifications).values({
          id: notificationId,
          userId: existingUser.id,
          type: "org_invite",
          payload,
          link: `/invite/${plain}`,
          status: "unread",
          createdAt: now,
          dedupeKey,
        });
      }
    }

    return reply.send({
      inviteId,
      email,
      role: parsed.data.role,
      token: plain,
      expiresAt,
      spaceGrants,
    });
  });

  /** Admin-only: revoke an invite. */
  app.delete("/orgs/:orgId/invites/:inviteId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { orgId, inviteId } = request.params as {
      orgId: string;
      inviteId: string;
    };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) return;
    if (!isUuid(inviteId)) {
      return reply.status(400).send({ error: "Invalid invite id" });
    }
    const result = await db()
      .update(orgInvites)
      .set({ status: "revoked" })
      .where(
        and(
          eq(orgInvites.id, inviteId),
          eq(orgInvites.orgId, orgId),
          eq(orgInvites.status, "pending"),
        ),
      )
      .returning({ id: orgInvites.id });
    if (result.length === 0) {
      return reply
        .status(404)
        .send({ error: "Invite not found or already settled" });
    }
    await consumeInviteNotification(inviteId);
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "org.invite.revoke",
      targetType: "org_invite",
      targetId: inviteId,
    });
    return reply.status(204).send();
  });

  /** Public: accept an invite token. */
  app.post("/auth/accept-invite", async (request, reply) => {
    const parsed = acceptInviteBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tokenHash = hashInviteToken(parsed.data.token);
    const previewRows = await db()
      .select()
      .from(orgInvites)
      .where(
        and(eq(orgInvites.tokenHash, tokenHash), eq(orgInvites.status, "pending")),
      )
      .limit(1);
    const invitePreview = previewRows[0];
    if (!invitePreview || invitePreview.expiresAt.getTime() < Date.now()) {
      return reply.status(404).send({ error: "Invite not found or expired" });
    }
    const email = invitePreview.email.toLowerCase();
    let userRow = (
      await db().select().from(users).where(eq(users.email, email)).limit(1)
    )[0];
    let createdUser = false;
    if (!userRow) {
      if (!parsed.data.password) {
        return reply.status(400).send({
          error: "Password required for new account",
          needsPassword: true,
        });
      }
      const passwordHash = await bcrypt.hash(parsed.data.password, 12);
      const newUserId = randomUUID();
      await db().insert(users).values({
        id: newUserId,
        email,
        passwordHash,
        displayName: parsed.data.displayName ?? null,
        mustSetPassword: false,
        lockedOrgId: invitePreview.orgId,
      });
      userRow = (
        await db().select().from(users).where(eq(users.id, newUserId)).limit(1)
      )[0]!;
      createdUser = true;
    } else if (userRow.mustSetPassword === true) {
      if (!parsed.data.password) {
        return reply.status(400).send({
          error: "Password required to finish account setup",
          needsPassword: true,
        });
      }
      const passwordHash = await bcrypt.hash(parsed.data.password, 12);
      const set: Record<string, unknown> = {
        passwordHash,
        mustSetPassword: false,
      };
      if (parsed.data.displayName) set.displayName = parsed.data.displayName;
      await db().update(users).set(set).where(eq(users.id, userRow.id));
      userRow = (
        await db().select().from(users).where(eq(users.id, userRow.id)).limit(1)
      )[0]!;
    }
    // Atomic transition pending → accepted.
    const claimed = await db()
      .update(orgInvites)
      .set({
        status: "accepted",
        acceptedAt: new Date(),
        acceptedByUserId: userRow.id,
      })
      .where(
        and(
          eq(orgInvites.id, invitePreview.id),
          eq(orgInvites.status, "pending"),
        ),
      )
      .returning();
    const invite = claimed[0];
    if (!invite) {
      return reply.status(409).send({ error: "Invite is no longer pending" });
    }
    await db()
      .insert(orgMemberships)
      .values({
        orgId: invite.orgId,
        userId: userRow.id,
        role: invite.role as OrgRole,
        joinedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [orgMemberships.orgId, orgMemberships.userId],
      });
    const grants = (invite.spaceGrants ?? []) as InviteSpaceGrant[];
    if (grants.length > 0) {
      for (const grant of grants) {
        await db()
          .insert(spaceMemberships)
          .values({
            spaceId: grant.spaceId,
            userId: userRow.id,
            role: grant.role,
            addedByUserId: invite.invitedByUserId,
            joinedAt: new Date(),
          })
          .onConflictDoNothing({
            target: [spaceMemberships.spaceId, spaceMemberships.userId],
          });
        await recordAudit({
          orgId: invite.orgId,
          actorUserId: userRow.id,
          action: "space.member.add",
          targetType: "space_membership",
          targetId: grant.spaceId,
          metadata: {
            userId: userRow.id,
            role: grant.role,
            viaInvite: invite.id,
          },
        });
      }
    }
    await consumeInviteNotification(invite.id);
    await recordAudit({
      orgId: invite.orgId,
      actorUserId: userRow.id,
      action: "org.invite.accept",
      targetType: "org_invite",
      targetId: invite.id,
      metadata: { email, role: invite.role, spaceGrants: grants.length },
    });
    if (createdUser || !userRow.defaultOrgId) {
      await db()
        .update(users)
        .set({ defaultOrgId: invite.orgId })
        .where(and(eq(users.id, userRow.id), sql`${users.defaultOrgId} IS NULL`));
    }
    // Land the invitee in a readable space.
    const orgDefaultSpaceId = await getDefaultSpaceIdForOrg(invite.orgId);
    let inviteSpaceId: string | null = null;
    if (grants.length > 0) {
      const grantOnDefault = orgDefaultSpaceId
        ? grants.find((g) => g.spaceId === orgDefaultSpaceId)
        : undefined;
      inviteSpaceId = (grantOnDefault ?? grants[0]).spaceId;
    } else {
      inviteSpaceId = orgDefaultSpaceId;
    }
    const lastActiveSpaceByOrg = {
      ...((userRow.lastActiveSpaceByOrg as Record<string, string> | null) ?? {}),
    };
    if (inviteSpaceId) lastActiveSpaceByOrg[invite.orgId] = inviteSpaceId;
    await db()
      .update(users)
      .set({
        lastActiveOrgId: invite.orgId,
        lastActiveSpaceId: inviteSpaceId ?? null,
        lastActiveSpaceByOrg,
      })
      .where(eq(users.id, userRow.id));
    const tokenPayload = {
      sub: userRow.id,
      email,
      activeOrgId: invite.orgId,
      ...(inviteSpaceId ? { activeSpaceId: inviteSpaceId } : {}),
    };
    const jti = randomUUID();
    const token = signAccessToken(jwtSecret, tokenPayload);
    const refreshToken = signRefreshToken(
      jwtSecret,
      { sub: userRow.id, email },
      jti,
    );
    const nextSessions = buildSessionsAfterAppend(
      {
        refreshSessions: userRow.refreshSessions,
        activeRefreshJti: userRow.activeRefreshJti,
      },
      jti,
    );
    await db()
      .update(users)
      .set({
        refreshSessions: nextSessions.map((s) => ({
          jti: s.jti,
          createdAt: s.createdAt.toISOString(),
        })),
        activeRefreshJti: null,
      })
      .where(eq(users.id, userRow.id));
    return reply.send({
      token,
      refreshToken,
      userId: userRow.id,
      orgId: invite.orgId,
      role: invite.role,
      createdUser,
      spaceGrants: grants,
    });
  });

  /** Public: decline an invite token. Idempotent. */
  app.post("/auth/decline-invite", async (request, reply) => {
    const parsed = declineInviteBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tokenHash = hashInviteToken(parsed.data.token);
    const claimed = await db()
      .update(orgInvites)
      .set({ status: "declined", declinedAt: new Date() })
      .where(
        and(
          eq(orgInvites.tokenHash, tokenHash),
          eq(orgInvites.status, "pending"),
        ),
      )
      .returning();
    const invite = claimed[0];
    if (!invite) {
      return reply
        .status(404)
        .send({ error: "Invite not found or already settled" });
    }
    await consumeInviteNotification(invite.id);
    await recordAudit({
      orgId: invite.orgId,
      actorUserId: invite.invitedByUserId,
      action: "org.invite.decline",
      targetType: "org_invite",
      targetId: invite.id,
      metadata: { email: invite.email },
    });
    return reply.send({ ok: true });
  });

  /** Admin-only: list members of an Org. */
  app.get("/orgs/:orgId/members", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { orgId } = request.params as { orgId: string };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) return;
    const memberships = await db()
      .select()
      .from(orgMemberships)
      .where(eq(orgMemberships.orgId, orgId));
    const userIds = memberships.map((m) => m.userId);
    const userDocs = userIds.length
      ? await db()
          .select({
            id: users.id,
            email: users.email,
            displayName: users.displayName,
            mustSetPassword: users.mustSetPassword,
          })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];
    const usersById = new Map(userDocs.map((u) => [u.id, u]));
    return reply.send({
      members: memberships.map((m) => {
        const u = usersById.get(m.userId);
        return {
          userId: m.userId,
          email: u?.email ?? "(unknown)",
          displayName: u?.displayName ?? null,
          role: m.role,
          mustSetPassword: u?.mustSetPassword === true,
          joinedAt: m.joinedAt,
        };
      }),
    });
  });

  /** Admin-only: change member role. Last admin cannot demote themselves. */
  app.patch("/orgs/:orgId/members/:userId/role", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { orgId, userId } = request.params as {
      orgId: string;
      userId: string;
    };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) return;
    const parsed = setMemberRoleBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const targetRows = await db()
      .select()
      .from(orgMemberships)
      .where(
        and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)),
      )
      .limit(1);
    const target = targetRows[0];
    if (!target) {
      return reply.status(404).send({ error: "Member not found" });
    }
    if (
      target.role === "admin" &&
      parsed.data.role === "member" &&
      target.userId === auth.sub
    ) {
      const adminCount =
        (
          await db()
            .select({ n: count() })
            .from(orgMemberships)
            .where(
              and(
                eq(orgMemberships.orgId, orgId),
                eq(orgMemberships.role, "admin"),
              ),
            )
        )[0]?.n ?? 0;
      if (adminCount <= 1) {
        return reply
          .status(400)
          .send({ error: "Cannot demote the last admin of the org" });
      }
    }
    await db()
      .update(orgMemberships)
      .set({ role: parsed.data.role })
      .where(
        and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)),
      );
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "org.member.role_change",
      targetType: "org_membership",
      targetId: userId,
      metadata: { from: target.role, to: parsed.data.role },
    });
    return reply.status(204).send();
  });

  /** Admin-only: remove a member. Cascades workspace + project shares. */
  app.delete("/orgs/:orgId/members/:userId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { orgId, userId } = request.params as {
      orgId: string;
      userId: string;
    };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) return;
    const targetRows = await db()
      .select()
      .from(orgMemberships)
      .where(
        and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)),
      )
      .limit(1);
    const target = targetRows[0];
    if (!target) {
      return reply.status(404).send({ error: "Member not found" });
    }
    if (target.role === "admin") {
      const adminCount =
        (
          await db()
            .select({ n: count() })
            .from(orgMemberships)
            .where(
              and(
                eq(orgMemberships.orgId, orgId),
                eq(orgMemberships.role, "admin"),
              ),
            )
        )[0]?.n ?? 0;
      if (adminCount <= 1) {
        return reply
          .status(400)
          .send({ error: "Cannot remove the last admin of the org" });
      }
    }
    await db()
      .delete(orgMemberships)
      .where(
        and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)),
      );
    const wsIds = (
      await db()
        .select({ id: wpnWorkspaces.id })
        .from(wpnWorkspaces)
        .where(eq(wpnWorkspaces.orgId, orgId))
    ).map((w) => w.id);
    if (wsIds.length > 0) {
      await db()
        .delete(workspaceShares)
        .where(
          and(
            eq(workspaceShares.userId, userId),
            inArray(workspaceShares.workspaceId, wsIds),
          ),
        );
    }
    const projIds = (
      await db()
        .select({ id: wpnProjects.id })
        .from(wpnProjects)
        .where(eq(wpnProjects.orgId, orgId))
    ).map((p) => p.id);
    if (projIds.length > 0) {
      await db()
        .delete(projectShares)
        .where(
          and(
            eq(projectShares.userId, userId),
            inArray(projectShares.projectId, projIds),
          ),
        );
    }
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "org.member.remove",
      targetType: "org_membership",
      targetId: userId,
      metadata: { role: target.role },
    });
    return reply.status(204).send();
  });

  /** Admin-only: create a new user + org membership in one call. */
  app.post("/orgs/:orgId/members/create", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { orgId } = request.params as { orgId: string };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) return;
    const parsed = createOrgMemberBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const email = parsed.data.email.toLowerCase();
    const existing = await db()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing.length > 0) {
      return reply.status(409).send({ error: "Email already registered" });
    }
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const userId = randomUUID();
    await db().insert(users).values({
      id: userId,
      email,
      passwordHash,
      mustSetPassword: true,
      lockedOrgId: orgId,
      defaultOrgId: orgId,
    });
    await db().insert(orgMemberships).values({
      orgId,
      userId,
      role: parsed.data.role,
      joinedAt: new Date(),
    });
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "org.member.create_with_password",
      targetType: "org_membership",
      targetId: userId,
      metadata: { email, role: parsed.data.role },
    });
    return reply.send({
      userId,
      email,
      role: parsed.data.role,
      mustSetPassword: true,
    });
  });

  /** Admin-only: reset a member's password. */
  app.post(
    "/orgs/:orgId/members/:userId/reset-password",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { orgId, userId } = request.params as {
        orgId: string;
        userId: string;
      };
      const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
      if (!ctx) return;
      const parsed = resetMemberPasswordBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const membership = await db()
        .select({ id: orgMemberships.userId })
        .from(orgMemberships)
        .where(
          and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)),
        )
        .limit(1);
      if (membership.length === 0) {
        return reply.status(404).send({ error: "Member not found in this org" });
      }
      if (!isUuid(userId)) {
        return reply.status(400).send({ error: "Invalid user id" });
      }
      const passwordHash = await bcrypt.hash(parsed.data.password, 12);
      const result = await db()
        .update(users)
        .set({
          passwordHash,
          mustSetPassword: true,
          refreshSessions: null,
          activeRefreshJti: null,
        })
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      if (result.length === 0) {
        return reply.status(404).send({ error: "User not found" });
      }
      await recordAudit({
        orgId,
        actorUserId: auth.sub,
        principal: auth.principal ?? { type: "user" },
        action: "org.member.password_reset",
        targetType: "org_membership",
        targetId: userId,
      });
      return reply.send({ userId, mustSetPassword: true });
    },
  );

  /** Public: validate an invite token without consuming it. */
  app.get("/auth/invites/preview", async (request, reply) => {
    const q = z
      .object({ token: z.string().min(10) })
      .safeParse(request.query);
    if (!q.success) {
      return reply.status(400).send({ error: q.error.flatten() });
    }
    const tokenHash = hashInviteToken(q.data.token);
    const inviteRows = await db()
      .select()
      .from(orgInvites)
      .where(
        and(eq(orgInvites.tokenHash, tokenHash), eq(orgInvites.status, "pending")),
      )
      .limit(1);
    const invite = inviteRows[0];
    if (!invite || invite.expiresAt.getTime() < Date.now()) {
      return reply.status(404).send({ error: "Invite not found or expired" });
    }
    const orgRow = (
      await db()
        .select()
        .from(organizations)
        .where(eq(organizations.id, invite.orgId))
        .limit(1)
    )[0];
    const userRow = (
      await db()
        .select()
        .from(users)
        .where(eq(users.email, invite.email))
        .limit(1)
    )[0];
    const inviterRow = (
      await db()
        .select({ email: users.email, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, invite.invitedByUserId))
        .limit(1)
    )[0];
    const grants = (invite.spaceGrants ?? []) as InviteSpaceGrant[];
    const spaceDocs = grants.length
      ? await db()
          .select({ id: spaces.id, name: spaces.name })
          .from(spaces)
          .where(inArray(spaces.id, grants.map((g) => g.spaceId)))
      : [];
    const spaceNameById = new Map(spaceDocs.map((s) => [s.id, s.name]));
    return reply.send({
      orgId: invite.orgId,
      orgName: orgRow?.name ?? "(unknown org)",
      orgSlug: orgRow?.slug ?? "",
      email: invite.email,
      role: invite.role,
      needsPassword: !userRow || userRow.mustSetPassword === true,
      expiresAt: invite.expiresAt,
      inviter: {
        userId: invite.invitedByUserId,
        displayName: inviterRow?.displayName ?? inviterRow?.email ?? "(someone)",
        email: inviterRow?.email ?? "",
      },
      spaceGrants: grants.map((g) => ({
        spaceId: g.spaceId,
        spaceName: spaceNameById.get(g.spaceId) ?? "(unknown space)",
        role: g.role,
      })),
    });
  });

  // Suppress unused-import warnings for items kept for future helpers.
  void asc;
  void gt;
  void desc;
}
