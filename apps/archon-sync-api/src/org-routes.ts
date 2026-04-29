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
import { requireMasterAdmin } from "./admin-auth.js";
import { getDb } from "./pg.js";
import {
  auditEvents,
  departments,
  notifications,
  organizations,
  orgInvites,
  orgMemberships,
  projects,
  teamMemberships,
  teamProjects,
  teams,
  users,
} from "./db/schema.js";
import { effectiveRoleInProject } from "./permission-resolver.js";
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
  type InviteTeamGrant,
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
  ensureDefaultTeamForOrg,
  ensureUserHasDefaultOrg,
  getDefaultTeamIdForOrg,
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
 * Pick the team the caller lands on when their `activeOrgId` changes.
 * Prefers `lastActiveTeamByOrg[orgId]` if the team still exists in that org
 * and the user is a member of one of its teams; otherwise falls back to the
 * org's default team. Org admins always get a valid team because
 * `ensureDefaultTeamForOrg` runs at org creation.
 */
async function resolveTeamForOrgEntry(
  user: typeof users.$inferSelect,
  orgId: string,
): Promise<string | null> {
  const remembered = (user.lastActiveTeamByOrg as Record<string, string> | null)?.[orgId];
  if (remembered && isUuid(remembered)) {
    const teamRows = await getDb()
      .select({ orgId: teams.orgId })
      .from(teams)
      .where(eq(teams.id, remembered))
      .limit(1);
    if (teamRows[0]?.orgId === orgId) return remembered;
  }
  return getDefaultTeamIdForOrg(orgId);
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
    const userRows = await db()
      .select({
        email: users.email,
        isMasterAdmin: users.isMasterAdmin,
        defaultOrgId: users.defaultOrgId,
        lockedOrgId: users.lockedOrgId,
      })
      .from(users)
      .where(eq(users.id, auth.sub))
      .limit(1);
    const isMaster = userRows[0]?.isMasterAdmin === true;
    if (memberships.length === 0 && userRows[0] && !isMaster) {
      // Non-master with zero memberships: bootstrap their personal org.
      // Master admins are platform-wide and shouldn't get an auto-personal
      // org sneaked in via /orgs/me — they manage orgs from the master
      // console (`/master/orgs`).
      await ensureUserHasDefaultOrg(auth.sub, userRows[0].email);
      memberships = await listMembershipsForUser(auth.sub);
    }
    if (isMaster) {
      // Heal orgs the master created before they were auto-enrolled (or
      // that lost their membership for any reason): if they own the org
      // but aren't a member, enroll them as admin and scaffold the
      // default team. Idempotent, so harmless on repeat calls.
      const ownedRows = await db()
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.ownerUserId, auth.sub));
      const memberOrgIds = new Set(memberships.map((m) => m.orgId));
      const orphans = ownedRows.filter((o) => !memberOrgIds.has(o.id));
      if (orphans.length > 0) {
        for (const o of orphans) {
          await db()
            .insert(orgMemberships)
            .values({
              orgId: o.id,
              userId: auth.sub,
              role: "admin",
              joinedAt: new Date(),
            })
            .onConflictDoNothing({
              target: [orgMemberships.orgId, orgMemberships.userId],
            });
          await ensureDefaultTeamForOrg(o.id, auth.sub);
        }
        memberships = await listMembershipsForUser(auth.sub);
      }
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

  /**
   * Master-only: create a new organization. Creator (the master admin)
   * becomes the org's first admin member and the default
   * department/team are scaffolded so they can immediately switch in
   * via the org-switcher. They can later transfer day-to-day operation
   * by inviting an org-admin via `POST /master/orgs/:orgId/admins` (and
   * demoting themselves through the same surface if desired).
   */
  app.post("/orgs", async (request, reply) => {
    const ctx = await requireMasterAdmin(request, reply, jwtSecret);
    if (!ctx) return;
    const parsed = createOrgBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
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
      ownerUserId: ctx.auth.sub,
      createdAt: new Date(),
    });
    // Enroll the creator as org admin and scaffold the default
    // department + team so they have a usable workspace on first switch.
    // Without this, /orgs/me returns [] and /orgs/active 404s on the org
    // they just created.
    await db()
      .insert(orgMemberships)
      .values({
        orgId,
        userId: ctx.auth.sub,
        role: "admin",
        joinedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [orgMemberships.orgId, orgMemberships.userId],
      });
    await ensureDefaultTeamForOrg(orgId, ctx.auth.sub);
    await recordAudit({
      orgId,
      actorUserId: ctx.auth.sub,
      principal: ctx.auth.principal ?? { type: "user" },
      action: "org.create",
      targetType: "organization",
      targetId: orgId,
      metadata: { name: parsed.data.name, slug },
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

  /**
   * Delete an Org. Refuse while content still exists — projects, teams, and
   * non-default departments must be moved or deleted first. The "General"
   * department auto-created at org bootstrap is removed as part of cleanup.
   */
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
    const projCount =
      (
        await db()
          .select({ n: count() })
          .from(projects)
          .where(eq(projects.orgId, orgId))
      )[0]?.n ?? 0;
    if (projCount > 0) {
      return reply
        .status(409)
        .send({ error: "Organization still has projects; delete them first" });
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
    const nonDefaultDeptCount =
      (
        await db()
          .select({ n: count() })
          .from(departments)
          .where(and(eq(departments.orgId, orgId), ne(departments.name, "General")))
      )[0]?.n ?? 0;
    if (nonDefaultDeptCount > 0) {
      return reply.status(409).send({
        error: "Organization still has departments; delete them first",
      });
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
    // Clean up the bootstrap "General" department (if any) along with its
    // memberships. FK is RESTRICT teams→departments, but we just verified
    // there are no teams left.
    await db()
      .delete(departments)
      .where(and(eq(departments.orgId, orgId), eq(departments.name, "General")));
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
      .set({ lastActiveOrgId: null, lastActiveTeamId: null })
      .where(eq(users.lastActiveOrgId, orgId));
    await db()
      .update(users)
      .set({ lockedOrgId: null })
      .where(eq(users.lockedOrgId, orgId));
    return reply.status(204).send();
  });

  /** Switch active org. Mints a new access token with both org + team claims. */
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
    const nextTeamId = await resolveTeamForOrgEntry(user, parsed.data.orgId);
    const lastActiveTeamByOrg = {
      ...((user.lastActiveTeamByOrg as Record<string, string> | null) ?? {}),
    };
    if (nextTeamId) {
      lastActiveTeamByOrg[parsed.data.orgId] = nextTeamId;
    }
    await db()
      .update(users)
      .set({
        lastActiveOrgId: parsed.data.orgId,
        lastActiveTeamId: nextTeamId ?? null,
        lastActiveTeamByOrg,
      })
      .where(eq(users.id, user.id));
    const token = signAccessToken(jwtSecret, {
      sub: auth.sub,
      email: auth.email,
      activeOrgId: parsed.data.orgId,
      ...(nextTeamId ? { activeTeamId: nextTeamId } : {}),
    });
    return reply.send({
      token,
      activeOrgId: parsed.data.orgId,
      activeTeamId: nextTeamId,
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
        teamGrants: i.teamGrants ?? [],
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
    const teamGrants: InviteTeamGrant[] = parsed.data.teamGrants ?? [];
    for (const grant of teamGrants) {
      if (!isUuid(grant.teamId)) {
        return reply
          .status(400)
          .send({ error: `Invalid team id: ${grant.teamId}` });
      }
    }
    const teamDocs = teamGrants.length
      ? await db()
          .select()
          .from(teams)
          .where(inArray(teams.id, teamGrants.map((g) => g.teamId)))
      : [];
    for (const grant of teamGrants) {
      const doc = teamDocs.find((t) => t.id === grant.teamId);
      if (!doc || doc.orgId !== orgId) {
        return reply
          .status(400)
          .send({ error: `Team ${grant.teamId} does not belong to this org` });
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
      teamGrants,
    });
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "org.invite.create",
      targetType: "org_invite",
      targetId: inviteId,
      metadata: { email, role: parsed.data.role, teamGrants: teamGrants.length },
    });

    // Notify if invitee already has an account.
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
      const teamNameById = new Map(teamDocs.map((t) => [t.id, t.name]));
      const payload: OrgInviteNotificationPayload = {
        inviteId,
        orgId,
        orgName: orgRow?.name ?? "(unknown org)",
        inviterUserId: auth.sub,
        inviterDisplayName:
          inviterRow?.displayName ?? inviterRow?.email ?? "(someone)",
        inviterEmail: inviterRow?.email ?? "",
        role: parsed.data.role,
        teamGrants: teamGrants.map((g) => ({
          teamId: g.teamId,
          teamName: teamNameById.get(g.teamId) ?? "(unknown team)",
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
      teamGrants,
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

  /**
   * Admin-only: rotate a pending invite's token and reset its TTL. Use when
   * the original link was lost or shared accidentally — old token instantly
   * stops working, new plaintext is returned once for hand-off. Status,
   * email, role, and team grants are unchanged.
   */
  app.post(
    "/orgs/:orgId/invites/:inviteId/regenerate",
    async (request, reply) => {
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
      const { plain, hash } = newInviteToken();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
      const result = await db()
        .update(orgInvites)
        .set({ tokenHash: hash, expiresAt, createdAt: now })
        .where(
          and(
            eq(orgInvites.id, inviteId),
            eq(orgInvites.orgId, orgId),
            eq(orgInvites.status, "pending"),
          ),
        )
        .returning({
          id: orgInvites.id,
          email: orgInvites.email,
          role: orgInvites.role,
        });
      if (result.length === 0) {
        return reply
          .status(404)
          .send({ error: "Invite not found or already settled" });
      }
      await recordAudit({
        orgId,
        actorUserId: auth.sub,
        principal: auth.principal ?? { type: "user" },
        action: "org.invite.regenerate",
        targetType: "org_invite",
        targetId: inviteId,
      });
      return reply.send({
        inviteId,
        email: result[0].email,
        role: result[0].role,
        token: plain,
        expiresAt,
      });
    },
  );

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
    const grants = (invite.teamGrants ?? []) as InviteTeamGrant[];
    if (grants.length > 0) {
      for (const grant of grants) {
        await db()
          .insert(teamMemberships)
          .values({
            teamId: grant.teamId,
            userId: userRow.id,
            role: grant.role,
            addedByUserId: invite.invitedByUserId,
            joinedAt: new Date(),
          })
          .onConflictDoNothing({
            target: [teamMemberships.teamId, teamMemberships.userId],
          });
        await recordAudit({
          orgId: invite.orgId,
          actorUserId: userRow.id,
          principal: { type: "user" },
          action: "team.member.add",
          targetType: "team_membership",
          targetId: `${grant.teamId}:${userRow.id}`,
          metadata: {
            teamId: grant.teamId,
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
      principal: { type: "user" },
      action: "org.invite.accept",
      targetType: "org_invite",
      targetId: invite.id,
      metadata: { email, role: invite.role, teamGrants: grants.length },
    });
    if (createdUser || !userRow.defaultOrgId) {
      await db()
        .update(users)
        .set({ defaultOrgId: invite.orgId })
        .where(and(eq(users.id, userRow.id), sql`${users.defaultOrgId} IS NULL`));
    }
    // Land the invitee on the most useful team they now belong to: prefer a
    // grant on the org's default team, otherwise the first granted team,
    // otherwise the org default.
    const orgDefaultTeamId = await getDefaultTeamIdForOrg(invite.orgId);
    let inviteTeamId: string | null = null;
    if (grants.length > 0) {
      const grantOnDefault = orgDefaultTeamId
        ? grants.find((g) => g.teamId === orgDefaultTeamId)
        : undefined;
      inviteTeamId = (grantOnDefault ?? grants[0]).teamId;
    } else {
      inviteTeamId = orgDefaultTeamId;
    }
    const lastActiveTeamByOrg = {
      ...((userRow.lastActiveTeamByOrg as Record<string, string> | null) ?? {}),
    };
    if (inviteTeamId) lastActiveTeamByOrg[invite.orgId] = inviteTeamId;
    await db()
      .update(users)
      .set({
        lastActiveOrgId: invite.orgId,
        lastActiveTeamId: inviteTeamId ?? null,
        lastActiveTeamByOrg,
      })
      .where(eq(users.id, userRow.id));
    const tokenPayload = {
      sub: userRow.id,
      email,
      activeOrgId: invite.orgId,
      ...(inviteTeamId ? { activeTeamId: inviteTeamId } : {}),
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
      teamGrants: grants,
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
      principal: { type: "user" },
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

  /**
   * Admin-only: remove a member. Cascades team memberships in this org via
   * a join over `teams` so we don't touch teams in other orgs the user may
   * still belong to. Project access is automatically removed because
   * `team_projects` access derives from team_memberships.
   */
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
    // Drop team memberships scoped to teams in this org. Drizzle doesn't
    // let `delete().where()` reference another table, so collect the team
    // ids first.
    const orgTeamIds = (
      await db()
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.orgId, orgId))
    ).map((t) => t.id);
    if (orgTeamIds.length > 0) {
      await db()
        .delete(teamMemberships)
        .where(
          and(
            eq(teamMemberships.userId, userId),
            inArray(teamMemberships.teamId, orgTeamIds),
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
    const grants = (invite.teamGrants ?? []) as InviteTeamGrant[];
    const teamDocs = grants.length
      ? await db()
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(inArray(teams.id, grants.map((g) => g.teamId)))
      : [];
    const teamNameById = new Map(teamDocs.map((t) => [t.id, t.name]));
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
      teamGrants: grants.map((g) => ({
        teamId: g.teamId,
        teamName: teamNameById.get(g.teamId) ?? "(unknown team)",
        role: g.role,
      })),
    });
  });

  // Suppress unused-import warnings for items kept for future helpers.
  void asc;
  void gt;
  void desc;
  void teamProjects;
  void effectiveRoleInProject;
}
