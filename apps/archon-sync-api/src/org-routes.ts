import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireAuth, signAccessToken, signRefreshToken } from "./auth.js";
import {
  ensureUserHasDefaultOrg,
  getActiveDb,
  getAuditEventsCollection,
  getDefaultSpaceIdForOrg,
  getNotificationsCollection,
  getOrgInvitesCollection,
  getOrgMembershipsCollection,
  getOrgsCollection,
  getProjectSharesCollection,
  getSpaceMembershipsCollection,
  getSpacesCollection,
  getTeamsCollection,
  getUsersCollection,
  getWorkspaceSharesCollection,
  getWpnProjectsCollection,
  getWpnWorkspacesCollection,
  type UserDoc,
} from "./db.js";
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
  type OrgInviteDoc,
  type OrgRole,
} from "./org-schemas.js";
import type { NotificationDoc, OrgInviteNotificationPayload } from "./notification-schemas.js";
import {
  listMembershipsForUser,
  requireOrgAdminOrMaster,
  requireOrgRole,
} from "./org-auth.js";
import { recordAudit } from "./audit.js";
import { buildSessionsAfterAppend } from "./refresh-sessions.js";

const INVITE_TTL_DAYS = 7;
const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newInviteToken(): { plain: string; hash: string } {
  const plain = randomBytes(32).toString("base64url");
  return { plain, hash: hashInviteToken(plain) };
}

function isValidOrgIdHex(id: string): boolean {
  return /^[a-f0-9]{24}$/i.test(id);
}

function inviteNotificationDedupeKey(inviteId: string): string {
  return `org_invite:${inviteId}`;
}

async function consumeInviteNotification(inviteId: string): Promise<void> {
  const notifications = getNotificationsCollection();
  await notifications.updateOne(
    { dedupeKey: inviteNotificationDedupeKey(inviteId) },
    { $set: { status: "consumed", consumedAt: new Date() } },
  );
}

/**
 * Phase 8: pick the space the caller lands in when their `activeOrgId` changes.
 * Prefers a remembered per-org space (still accessible), falls back to the
 * org's default space — using the read-only lookup so we never silently
 * enrol the caller as Space Owner. Returns `null` if the org has no default
 * space (unusual) — the caller then omits `activeSpaceId` from the JWT and
 * `resolveReadScope` treats the request as "no scope".
 */
async function resolveSpaceForOrgEntry(
  user: UserDoc,
  orgIdHex: string,
): Promise<string | null> {
  const userIdHex = user._id.toHexString();
  const remembered = user.lastActiveSpaceByOrg?.[orgIdHex];
  if (remembered && /^[a-f0-9]{24}$/i.test(remembered)) {
    const direct = await effectiveRoleInSpace(userIdHex, remembered);
    if (direct) {
      return remembered;
    }
    // Org admins can always enter any space in their org even without a
    // space-level membership row (mirrors resolveReadScope override).
    const orgMembership = await getOrgMembershipsCollection().findOne({
      orgId: orgIdHex,
      userId: userIdHex,
    });
    if (orgMembership?.role === "admin") {
      return remembered;
    }
  }
  return getDefaultSpaceIdForOrg(orgIdHex);
}

export function registerOrgRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  /** List orgs the caller belongs to plus role + active selection. */
  app.get("/orgs/me", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const memberships = await listMembershipsForUser(auth.sub);
    if (memberships.length === 0) {
      const users = getUsersCollection();
      const u = (await users.findOne({
        _id: new ObjectId(auth.sub),
      })) as UserDoc | null;
      if (u) {
        await ensureUserHasDefaultOrg(getActiveDb(), auth.sub, u.email);
      }
    }
    const refreshed = await listMembershipsForUser(auth.sub);
    const orgIds = refreshed.map((m) => m.orgId).filter(isValidOrgIdHex);
    const orgs =
      orgIds.length === 0
        ? []
        : await getOrgsCollection()
            .find({ _id: { $in: orgIds.map((id) => new ObjectId(id)) } })
            .toArray();
    const orgsById = new Map(orgs.map((o) => [o._id.toHexString(), o]));
    const userDoc = (await getUsersCollection().findOne({
      _id: new ObjectId(auth.sub),
    })) as UserDoc | null;
    const activeOrgId = auth.activeOrgId ?? userDoc?.defaultOrgId ?? null;
    return reply.send({
      orgs: refreshed.map((m) => {
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

  /** Create a new Org. Caller becomes admin and owner. Blocked for users whose account was admin-provisioned into a specific org (see `UserDoc.lockedOrgId`). */
  app.post("/orgs", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const parsed = createOrgBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    let callerOid: ObjectId;
    try {
      callerOid = new ObjectId(auth.sub);
    } catch {
      return reply.status(401).send({ error: "Invalid session" });
    }
    const callerDoc = (await getUsersCollection().findOne({
      _id: callerOid,
    })) as UserDoc | null;
    if (callerDoc?.lockedOrgId) {
      return reply.status(403).send({
        error: "Organization creation is disabled for invited members",
      });
    }
    const orgs = getOrgsCollection();
    const memberships = getOrgMembershipsCollection();
    const slugFromName = parsed.data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56);
    const slug =
      parsed.data.slug ?? (slugFromName.length >= 2 ? slugFromName : `org-${randomUUID().slice(0, 8)}`);
    const slugTaken = await orgs.findOne({ slug });
    if (slugTaken) {
      return reply.status(409).send({ error: "Slug already in use" });
    }
    const ins = await orgs.insertOne({
      name: parsed.data.name,
      slug,
      ownerUserId: auth.sub,
      createdAt: new Date(),
    } as never);
    const orgIdHex = ins.insertedId.toHexString();
    await memberships.insertOne({
      orgId: orgIdHex,
      userId: auth.sub,
      role: "admin" as OrgRole,
      joinedAt: new Date(),
    } as never);
    return reply.send({ orgId: orgIdHex, name: parsed.data.name, slug });
  });

  /**
   * Rename an Org and/or change its slug. Gated by org-admin OR master-admin.
   * Slug changes are validated for global uniqueness (excluding self) using
   * the same regex as `POST /orgs`. At least one field must be provided.
   */
  app.patch("/orgs/:orgId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { orgId } = request.params as { orgId: string };
    if (!isValidOrgIdHex(orgId)) {
      return reply.status(404).send({ error: "Organization not found" });
    }
    const ctx = await requireOrgAdminOrMaster(request, reply, auth, orgId);
    if (!ctx) {
      return;
    }
    const parsed = updateOrgBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const patch: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) {
      patch.name = parsed.data.name;
    }
    if (parsed.data.slug !== undefined) {
      const existing = await getOrgsCollection().findOne({
        slug: parsed.data.slug,
        _id: { $ne: new ObjectId(orgId) },
      });
      if (existing) {
        return reply.status(409).send({ error: "Slug already in use" });
      }
      patch.slug = parsed.data.slug;
    }
    if (Object.keys(patch).length === 0) {
      return reply.status(400).send({ error: "No fields to update" });
    }
    const result = await getOrgsCollection().updateOne(
      { _id: new ObjectId(orgId) },
      { $set: patch },
    );
    if (result.matchedCount === 0) {
      return reply.status(404).send({ error: "Organization not found" });
    }
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      action: "org.update",
      targetType: "org",
      targetId: orgId,
      metadata: patch,
    });
    return reply.status(204).send();
  });

  /**
   * Delete an Org. Gated by org-admin OR master-admin. Refuses if the org
   * still has non-default spaces, any WPN workspaces, any teams, or any
   * members other than the caller (or any members at all if the caller is
   * a master admin with no direct membership). On success, cascades: the
   * default space + its memberships, all org memberships, invites, and
   * audit events for this org; and clears stale `defaultOrgId`,
   * `lastActiveOrgId`, `lastActiveSpaceId`, and `lockedOrgId` user pointers.
   */
  app.delete("/orgs/:orgId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { orgId } = request.params as { orgId: string };
    if (!isValidOrgIdHex(orgId)) {
      return reply.status(404).send({ error: "Organization not found" });
    }
    const ctx = await requireOrgAdminOrMaster(request, reply, auth, orgId);
    if (!ctx) {
      return;
    }
    const org = await getOrgsCollection().findOne({ _id: new ObjectId(orgId) });
    if (!org) {
      return reply.status(404).send({ error: "Organization not found" });
    }
    const nonDefaultSpaceCount = await getSpacesCollection().countDocuments({
      orgId,
      kind: { $ne: "default" },
    });
    if (nonDefaultSpaceCount > 0) {
      return reply.status(409).send({
        error: "Organization still has spaces; delete them first",
      });
    }
    const workspaceCount = await getWpnWorkspacesCollection().countDocuments({
      orgId,
    });
    if (workspaceCount > 0) {
      return reply.status(409).send({
        error: "Organization still has workspaces; move or delete them first",
      });
    }
    const teamCount = await getTeamsCollection().countDocuments({ orgId });
    if (teamCount > 0) {
      return reply.status(409).send({
        error: "Organization still has teams; delete them first",
      });
    }
    const otherMemberCount = await getOrgMembershipsCollection().countDocuments({
      orgId,
      userId: { $ne: auth.sub },
    });
    if (otherMemberCount > 0) {
      return reply.status(409).send({
        error: "Organization still has other members; remove them first",
      });
    }
    const defaultSpaces = await getSpacesCollection()
      .find({ orgId, kind: "default" })
      .toArray();
    const defaultSpaceIds = defaultSpaces.map((s) => s._id.toHexString());
    if (defaultSpaceIds.length > 0) {
      await getSpaceMembershipsCollection().deleteMany({
        spaceId: { $in: defaultSpaceIds },
      });
      await getSpacesCollection().deleteMany({ orgId, kind: "default" });
    }
    await getOrgMembershipsCollection().deleteMany({ orgId });
    await getOrgInvitesCollection().deleteMany({ orgId });
    // Audit events reference the deleted org; remove them so they don't
    // dangle. Record the deletion itself BEFORE this sweep would erase it.
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      action: "org.delete",
      targetType: "org",
      targetId: orgId,
      metadata: { name: org.name, slug: org.slug },
    });
    await getAuditEventsCollection().deleteMany({
      orgId,
      action: { $ne: "org.delete" },
    });
    await getOrgsCollection().deleteOne({ _id: new ObjectId(orgId) });
    // Clear dangling user pointers. `lastActiveSpaceId` is cleared for any
    // user whose `lastActiveOrgId` equals this org, which is sufficient —
    // the space id only makes sense alongside its parent org.
    await getUsersCollection().updateMany(
      { defaultOrgId: orgId },
      { $unset: { defaultOrgId: "" } },
    );
    await getUsersCollection().updateMany(
      { lastActiveOrgId: orgId },
      { $unset: { lastActiveOrgId: "", lastActiveSpaceId: "" } },
    );
    await getUsersCollection().updateMany(
      { lockedOrgId: orgId },
      { $unset: { lockedOrgId: "" } },
    );
    return reply.status(204).send();
  });

  /**
   * Switch the access-token's `activeOrgId` claim. Also resolves a concrete
   * `activeSpaceId` for the target org — preferring the caller's remembered
   * space (via `lastActiveSpaceByOrg`) or falling back to the org's default
   * space — and mints a new access token carrying both claims. Without the
   * space claim `/wpn/*` reads would resolve to a null scope and return empty
   * (see Phase 8 note).
   */
  app.post("/orgs/active", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
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
    if (!ctx) {
      return;
    }
    const users = getUsersCollection();
    const user = (await users.findOne({
      _id: new ObjectId(auth.sub),
    })) as UserDoc | null;
    if (!user) {
      return reply.status(404).send({ error: "User not found" });
    }
    const nextSpaceId = await resolveSpaceForOrgEntry(user, parsed.data.orgId);
    const update: Record<string, unknown> = {
      lastActiveOrgId: parsed.data.orgId,
      lastActiveSpaceId: nextSpaceId ?? null,
    };
    if (nextSpaceId) {
      update[`lastActiveSpaceByOrg.${parsed.data.orgId}`] = nextSpaceId;
    }
    await users.updateOne({ _id: user._id }, { $set: update });
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

  /** Admin-only: list pending + accepted invites for an Org. */
  app.get("/orgs/:orgId/invites", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { orgId } = request.params as { orgId: string };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) {
      return;
    }
    const list = await getOrgInvitesCollection()
      .find({ orgId })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return reply.send({
      invites: list.map((i) => ({
        inviteId: i._id.toHexString(),
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

  /** Admin-only: create an invite. Returns the plain token (copy-link v1). */
  app.post("/orgs/:orgId/invites", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { orgId } = request.params as { orgId: string };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) {
      return;
    }
    const parsed = createInviteBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const email = parsed.data.email.toLowerCase();
    const spaceGrants: InviteSpaceGrant[] = parsed.data.spaceGrants ?? [];
    for (const grant of spaceGrants) {
      if (!isValidOrgIdHex(grant.spaceId)) {
        return reply
          .status(400)
          .send({ error: `Invalid space id: ${grant.spaceId}` });
      }
    }
    const spaceDocs = spaceGrants.length
      ? await getSpacesCollection()
          .find({ _id: { $in: spaceGrants.map((g) => new ObjectId(g.spaceId)) } })
          .toArray()
      : [];
    // Every requested space must belong to this org — reject cross-org grants.
    for (const grant of spaceGrants) {
      const doc = spaceDocs.find((s) => s._id.toHexString() === grant.spaceId);
      if (!doc || doc.orgId !== orgId) {
        return reply
          .status(400)
          .send({ error: `Space ${grant.spaceId} does not belong to this org` });
      }
    }
    const invites = getOrgInvitesCollection();
    const existingPending = await invites.findOne({
      orgId,
      email,
      status: "pending",
    });
    if (existingPending) {
      return reply.status(409).send({ error: "Invite already pending for this email" });
    }
    const { plain, hash } = newInviteToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    const ins = await invites.insertOne({
      orgId,
      email,
      role: parsed.data.role,
      tokenHash: hash,
      status: "pending",
      invitedByUserId: auth.sub,
      createdAt: now,
      expiresAt,
      spaceGrants,
    } as never);
    const inviteIdHex = ins.insertedId.toHexString();
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      action: "org.invite.create",
      targetType: "org_invite",
      targetId: inviteIdHex,
      metadata: { email, role: parsed.data.role, spaceGrants: spaceGrants.length },
    });

    // Phase 8: if invitee already has an account, surface the invite as an
    // in-app notification. New users discover the invite via the token link
    // (copy/email out-of-band by the admin).
    const existingUser = (await getUsersCollection().findOne({ email })) as UserDoc | null;
    if (existingUser) {
      const org = await getOrgsCollection().findOne({ _id: new ObjectId(orgId) });
      const inviter = (await getUsersCollection().findOne({
        _id: new ObjectId(auth.sub),
      })) as UserDoc | null;
      const spaceNameById = new Map(spaceDocs.map((s) => [s._id.toHexString(), s.name]));
      const payload: OrgInviteNotificationPayload = {
        inviteId: inviteIdHex,
        orgId,
        orgName: org?.name ?? "(unknown org)",
        inviterUserId: auth.sub,
        inviterDisplayName:
          inviter?.displayName ?? inviter?.email ?? "(someone)",
        inviterEmail: inviter?.email ?? "",
        role: parsed.data.role,
        spaceGrants: spaceGrants.map((g) => ({
          spaceId: g.spaceId,
          spaceName: spaceNameById.get(g.spaceId) ?? "(unknown space)",
          role: g.role,
        })),
        expiresAt: expiresAt.toISOString(),
      };
      const notifications = getNotificationsCollection();
      await notifications.updateOne(
        { dedupeKey: inviteNotificationDedupeKey(inviteIdHex) },
        {
          $setOnInsert: {
            userId: existingUser._id.toHexString(),
            type: "org_invite",
            payload,
            link: `/invite/${plain}`,
            status: "unread",
            createdAt: now,
            dedupeKey: inviteNotificationDedupeKey(inviteIdHex),
          } satisfies Omit<NotificationDoc, "_id">,
        },
        { upsert: true },
      );
    }

    return reply.send({
      inviteId: inviteIdHex,
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
    if (!auth) {
      return;
    }
    const { orgId, inviteId } = request.params as {
      orgId: string;
      inviteId: string;
    };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) {
      return;
    }
    let oid: ObjectId;
    try {
      oid = new ObjectId(inviteId);
    } catch {
      return reply.status(400).send({ error: "Invalid invite id" });
    }
    const result = await getOrgInvitesCollection().updateOne(
      { _id: oid, orgId, status: "pending" },
      { $set: { status: "revoked" } },
    );
    if (result.matchedCount === 0) {
      return reply.status(404).send({ error: "Invite not found or already settled" });
    }
    await consumeInviteNotification(inviteId);
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      action: "org.invite.revoke",
      targetType: "org_invite",
      targetId: inviteId,
    });
    return reply.status(204).send();
  });

  /**
   * Public (no auth required): accept an invite token. If the user already
   * exists, simply add membership. Otherwise create the account and require
   * a password in the body. Returns access + refresh tokens.
   *
   * Phase 8: inserts `space_memberships` rows per `invite.spaceGrants`, and
   * marks the matching `notifications` row consumed.
   */
  app.post("/auth/accept-invite", async (request, reply) => {
    const parsed = acceptInviteBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tokenHash = hashInviteToken(parsed.data.token);
    const invites = getOrgInvitesCollection();
    // Pre-check (so we can return a password-needed hint before mutating).
    const invitePreview = await invites.findOne({ tokenHash, status: "pending" });
    if (!invitePreview || invitePreview.expiresAt.getTime() < Date.now()) {
      return reply.status(404).send({ error: "Invite not found or expired" });
    }
    const users = getUsersCollection();
    const email = invitePreview.email.toLowerCase();
    let user = (await users.findOne({ email })) as UserDoc | null;
    let createdUser = false;
    if (!user) {
      if (!parsed.data.password) {
        return reply.status(400).send({
          error: "Password required for new account",
          needsPassword: true,
        });
      }
      const passwordHash = await bcrypt.hash(parsed.data.password, 12);
      const ins = await users.insertOne({
        email,
        passwordHash,
        displayName: parsed.data.displayName ?? null,
        mustSetPassword: false,
        lockedOrgId: invitePreview.orgId,
      } as Omit<UserDoc, "_id">);
      user = (await users.findOne({ _id: ins.insertedId })) as UserDoc;
      createdUser = true;
    } else if (user.mustSetPassword === true) {
      if (!parsed.data.password) {
        return reply.status(400).send({
          error: "Password required to finish account setup",
          needsPassword: true,
        });
      }
      const passwordHash = await bcrypt.hash(parsed.data.password, 12);
      await users.updateOne(
        { _id: user._id },
        {
          $set: {
            passwordHash,
            mustSetPassword: false,
            ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
          },
        },
      );
      user = (await users.findOne({ _id: user._id })) as UserDoc;
    }
    const userIdHex = user._id.toHexString();
    // Atomic transition pending → accepted. Prevents a concurrent decline or
    // re-accept from double-writing memberships.
    const claimed = await invites.findOneAndUpdate(
      { _id: invitePreview._id, status: "pending" },
      {
        $set: {
          status: "accepted",
          acceptedAt: new Date(),
          acceptedByUserId: userIdHex,
        },
      },
      { returnDocument: "after" },
    );
    const invite = claimed as OrgInviteDoc | null;
    if (!invite) {
      return reply.status(409).send({ error: "Invite is no longer pending" });
    }
    const memberships = getOrgMembershipsCollection();
    await memberships.updateOne(
      { orgId: invite.orgId, userId: userIdHex },
      {
        $setOnInsert: {
          orgId: invite.orgId,
          userId: userIdHex,
          role: invite.role,
          joinedAt: new Date(),
        },
      },
      { upsert: true },
    );
    // Phase 8: attach the inviter's space grants as direct space_memberships.
    // Idempotent ($setOnInsert) so a re-accept or overlapping grant doesn't
    // downgrade an existing role.
    const grants: InviteSpaceGrant[] = invite.spaceGrants ?? [];
    if (grants.length > 0) {
      const spaceMemberships = getSpaceMembershipsCollection();
      for (const grant of grants) {
        await spaceMemberships.updateOne(
          { spaceId: grant.spaceId, userId: userIdHex },
          {
            $setOnInsert: {
              spaceId: grant.spaceId,
              userId: userIdHex,
              role: grant.role,
              addedByUserId: invite.invitedByUserId,
              joinedAt: new Date(),
            },
          },
          { upsert: true },
        );
        await recordAudit({
          orgId: invite.orgId,
          actorUserId: userIdHex,
          action: "space.member.add",
          targetType: "space_membership",
          targetId: grant.spaceId,
          metadata: { userId: userIdHex, role: grant.role, viaInvite: invite._id.toHexString() },
        });
      }
    }
    await consumeInviteNotification(invite._id.toHexString());
    await recordAudit({
      orgId: invite.orgId,
      actorUserId: userIdHex,
      action: "org.invite.accept",
      targetType: "org_invite",
      targetId: invite._id.toHexString(),
      metadata: { email, role: invite.role, spaceGrants: grants.length },
    });
    if (createdUser || !user.defaultOrgId) {
      await users.updateOne(
        { _id: user._id, $or: [{ defaultOrgId: { $exists: false } }, { defaultOrgId: null }] },
        { $set: { defaultOrgId: invite.orgId } },
      );
    }
    // Land the invitee in a space they can actually read. If the invite
    // granted any spaces, pick one of those (preferring the org's default
    // when it's among the grants, so admins who grant default + extras don't
    // land the invitee on an arbitrary non-default space). Otherwise fall
    // back to the org's default — a useful pointer even though the invitee
    // won't have space-membership there, because the client exposes a
    // SpaceSwitcher that will let them pick a readable space.
    //
    // Previous behavior (always `getDefaultSpaceIdForOrg`) stranded invitees
    // on a space they had no access to, so the first `/wpn/*` read returned
    // an empty tree even though they had been granted other spaces.
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
    const postAcceptUpdate: Record<string, unknown> = {
      lastActiveOrgId: invite.orgId,
      lastActiveSpaceId: inviteSpaceId ?? null,
    };
    if (inviteSpaceId) {
      postAcceptUpdate[`lastActiveSpaceByOrg.${invite.orgId}`] = inviteSpaceId;
    }
    await users.updateOne({ _id: user._id }, { $set: postAcceptUpdate });
    const payload = {
      sub: userIdHex,
      email,
      activeOrgId: invite.orgId,
      ...(inviteSpaceId ? { activeSpaceId: inviteSpaceId } : {}),
    };
    const jti = randomUUID();
    const token = signAccessToken(jwtSecret, payload);
    const refreshToken = signRefreshToken(
      jwtSecret,
      { sub: userIdHex, email },
      jti,
    );
    const nextSessions = buildSessionsAfterAppend(user, jti);
    await users.updateOne(
      { _id: user._id },
      { $set: { refreshSessions: nextSessions }, $unset: { activeRefreshJti: "" } },
    );
    return reply.send({
      token,
      refreshToken,
      userId: userIdHex,
      orgId: invite.orgId,
      role: invite.role,
      createdUser,
      spaceGrants: grants,
    });
  });

  /**
   * Public (no auth): decline an invite token. Idempotent — unknown or
   * already-settled tokens return 404 uniformly (no leakage).
   */
  app.post("/auth/decline-invite", async (request, reply) => {
    const parsed = declineInviteBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const tokenHash = hashInviteToken(parsed.data.token);
    const invites = getOrgInvitesCollection();
    const claimed = await invites.findOneAndUpdate(
      { tokenHash, status: "pending" },
      { $set: { status: "declined", declinedAt: new Date() } },
      { returnDocument: "after" },
    );
    const invite = claimed as OrgInviteDoc | null;
    if (!invite) {
      return reply.status(404).send({ error: "Invite not found or already settled" });
    }
    await consumeInviteNotification(invite._id.toHexString());
    await recordAudit({
      orgId: invite.orgId,
      actorUserId: invite.invitedByUserId,
      action: "org.invite.decline",
      targetType: "org_invite",
      targetId: invite._id.toHexString(),
      metadata: { email: invite.email },
    });
    return reply.send({ ok: true });
  });

  /** Admin-only: list members of an Org. */
  app.get("/orgs/:orgId/members", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { orgId } = request.params as { orgId: string };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) {
      return;
    }
    const memberships = await getOrgMembershipsCollection()
      .find({ orgId })
      .toArray();
    const userIds = memberships
      .map((m) => m.userId)
      .filter(isValidOrgIdHex);
    const users = getUsersCollection();
    const userDocs = (await users
      .find({ _id: { $in: userIds.map((id) => new ObjectId(id)) } })
      .toArray()) as UserDoc[];
    const usersById = new Map(userDocs.map((u) => [u._id.toHexString(), u]));
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

  /** Admin-only: change a member's role. Last admin cannot demote themselves. */
  app.patch("/orgs/:orgId/members/:userId/role", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { orgId, userId } = request.params as {
      orgId: string;
      userId: string;
    };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) {
      return;
    }
    const parsed = setMemberRoleBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const memberships = getOrgMembershipsCollection();
    const target = await memberships.findOne({ orgId, userId });
    if (!target) {
      return reply.status(404).send({ error: "Member not found" });
    }
    if (
      target.role === "admin" &&
      parsed.data.role === "member" &&
      target.userId === auth.sub
    ) {
      const adminCount = await memberships.countDocuments({ orgId, role: "admin" });
      if (adminCount <= 1) {
        return reply
          .status(400)
          .send({ error: "Cannot demote the last admin of the org" });
      }
    }
    await memberships.updateOne(
      { _id: target._id },
      { $set: { role: parsed.data.role } },
    );
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      action: "org.member.role_change",
      targetType: "org_membership",
      targetId: userId,
      metadata: { from: target.role, to: parsed.data.role },
    });
    return reply.status(204).send();
  });

  /** Admin-only: remove a member from the org. */
  app.delete("/orgs/:orgId/members/:userId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { orgId, userId } = request.params as {
      orgId: string;
      userId: string;
    };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) {
      return;
    }
    const memberships = getOrgMembershipsCollection();
    const target = await memberships.findOne({ orgId, userId });
    if (!target) {
      return reply.status(404).send({ error: "Member not found" });
    }
    if (target.role === "admin") {
      const adminCount = await memberships.countDocuments({ orgId, role: "admin" });
      if (adminCount <= 1) {
        return reply
          .status(400)
          .send({ error: "Cannot remove the last admin of the org" });
      }
    }
    await memberships.deleteOne({ _id: target._id });
    // Phase 8: cascade workspace + project share grants held by the removed
    // user across the entire org.
    const wsIds = (
      await getWpnWorkspacesCollection()
        .find({ orgId }, { projection: { id: 1 } })
        .toArray()
    ).map((w) => w.id);
    if (wsIds.length > 0) {
      await getWorkspaceSharesCollection().deleteMany({
        userId,
        workspaceId: { $in: wsIds },
      });
    }
    const projIds = (
      await getWpnProjectsCollection()
        .find({ orgId }, { projection: { id: 1 } })
        .toArray()
    ).map((p) => p.id);
    if (projIds.length > 0) {
      await getProjectSharesCollection().deleteMany({
        userId,
        projectId: { $in: projIds },
      });
    }
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      action: "org.member.remove",
      targetType: "org_membership",
      targetId: userId,
      metadata: { role: target.role },
    });
    return reply.status(204).send();
  });

  /**
   * Admin-only: create a new user + org membership in one call. The admin
   * supplies a temporary password and shares it out-of-band; the new user is
   * forced to change it on first login (mustSetPassword=true).
   */
  app.post("/orgs/:orgId/members/create", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { orgId } = request.params as { orgId: string };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) {
      return;
    }
    const parsed = createOrgMemberBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const email = parsed.data.email.toLowerCase();
    const users = getUsersCollection();
    const existing = await users.findOne({ email });
    if (existing) {
      return reply.status(409).send({ error: "Email already registered" });
    }
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const ins = await users.insertOne({
      email,
      passwordHash,
      mustSetPassword: true,
      lockedOrgId: orgId,
      defaultOrgId: orgId,
    } as Omit<UserDoc, "_id">);
    const userIdHex = ins.insertedId.toHexString();
    await getOrgMembershipsCollection().insertOne({
      orgId,
      userId: userIdHex,
      role: parsed.data.role,
      joinedAt: new Date(),
    } as never);
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      action: "org.member.create_with_password",
      targetType: "org_membership",
      targetId: userIdHex,
      metadata: { email, role: parsed.data.role },
    });
    return reply.send({
      userId: userIdHex,
      email,
      role: parsed.data.role,
      mustSetPassword: true,
    });
  });

  /**
   * Admin-only: reset a member's password. Sets mustSetPassword=true so the
   * user must pick a new one on next login. Caller must share the given org
   * with the target (enforced by requireOrgRole + membership check below).
   */
  app.post("/orgs/:orgId/members/:userId/reset-password", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { orgId, userId } = request.params as {
      orgId: string;
      userId: string;
    };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) {
      return;
    }
    const parsed = resetMemberPasswordBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const membership = await getOrgMembershipsCollection().findOne({
      orgId,
      userId,
    });
    if (!membership) {
      return reply.status(404).send({ error: "Member not found in this org" });
    }
    let uoid: ObjectId;
    try {
      uoid = new ObjectId(userId);
    } catch {
      return reply.status(400).send({ error: "Invalid user id" });
    }
    const users = getUsersCollection();
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const result = await users.updateOne(
      { _id: uoid },
      {
        $set: { passwordHash, mustSetPassword: true },
        $unset: { refreshSessions: "", activeRefreshJti: "" },
      },
    );
    if (result.matchedCount === 0) {
      return reply.status(404).send({ error: "User not found" });
    }
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      action: "org.member.password_reset",
      targetType: "org_membership",
      targetId: userId,
    });
    return reply.send({ userId, mustSetPassword: true });
  });

  /** Validate an invite token without consuming it (for Accept screen prefill). */
  app.get("/auth/invites/preview", async (request, reply) => {
    const q = z
      .object({ token: z.string().min(10) })
      .safeParse(request.query);
    if (!q.success) {
      return reply.status(400).send({ error: q.error.flatten() });
    }
    const tokenHash = hashInviteToken(q.data.token);
    const invite = await getOrgInvitesCollection().findOne({
      tokenHash,
      status: "pending",
    });
    if (!invite || invite.expiresAt.getTime() < Date.now()) {
      return reply.status(404).send({ error: "Invite not found or expired" });
    }
    const org = await getOrgsCollection().findOne({
      _id: new ObjectId(invite.orgId),
    });
    const user = (await getUsersCollection().findOne({
      email: invite.email,
    })) as UserDoc | null;
    const inviter = (await getUsersCollection().findOne({
      _id: new ObjectId(invite.invitedByUserId),
    })) as UserDoc | null;
    const grants = invite.spaceGrants ?? [];
    const spaceDocs = grants.length
      ? await getSpacesCollection()
          .find({ _id: { $in: grants.map((g) => new ObjectId(g.spaceId)) } })
          .toArray()
      : [];
    const spaceNameById = new Map(spaceDocs.map((s) => [s._id.toHexString(), s.name]));
    return reply.send({
      orgId: invite.orgId,
      orgName: org?.name ?? "(unknown org)",
      orgSlug: org?.slug ?? "",
      email: invite.email,
      role: invite.role,
      needsPassword: !user || user.mustSetPassword === true,
      expiresAt: invite.expiresAt,
      inviter: {
        userId: invite.invitedByUserId,
        displayName: inviter?.displayName ?? inviter?.email ?? "(someone)",
        email: inviter?.email ?? "",
      },
      spaceGrants: grants.map((g) => ({
        spaceId: g.spaceId,
        spaceName: spaceNameById.get(g.spaceId) ?? "(unknown space)",
        role: g.role,
      })),
    });
  });
}
