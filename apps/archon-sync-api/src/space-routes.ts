import * as crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq, and, ne, inArray, isNull, or, count, sql, asc } from "drizzle-orm";
import { requireAuth, signAccessToken } from "./auth.js";
import { getDb } from "./pg.js";
import {
  orgMemberships,
  projectShares,
  spaceMemberships,
  spaces,
  users,
  workspaceShares,
  wpnProjects,
  wpnWorkspaces,
} from "./db/schema.js";
import { requireOrgRole } from "./org-auth.js";
import {
  addSpaceMemberBody,
  createSpaceBody,
  setActiveSpaceBody,
  setSpaceMemberRoleBody,
  updateSpaceBody,
  type SpaceRole,
} from "./org-schemas.js";
import { recordAudit } from "./audit.js";
import { getEffectiveSpaceRoles } from "./permission-resolver.js";
import {
  requireSpaceManage,
  requireSpaceMember,
  type SpaceRow,
} from "./space-auth.js";
import { isUuid } from "./db/legacy-id-map.js";

/** Central guard so every default-space protection uses the same error shape. */
function assertNotDefault(
  space: SpaceRow,
  op: "delete" | "hide",
): { status: number; body: { error: string; code: string } } | null {
  if (space.kind === "default") {
    const code = `cannot_${op}_default_space`;
    const msg =
      op === "delete"
        ? "Cannot delete the default space"
        : "Cannot hide the default space";
    return { status: 400, body: { error: msg, code } };
  }
  return null;
}

/** Single serializer so list + detail responses emit the same shape. */
function serializeSpace(
  s: SpaceRow,
  role: SpaceRole | null,
): Record<string, unknown> {
  return {
    spaceId: s.id,
    orgId: s.orgId,
    name: s.name,
    kind: s.kind,
    role,
    createdAt: s.createdAt,
    hidden: s.hidden === true,
    hiddenAt: s.hiddenAt ?? null,
    hiddenByUserId: s.hiddenByUserId ?? null,
  };
}

export function registerSpaceRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;
  const db = (): ReturnType<typeof getDb> => getDb();

  /**
   * List spaces in an org that the caller is a member of. Admins see all.
   * Hidden spaces excluded by default; `?includeHidden=true` opts in (admins only).
   */
  app.get("/orgs/:orgId/spaces", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { orgId } = request.params as { orgId: string };
    const orgMemberRows = await db()
      .select({ role: orgMemberships.role })
      .from(orgMemberships)
      .where(
        and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, auth.sub)),
      )
      .limit(1);
    const orgMember = orgMemberRows[0];
    if (!orgMember) {
      return reply.status(404).send({ error: "Organization not found" });
    }
    const query = request.query as { includeHidden?: string } | undefined;
    const includeHidden = query?.includeHidden === "true";
    if (includeHidden && orgMember.role !== "admin") {
      return reply
        .status(403)
        .send({ error: "Org admin role required", code: "admin_only" });
    }
    const allSpaces = await (includeHidden
      ? db().select().from(spaces).where(eq(spaces.orgId, orgId))
      : db()
          .select()
          .from(spaces)
          .where(
            and(
              eq(spaces.orgId, orgId),
              or(isNull(spaces.hidden), eq(spaces.hidden, false)),
            ),
          ));
    const memberRoleBySpace = await getEffectiveSpaceRoles(auth.sub);
    const visible = allSpaces.filter((s) => {
      if (orgMember.role === "admin") return true;
      return memberRoleBySpace.has(s.id);
    });
    return reply.send({
      spaces: visible.map((s) =>
        serializeSpace(s, memberRoleBySpace.get(s.id) ?? null),
      ),
    });
  });

  /** Any org member: create a Space inside an Org. Caller becomes Space Owner. */
  app.post("/orgs/:orgId/spaces", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { orgId } = request.params as { orgId: string };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "member");
    if (!ctx) return;
    const parsed = createSpaceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const spaceId = crypto.randomUUID();
    const now = new Date();
    await db().insert(spaces).values({
      id: spaceId,
      orgId,
      name: parsed.data.name,
      kind: "normal",
      createdByUserId: auth.sub,
      createdAt: now,
    });
    await db().insert(spaceMemberships).values({
      spaceId,
      userId: auth.sub,
      role: "owner",
      addedByUserId: auth.sub,
      joinedAt: now,
    });
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "space.create",
      targetType: "space",
      targetId: spaceId,
      metadata: { name: parsed.data.name },
    });
    return reply.send({
      spaceId,
      orgId,
      name: parsed.data.name,
      kind: "normal",
      role: "owner" as SpaceRole,
    });
  });

  /** Owner-or-org-admin: rename and/or toggle hidden. Default space cannot be hidden. */
  app.patch("/spaces/:spaceId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { spaceId } = request.params as { spaceId: string };
    const ctx = await requireSpaceManage(request, reply, auth, spaceId);
    if (!ctx) return;
    const parsed = updateSpaceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const before = ctx.space;
    const set: Record<string, unknown> = {};
    let renamed: { oldName: string; newName: string } | null = null;
    let hideTransition: "hide" | "unhide" | null = null;

    if (parsed.data.name !== undefined && parsed.data.name !== before.name) {
      const clash = await db()
        .select({ id: spaces.id })
        .from(spaces)
        .where(
          and(
            eq(spaces.orgId, before.orgId),
            eq(spaces.name, parsed.data.name),
            ne(spaces.id, before.id),
          ),
        )
        .limit(1);
      if (clash.length > 0) {
        return reply
          .status(409)
          .send({ error: "A space with this name already exists", code: "name_conflict" });
      }
      set.name = parsed.data.name;
      renamed = { oldName: before.name, newName: parsed.data.name };
    }

    if (parsed.data.hidden !== undefined) {
      const currentHidden = before.hidden === true;
      if (parsed.data.hidden !== currentHidden) {
        if (parsed.data.hidden) {
          const guard = assertNotDefault(before, "hide");
          if (guard) {
            return reply.status(guard.status).send(guard.body);
          }
          set.hidden = true;
          set.hiddenAt = new Date();
          set.hiddenByUserId = auth.sub;
          hideTransition = "hide";
        } else {
          set.hidden = false;
          set.hiddenAt = null;
          set.hiddenByUserId = null;
          hideTransition = "unhide";
        }
      }
    }

    if (Object.keys(set).length === 0) {
      return reply
        .status(400)
        .send({ error: "No fields to update", code: "nothing_to_update" });
    }

    const updated = await db()
      .update(spaces)
      .set(set)
      .where(eq(spaces.id, before.id))
      .returning();
    const after = updated[0];
    if (!after) {
      return reply.status(404).send({ error: "Space not found" });
    }

    if (renamed) {
      await recordAudit({
        orgId: before.orgId,
        actorUserId: auth.sub,
        principal: auth.principal ?? { type: "user" },
        action: "space.rename",
        targetType: "space",
        targetId: spaceId,
        metadata: renamed,
      });
    }
    if (hideTransition) {
      await recordAudit({
        orgId: before.orgId,
        actorUserId: auth.sub,
        principal: auth.principal ?? { type: "user" },
        action: hideTransition === "hide" ? "space.hide" : "space.unhide",
        targetType: "space",
        targetId: spaceId,
        metadata: null,
      });
    }
    return reply.send(serializeSpace(after, ctx.role));
  });

  /** Owner-or-org-admin: delete space (refuses default + non-empty spaces). */
  app.delete("/spaces/:spaceId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { spaceId } = request.params as { spaceId: string };
    const ctx = await requireSpaceManage(request, reply, auth, spaceId);
    if (!ctx) return;
    const guard = assertNotDefault(ctx.space, "delete");
    if (guard) {
      return reply.status(guard.status).send(guard.body);
    }
    const wsCount = (
      await db()
        .select({ n: count() })
        .from(wpnWorkspaces)
        .where(eq(wpnWorkspaces.spaceId, ctx.space.id))
    )[0]?.n ?? 0;
    if (wsCount > 0) {
      return reply.status(409).send({
        error: "Space still has workspaces; move or delete them first",
        code: "space_not_empty",
      });
    }
    await db()
      .delete(spaceMemberships)
      .where(eq(spaceMemberships.spaceId, ctx.space.id));
    // Re-check immediately before the delete to narrow the race.
    const wsCountPre = (
      await db()
        .select({ n: count() })
        .from(wpnWorkspaces)
        .where(eq(wpnWorkspaces.spaceId, ctx.space.id))
    )[0]?.n ?? 0;
    if (wsCountPre > 0) {
      return reply.status(409).send({
        error: "Space still has workspaces; move or delete them first",
        code: "space_not_empty",
      });
    }
    await db().delete(spaces).where(eq(spaces.id, ctx.space.id));
    await recordAudit({
      orgId: ctx.space.orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "space.delete",
      targetType: "space",
      targetId: ctx.space.id,
      metadata: { name: ctx.space.name },
    });
    return reply.status(204).send();
  });

  /** List members. Any space member may read. */
  app.get("/spaces/:spaceId/members", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { spaceId } = request.params as { spaceId: string };
    const ctx = await requireSpaceMember(request, reply, auth, spaceId);
    if (!ctx) return;
    const rows = await db()
      .select()
      .from(spaceMemberships)
      .where(eq(spaceMemberships.spaceId, ctx.space.id));
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
    const usersById = new Map(userRows.map((u) => [u.id, u]));
    return reply.send({
      members: rows.map((m) => {
        const u = usersById.get(m.userId);
        return {
          userId: m.userId,
          email: u?.email ?? "(unknown)",
          displayName: u?.displayName ?? null,
          role: m.role,
          joinedAt: m.joinedAt,
        };
      }),
    });
  });

  /** Owner-only: add an existing org member. */
  app.post("/spaces/:spaceId/members", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { spaceId } = request.params as { spaceId: string };
    const ctx = await requireSpaceManage(request, reply, auth, spaceId);
    if (!ctx) return;
    const parsed = addSpaceMemberBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const isOrgMember = await db()
      .select({ id: orgMemberships.userId })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.orgId, ctx.space.orgId),
          eq(orgMemberships.userId, parsed.data.userId),
        ),
      )
      .limit(1);
    if (isOrgMember.length === 0) {
      return reply
        .status(400)
        .send({ error: "User must be a member of the parent organization" });
    }
    await db()
      .insert(spaceMemberships)
      .values({
        spaceId: ctx.space.id,
        userId: parsed.data.userId,
        role: parsed.data.role,
        addedByUserId: auth.sub,
        joinedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [spaceMemberships.spaceId, spaceMemberships.userId],
      });
    await recordAudit({
      orgId: ctx.space.orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "space.member.add",
      targetType: "space_membership",
      targetId: parsed.data.userId,
      metadata: { spaceId: ctx.space.id, role: parsed.data.role },
    });
    return reply.status(204).send();
  });

  /** Owner-only: change role. Last owner cannot demote themselves. */
  app.patch(
    "/spaces/:spaceId/members/:userId/role",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { spaceId, userId } = request.params as {
        spaceId: string;
        userId: string;
      };
      const ctx = await requireSpaceManage(request, reply, auth, spaceId);
      if (!ctx) return;
      const parsed = setSpaceMemberRoleBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const targetRows = await db()
        .select()
        .from(spaceMemberships)
        .where(
          and(
            eq(spaceMemberships.spaceId, ctx.space.id),
            eq(spaceMemberships.userId, userId),
          ),
        )
        .limit(1);
      const target = targetRows[0];
      if (!target) {
        return reply.status(404).send({ error: "Member not found" });
      }
      if (
        target.role === "owner" &&
        parsed.data.role !== "owner" &&
        target.userId === auth.sub
      ) {
        const ownerCount =
          (
            await db()
              .select({ n: count() })
              .from(spaceMemberships)
              .where(
                and(
                  eq(spaceMemberships.spaceId, ctx.space.id),
                  eq(spaceMemberships.role, "owner"),
                ),
              )
          )[0]?.n ?? 0;
        if (ownerCount <= 1) {
          return reply
            .status(400)
            .send({ error: "Cannot demote the last owner of the space" });
        }
      }
      await db()
        .update(spaceMemberships)
        .set({ role: parsed.data.role })
        .where(
          and(
            eq(spaceMemberships.spaceId, ctx.space.id),
            eq(spaceMemberships.userId, userId),
          ),
        );
      return reply.status(204).send();
    },
  );

  /** Owner-only: remove a member. Last owner protected. Cascades shares. */
  app.delete("/spaces/:spaceId/members/:userId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { spaceId, userId } = request.params as {
      spaceId: string;
      userId: string;
    };
    const ctx = await requireSpaceManage(request, reply, auth, spaceId);
    if (!ctx) return;
    const targetRows = await db()
      .select()
      .from(spaceMemberships)
      .where(
        and(
          eq(spaceMemberships.spaceId, ctx.space.id),
          eq(spaceMemberships.userId, userId),
        ),
      )
      .limit(1);
    const target = targetRows[0];
    if (!target) {
      return reply.status(404).send({ error: "Member not found" });
    }
    if (target.role === "owner") {
      const ownerCount =
        (
          await db()
            .select({ n: count() })
            .from(spaceMemberships)
            .where(
              and(
                eq(spaceMemberships.spaceId, ctx.space.id),
                eq(spaceMemberships.role, "owner"),
              ),
            )
        )[0]?.n ?? 0;
      if (ownerCount <= 1) {
        return reply
          .status(400)
          .send({ error: "Cannot remove the last owner of the space" });
      }
    }
    await db()
      .delete(spaceMemberships)
      .where(
        and(
          eq(spaceMemberships.spaceId, ctx.space.id),
          eq(spaceMemberships.userId, userId),
        ),
      );
    // Phase 8: cascade workspace/project shares for the removed user within
    // this space so re-adding them later doesn't restore stale grants.
    const wsRows = await db()
      .select({ id: wpnWorkspaces.id })
      .from(wpnWorkspaces)
      .where(eq(wpnWorkspaces.spaceId, ctx.space.id));
    const wsIds = wsRows.map((w) => w.id);
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
    const projRows = await db()
      .select({ id: wpnProjects.id })
      .from(wpnProjects)
      .where(eq(wpnProjects.spaceId, ctx.space.id));
    const projIds = projRows.map((p) => p.id);
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
    return reply.status(204).send();
  });

  /** Switch active space. Re-issues access token. */
  app.post("/spaces/active", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const parsed = setActiveSpaceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const ctx = await requireSpaceMember(
      request,
      reply,
      auth,
      parsed.data.spaceId,
    );
    if (!ctx) return;
    if (!isUuid(auth.sub)) {
      return reply.status(401).send({ error: "Invalid session" });
    }
    // Persist the per-org pin alongside the global last-active. `/auth/refresh`
    // resolves the next access token's `activeSpaceId` from
    // `lastActiveSpaceByOrg[orgId]` *before* `lastActiveSpaceId` (Bug-0ae7ee),
    // so without this update an older pin for the same org would silently win
    // every refresh and revert the user's selection back to the default space.
    const userRows = await db()
      .select({ lastActiveSpaceByOrg: users.lastActiveSpaceByOrg })
      .from(users)
      .where(eq(users.id, auth.sub))
      .limit(1);
    const nextLastActiveSpaceByOrg = {
      ...((userRows[0]?.lastActiveSpaceByOrg as
        | Record<string, string>
        | null) ?? {}),
      [ctx.space.orgId]: ctx.space.id,
    };
    await db()
      .update(users)
      .set({
        lastActiveOrgId: ctx.space.orgId,
        lastActiveSpaceId: ctx.space.id,
        lastActiveSpaceByOrg: nextLastActiveSpaceByOrg,
      })
      .where(eq(users.id, auth.sub));
    const token = signAccessToken(jwtSecret, {
      sub: auth.sub,
      email: auth.email,
      ...(auth.activeOrgId
        ? { activeOrgId: auth.activeOrgId }
        : { activeOrgId: ctx.space.orgId }),
      activeSpaceId: ctx.space.id,
    });
    return reply.send({
      token,
      activeSpaceId: ctx.space.id,
      activeOrgId: ctx.space.orgId,
    });
  });

  /** List effective space memberships across all orgs (direct ∪ team grants). */
  app.get("/spaces/me", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const roleBySpace = await getEffectiveSpaceRoles(auth.sub);
    if (roleBySpace.size === 0) {
      return reply.send({ spaces: [], activeSpaceId: auth.activeSpaceId ?? null });
    }
    const spaceIds = [...roleBySpace.keys()];
    const spaceRows = await db()
      .select()
      .from(spaces)
      .where(inArray(spaces.id, spaceIds));
    return reply.send({
      spaces: spaceRows.map((s) => ({
        spaceId: s.id,
        orgId: s.orgId,
        name: s.name,
        kind: s.kind,
        role: roleBySpace.get(s.id) ?? "member",
      })),
      activeSpaceId: auth.activeSpaceId ?? null,
    });
  });

  /** Space-scoped workspace listing. */
  app.get("/spaces/:spaceId/workspaces", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { spaceId } = request.params as { spaceId: string };
    const ctx = await requireSpaceMember(request, reply, auth, spaceId);
    if (!ctx) return;
    const rows = await db()
      .select()
      .from(wpnWorkspaces)
      .where(eq(wpnWorkspaces.spaceId, ctx.space.id))
      .orderBy(asc(wpnWorkspaces.sort_index));
    return reply.send({
      workspaces: rows.map((r) => {
        const { userId, settings, ...pub } = r;
        void userId;
        void settings;
        return pub;
      }),
    });
  });

  // Suppress unused-import warning for sql template (kept for future raw queries).
  void sql;
}
