import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { requireAuth, signAccessToken } from "./auth.js";
import {
  getActiveDb,
  getOrgMembershipsCollection,
  getProjectSharesCollection,
  getSpaceMembershipsCollection,
  getSpacesCollection,
  getUsersCollection,
  getWorkspaceSharesCollection,
  getWpnProjectsCollection,
  getWpnWorkspacesCollection,
  type UserDoc,
} from "./db.js";
import { requireOrgRole } from "./org-auth.js";
import {
  addSpaceMemberBody,
  createSpaceBody,
  setActiveSpaceBody,
  setSpaceMemberRoleBody,
  updateSpaceBody,
  type SpaceDoc,
  type SpaceRole,
} from "./org-schemas.js";
import { recordAudit } from "./audit.js";
import { getEffectiveSpaceRoles } from "./permission-resolver.js";
import {
  requireSpaceManage,
  requireSpaceMember,
  requireSpaceRole,
} from "./space-auth.js";

function isObjectIdHex(s: string): boolean {
  return /^[a-f0-9]{24}$/i.test(s);
}

/** Central guard so every default-space protection uses the same error shape. */
function assertNotDefault(
  space: SpaceDoc,
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
  s: SpaceDoc,
  role: SpaceRole | null,
): Record<string, unknown> {
  return {
    spaceId: s._id.toHexString(),
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

  /**
   * List spaces in an org that the caller is a member of. Admins see all.
   * Hidden spaces are excluded by default for every caller; pass
   * `?includeHidden=true` to opt in (org admins only; others get 403).
   */
  app.get("/orgs/:orgId/spaces", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { orgId } = request.params as { orgId: string };
    const orgMember = await getOrgMembershipsCollection().findOne({
      orgId,
      userId: auth.sub,
    });
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
    const filter: Record<string, unknown> = { orgId };
    if (!includeHidden) {
      filter.$or = [{ hidden: { $exists: false } }, { hidden: false }];
    }
    const allSpaces = await getSpacesCollection().find(filter).toArray();
    const memberRoleBySpace = await getEffectiveSpaceRoles(auth.sub);
    const visible = allSpaces.filter((s) => {
      if (orgMember.role === "admin") return true;
      return memberRoleBySpace.has(s._id.toHexString());
    });
    return reply.send({
      spaces: visible.map((s) =>
        serializeSpace(s, memberRoleBySpace.get(s._id.toHexString()) ?? null),
      ),
    });
  });

  /** Any org member: create a Space inside an Org. Caller becomes Space Owner. */
  app.post("/orgs/:orgId/spaces", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { orgId } = request.params as { orgId: string };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "member");
    if (!ctx) {
      return;
    }
    const parsed = createSpaceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const ins = await getSpacesCollection().insertOne({
      orgId,
      name: parsed.data.name,
      kind: "normal",
      createdByUserId: auth.sub,
      createdAt: new Date(),
    } as never);
    const spaceIdHex = ins.insertedId.toHexString();
    await getSpaceMembershipsCollection().insertOne({
      spaceId: spaceIdHex,
      userId: auth.sub,
      role: "owner",
      addedByUserId: auth.sub,
      joinedAt: new Date(),
    } as never);
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      action: "space.create",
      targetType: "space",
      targetId: spaceIdHex,
      metadata: { name: parsed.data.name },
    });
    return reply.send({
      spaceId: spaceIdHex,
      orgId,
      name: parsed.data.name,
      kind: "normal",
      role: "owner" as SpaceRole,
    });
  });

  /**
   * Owner-or-org-admin: rename a Space and/or toggle hidden visibility.
   * - Rename: emits `space.rename` audit with {oldName, newName}; default space
   *   may be renamed.
   * - Hidden: soft-visibility flag; default space may NOT be hidden. Emits
   *   `space.hide` or `space.unhide` on transition.
   * Returns the updated space so the client can refresh without a second GET.
   */
  app.patch("/spaces/:spaceId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { spaceId } = request.params as { spaceId: string };
    const ctx = await requireSpaceManage(request, reply, auth, spaceId);
    if (!ctx) {
      return;
    }
    const parsed = updateSpaceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const before = ctx.space;
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, unknown> = {};
    let renamed: { oldName: string; newName: string } | null = null;
    let hideTransition: "hide" | "unhide" | null = null;

    if (parsed.data.name !== undefined && parsed.data.name !== before.name) {
      // Enforce per-org name uniqueness.
      const clash = await getSpacesCollection().findOne({
        orgId: before.orgId,
        name: parsed.data.name,
        _id: { $ne: before._id },
      });
      if (clash) {
        return reply
          .status(409)
          .send({ error: "A space with this name already exists", code: "name_conflict" });
      }
      $set.name = parsed.data.name;
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
          $set.hidden = true;
          $set.hiddenAt = new Date();
          $set.hiddenByUserId = auth.sub;
          hideTransition = "hide";
        } else {
          $set.hidden = false;
          $unset.hiddenAt = "";
          $unset.hiddenByUserId = "";
          hideTransition = "unhide";
        }
      }
    }

    if (
      Object.keys($set).length === 0 &&
      Object.keys($unset).length === 0
    ) {
      return reply
        .status(400)
        .send({ error: "No fields to update", code: "nothing_to_update" });
    }

    const update: Record<string, unknown> = {};
    if (Object.keys($set).length > 0) update.$set = $set;
    if (Object.keys($unset).length > 0) update.$unset = $unset;
    const after = (await getSpacesCollection().findOneAndUpdate(
      { _id: before._id },
      update,
      { returnDocument: "after" },
    )) as SpaceDoc | null;
    if (!after) {
      return reply.status(404).send({ error: "Space not found" });
    }

    if (renamed) {
      await recordAudit({
        orgId: before.orgId,
        actorUserId: auth.sub,
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
        action: hideTransition === "hide" ? "space.hide" : "space.unhide",
        targetType: "space",
        targetId: spaceId,
        metadata: null,
      });
    }

    return reply.send(serializeSpace(after, ctx.role));
  });

  /**
   * Owner-or-org-admin: delete a Space. Refuses to delete the org's default
   * space, or any space that still has WPN content (workspaces) — caller must
   * move/delete workspaces first. Cascades the membership rows. Emits a
   * `space.delete` audit row on success.
   *
   * Narrows (but does not fully close) the add-workspace race by counting once
   * up-front and again immediately before the space delete.
   */
  app.delete("/spaces/:spaceId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { spaceId } = request.params as { spaceId: string };
    const ctx = await requireSpaceManage(request, reply, auth, spaceId);
    if (!ctx) {
      return;
    }
    const guard = assertNotDefault(ctx.space, "delete");
    if (guard) {
      return reply.status(guard.status).send(guard.body);
    }
    const workspaces = getActiveDb().collection("wpn_workspaces");
    const wsCount = await workspaces.countDocuments({ spaceId });
    if (wsCount > 0) {
      return reply.status(409).send({
        error: "Space still has workspaces; move or delete them first",
        code: "space_not_empty",
      });
    }
    await getSpaceMembershipsCollection().deleteMany({ spaceId });
    // Re-check right before the space delete to narrow the window where a
    // workspace could be inserted between the initial count and here.
    const wsCountPre = await workspaces.countDocuments({ spaceId });
    if (wsCountPre > 0) {
      return reply.status(409).send({
        error: "Space still has workspaces; move or delete them first",
        code: "space_not_empty",
      });
    }
    await getSpacesCollection().deleteOne({ _id: new ObjectId(spaceId) });
    await recordAudit({
      orgId: ctx.space.orgId,
      actorUserId: auth.sub,
      action: "space.delete",
      targetType: "space",
      targetId: spaceId,
      metadata: { name: ctx.space.name },
    });
    return reply.status(204).send();
  });

  /** List members of a Space. Any space member may read this list. */
  app.get("/spaces/:spaceId/members", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { spaceId } = request.params as { spaceId: string };
    const ctx = await requireSpaceMember(request, reply, auth, spaceId);
    if (!ctx) {
      return;
    }
    const rows = await getSpaceMembershipsCollection()
      .find({ spaceId })
      .toArray();
    const userIds = rows.map((r) => r.userId).filter(isObjectIdHex);
    const users = (await getUsersCollection()
      .find({ _id: { $in: userIds.map((u) => new ObjectId(u)) } })
      .toArray()) as UserDoc[];
    const usersById = new Map(users.map((u) => [u._id.toHexString(), u]));
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

  /** Owner-only: add an existing org member to a Space. */
  app.post("/spaces/:spaceId/members", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { spaceId } = request.params as { spaceId: string };
    const ctx = await requireSpaceManage(request, reply, auth, spaceId);
    if (!ctx) {
      return;
    }
    const parsed = addSpaceMemberBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const isOrgMember = await getOrgMembershipsCollection().findOne({
      orgId: ctx.space.orgId,
      userId: parsed.data.userId,
    });
    if (!isOrgMember) {
      return reply
        .status(400)
        .send({ error: "User must be a member of the parent organization" });
    }
    await getSpaceMembershipsCollection().updateOne(
      { spaceId, userId: parsed.data.userId },
      {
        $setOnInsert: {
          spaceId,
          userId: parsed.data.userId,
          role: parsed.data.role,
          addedByUserId: auth.sub,
          joinedAt: new Date(),
        },
      },
      { upsert: true },
    );
    await recordAudit({
      orgId: ctx.space.orgId,
      actorUserId: auth.sub,
      action: "space.member.add",
      targetType: "space_membership",
      targetId: parsed.data.userId,
      metadata: { spaceId, role: parsed.data.role },
    });
    return reply.status(204).send();
  });

  /** Owner-only: change a member's role. Last owner cannot demote themselves. */
  app.patch(
    "/spaces/:spaceId/members/:userId/role",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) {
        return;
      }
      const { spaceId, userId } = request.params as {
        spaceId: string;
        userId: string;
      };
      const ctx = await requireSpaceManage(request, reply, auth, spaceId);
      if (!ctx) {
        return;
      }
      const parsed = setSpaceMemberRoleBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const target = await getSpaceMembershipsCollection().findOne({
        spaceId,
        userId,
      });
      if (!target) {
        return reply.status(404).send({ error: "Member not found" });
      }
      if (
        target.role === "owner" &&
        parsed.data.role !== "owner" &&
        target.userId === auth.sub
      ) {
        const ownerCount = await getSpaceMembershipsCollection().countDocuments({
          spaceId,
          role: "owner",
        });
        if (ownerCount <= 1) {
          return reply
            .status(400)
            .send({ error: "Cannot demote the last owner of the space" });
        }
      }
      await getSpaceMembershipsCollection().updateOne(
        { _id: target._id },
        { $set: { role: parsed.data.role } },
      );
      return reply.status(204).send();
    },
  );

  /** Owner-only: remove a member from a Space (last owner protected). */
  app.delete(
    "/spaces/:spaceId/members/:userId",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) {
        return;
      }
      const { spaceId, userId } = request.params as {
        spaceId: string;
        userId: string;
      };
      const ctx = await requireSpaceManage(request, reply, auth, spaceId);
      if (!ctx) {
        return;
      }
      const target = await getSpaceMembershipsCollection().findOne({
        spaceId,
        userId,
      });
      if (!target) {
        return reply.status(404).send({ error: "Member not found" });
      }
      if (target.role === "owner") {
        const ownerCount = await getSpaceMembershipsCollection().countDocuments({
          spaceId,
          role: "owner",
        });
        if (ownerCount <= 1) {
          return reply
            .status(400)
            .send({ error: "Cannot remove the last owner of the space" });
        }
      }
      await getSpaceMembershipsCollection().deleteOne({ _id: target._id });
      // Phase 8: cascade — drop any workspace/project share rows the removed
      // user held within this space, so there are no orphaned grants that
      // become active if they're re-added later.
      const wsIds = (
        await getWpnWorkspacesCollection()
          .find({ spaceId }, { projection: { id: 1 } })
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
          .find({ spaceId }, { projection: { id: 1 } })
          .toArray()
      ).map((p) => p.id);
      if (projIds.length > 0) {
        await getProjectSharesCollection().deleteMany({
          userId,
          projectId: { $in: projIds },
        });
      }
      return reply.status(204).send();
    },
  );

  /** Switch active space context. Re-issues the access token. */
  app.post("/spaces/active", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
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
    if (!ctx) {
      return;
    }
    await getUsersCollection().updateOne(
      { _id: new ObjectId(auth.sub) },
      {
        $set: {
          lastActiveOrgId: ctx.space.orgId,
          lastActiveSpaceId: parsed.data.spaceId,
        },
      },
    );
    const token = signAccessToken(jwtSecret, {
      sub: auth.sub,
      email: auth.email,
      ...(auth.activeOrgId ? { activeOrgId: auth.activeOrgId } : { activeOrgId: ctx.space.orgId }),
      activeSpaceId: parsed.data.spaceId,
    });
    return reply.send({
      token,
      activeSpaceId: parsed.data.spaceId,
      activeOrgId: ctx.space.orgId,
    });
  });

  /** List effective space memberships across all orgs (direct ∪ team grants). */
  app.get("/spaces/me", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const roleBySpace = await getEffectiveSpaceRoles(auth.sub);
    if (roleBySpace.size === 0) {
      return reply.send({ spaces: [], activeSpaceId: auth.activeSpaceId ?? null });
    }
    const spaceIds = [...roleBySpace.keys()].filter(isObjectIdHex);
    const spaces = await getSpacesCollection()
      .find({ _id: { $in: spaceIds.map((s) => new ObjectId(s)) } })
      .toArray();
    return reply.send({
      spaces: spaces.map((s) => ({
        spaceId: s._id.toHexString(),
        orgId: s.orgId,
        name: s.name,
        kind: s.kind,
        role: roleBySpace.get(s._id.toHexString()) ?? "member",
      })),
      activeSpaceId: auth.activeSpaceId ?? null,
    });
  });

  /**
   * Space-scoped workspace listing — filters wpn_workspaces by spaceId and
   * enforces space membership. Phase 2 forward path; legacy `/wpn/workspaces`
   * remains userId-scoped for back-compat until Phase 4 lockdown.
   */
  app.get("/spaces/:spaceId/workspaces", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { spaceId } = request.params as { spaceId: string };
    const ctx = await requireSpaceMember(request, reply, auth, spaceId);
    if (!ctx) {
      return;
    }
    const rows = await getActiveDb()
      .collection("wpn_workspaces")
      .find({ spaceId })
      .sort({ sort_index: 1 })
      .toArray();
    return reply.send({
      workspaces: rows.map((r) => {
        const { _id, userId, settings, ...pub } = r as Record<string, unknown> & {
          _id: unknown;
        };
        return pub;
      }),
    });
  });
}
