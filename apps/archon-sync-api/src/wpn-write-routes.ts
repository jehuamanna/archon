import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { requireAuth } from "./auth.js";
import { getDb } from "./pg.js";
import {
  orgMemberships,
  projectShares,
  spaceMemberships,
  users,
  workspaceShares,
  wpnNotes,
  wpnProjects,
  wpnWorkspaces,
} from "./db/schema.js";
import { recordAudit } from "./audit.js";
import { resolveActiveOrgId } from "./org-auth.js";
import {
  ensureDefaultSpaceForOrg,
  ensureUserHasDefaultOrg,
} from "./org-defaults.js";
import {
  addProjectShareBody,
  addWorkspaceShareBody,
  moveWorkspaceToSpaceBody,
  setProjectVisibilityBody,
  setWorkspaceVisibilityBody,
  updateProjectShareBody,
  updateWorkspaceShareBody,
} from "./org-schemas.js";
import {
  assertCanManageProject,
  assertCanManageWorkspace,
  assertCanReadProject,
  assertCanReadWorkspace,
  assertCanWriteProject,
  assertCanWriteWorkspace,
  assertCanWriteWorkspaceForNote,
  getEffectiveSpaceRoles,
  userCanReadWorkspace,
} from "./permission-resolver.js";
import {
  getSpaceMembership,
  requireSpaceManage,
  resolveActiveSpaceId,
} from "./space-auth.js";
import {
  vfsCanonicalPathsForTitleChange,
  rewriteMarkdownForWpnNoteTitleChange,
  normalizeVfsSegment,
} from "./wpn-vfs-rewrite.js";
import {
  pgWpnCreateNote,
  pgWpnCreateProject,
  pgWpnCreateWorkspace,
  pgWpnDeleteNotes,
  pgWpnDeleteProject,
  pgWpnDeleteProjects,
  pgWpnDeleteWorkspace,
  pgWpnDeleteWorkspaces,
  pgWpnDuplicateProject,
  pgWpnDuplicateSubtree,
  pgWpnDuplicateWorkspace,
  pgWpnGetProjectSettings,
  pgWpnGetWorkspaceSettings,
  pgWpnMoveNote,
  pgWpnMoveNoteToProject,
  pgWpnPatchProjectSettings,
  pgWpnPatchWorkspaceSettings,
  pgWpnReassignWorkspaceSpace,
  pgWpnSetExplorerExpanded,
  pgWpnUpdateNote,
  WpnDuplicateSiblingTitleError,
  WPN_DUPLICATE_NOTE_TITLE_MESSAGE,
  pgWpnUpdateProject,
  pgWpnUpdateWorkspace,
} from "./wpn-pg-writes.js";
import type { NoteMovePlacement } from "./wpn-tree.js";
import { isUuid } from "./db/legacy-id-map.js";

function sendWpnError(reply: FastifyReply, e: unknown, fallbackStatus = 503) {
  const msg = e instanceof Error ? e.message : String(e);
  const status =
    /required|Invalid anchor|Invalid relation|Anchor note not found|Cannot move/i.test(
      msg,
    )
      ? 400
      : fallbackStatus;
  return reply.status(status).send({ error: msg });
}

/**
 * Resolve the (orgId, spaceId) scope for a write request: header → JWT
 * claim → caller's defaultOrgId/space.
 */
async function resolveActiveScope(
  request: import("fastify").FastifyRequest,
  auth: import("./auth.js").JwtPayload,
): Promise<{ orgId?: string; spaceId?: string }> {
  const orgId = resolveActiveOrgId(request, auth);
  const headerSpaceId = resolveActiveSpaceId(request, auth);
  if (orgId && headerSpaceId) {
    const m = await getSpaceMembership(auth.sub, headerSpaceId);
    if (m) return { orgId, spaceId: headerSpaceId };
    return {};
  }
  let resolvedOrgId = orgId;
  if (!resolvedOrgId) {
    if (!isUuid(auth.sub)) return {};
    const userRows = await getDb()
      .select({ email: users.email, defaultOrgId: users.defaultOrgId })
      .from(users)
      .where(eq(users.id, auth.sub))
      .limit(1);
    const user = userRows[0];
    if (!user) return {};
    if (user.defaultOrgId) {
      resolvedOrgId = user.defaultOrgId;
    } else {
      const ensured = await ensureUserHasDefaultOrg(auth.sub, user.email);
      resolvedOrgId = ensured.orgId;
    }
  }
  if (!resolvedOrgId) return {};
  const ensuredSpace = await ensureDefaultSpaceForOrg(resolvedOrgId, auth.sub).catch(
    () => null,
  );
  if (!ensuredSpace) return { orgId: resolvedOrgId };
  return { orgId: resolvedOrgId, spaceId: ensuredSpace.spaceId };
}

export function registerWpnWriteRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;
  const db = (): ReturnType<typeof getDb> => getDb();

  app.post("/wpn/workspaces", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const name =
      typeof (request.body as { name?: unknown })?.name === "string"
        ? (request.body as { name: string }).name
        : "Workspace";
    try {
      const scope = await resolveActiveScope(request, auth);
      const workspace = await pgWpnCreateWorkspace(auth.sub, name, scope);
      return reply.status(201).send({ workspace });
    } catch (e) {
      return sendWpnError(reply, e);
    }
  });

  app.patch("/wpn/workspaces/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const ws = await assertCanWriteWorkspace(reply, auth, id);
    if (!ws) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const patch: {
      name?: string;
      sort_index?: number;
      color_token?: string | null;
    } = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.sort_index === "number") patch.sort_index = body.sort_index;
    if (body.color_token === null || typeof body.color_token === "string") {
      patch.color_token = body.color_token as string | null;
    }
    const workspace = await pgWpnUpdateWorkspace(ws.userId, id, patch);
    if (!workspace) {
      return reply.status(404).send({ error: "Workspace not found" });
    }
    return reply.send({ workspace });
  });

  app.delete("/wpn/workspaces/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const ws = await assertCanWriteWorkspace(reply, auth, id);
    if (!ws) return;
    const projIdRows = await db()
      .select({ id: wpnProjects.id })
      .from(wpnProjects)
      .where(
        and(eq(wpnProjects.userId, ws.userId), eq(wpnProjects.workspace_id, id)),
      );
    const projIds = projIdRows.map((p) => p.id);
    const ok = await pgWpnDeleteWorkspace(ws.userId, id);
    if (!ok) {
      return reply.status(404).send({ error: "Workspace not found" });
    }
    await db()
      .delete(workspaceShares)
      .where(eq(workspaceShares.workspaceId, id));
    if (projIds.length > 0) {
      await db()
        .delete(projectShares)
        .where(inArray(projectShares.projectId, projIds));
    }
    return reply.send({ ok: true as const });
  });

  /** Bulk workspace delete. */
  app.post("/wpn/workspaces/delete", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const rawIds = Array.isArray(body.ids) ? (body.ids as unknown[]) : [];
    const ids = rawIds.filter(
      (x): x is string => typeof x === "string" && x.length > 0,
    );
    if (ids.length === 0) {
      return reply.send({ deleted: [], denied: [], notFound: [] });
    }
    const rows = await db()
      .select()
      .from(wpnWorkspaces)
      .where(inArray(wpnWorkspaces.id, ids));
    const seenIds = new Set(rows.map((r) => r.id));
    const notFound = ids.filter((i) => !seenIds.has(i));

    const spaceRoles = await getEffectiveSpaceRoles(auth.sub);
    const orgIds = Array.from(
      new Set(
        rows.map((r) => r.orgId).filter((x): x is string => typeof x === "string"),
      ),
    );
    const memberships = orgIds.length
      ? await db()
          .select()
          .from(orgMemberships)
          .where(
            and(
              eq(orgMemberships.userId, auth.sub),
              inArray(orgMemberships.orgId, orgIds),
            ),
          )
      : [];
    const adminOrgs = new Set(
      memberships.filter((m) => m.role === "admin").map((m) => m.orgId),
    );

    const deletableByUser = new Map<string, string[]>();
    const denied: string[] = [];
    for (const ws of rows) {
      if (!ws.spaceId) {
        if (ws.userId !== auth.sub) {
          denied.push(ws.id);
          continue;
        }
      } else {
        const isOrgAdmin = ws.orgId ? adminOrgs.has(ws.orgId) : false;
        const role = spaceRoles.get(ws.spaceId);
        const isSpaceOwner = role === "owner";
        const creator = ws.creatorUserId ?? ws.userId;
        const isCreator = creator === auth.sub;
        if (!(isOrgAdmin || isSpaceOwner || isCreator)) {
          denied.push(ws.id);
          continue;
        }
        if (role === "viewer" && !isOrgAdmin && !isCreator) {
          denied.push(ws.id);
          continue;
        }
      }
      const list = deletableByUser.get(ws.userId) ?? [];
      list.push(ws.id);
      deletableByUser.set(ws.userId, list);
    }
    const toDeleteWsIds = Array.from(
      new Set(Array.from(deletableByUser.values()).flat()),
    );
    const projIds = toDeleteWsIds.length
      ? (
          await db()
            .select({ id: wpnProjects.id })
            .from(wpnProjects)
            .where(inArray(wpnProjects.workspace_id, toDeleteWsIds))
        ).map((p) => p.id)
      : [];
    const deleted: string[] = [];
    for (const [userId, idList] of deletableByUser) {
      const r = await pgWpnDeleteWorkspaces(userId, idList);
      deleted.push(...r.deletedWorkspaceIds);
    }
    if (deleted.length > 0) {
      await db()
        .delete(workspaceShares)
        .where(inArray(workspaceShares.workspaceId, deleted));
    }
    if (projIds.length > 0) {
      await db()
        .delete(projectShares)
        .where(inArray(projectShares.projectId, projIds));
    }
    return reply.send({ deleted, denied, notFound });
  });

  /** Phase 4/8 — set workspace visibility. */
  app.patch("/wpn/workspaces/:id/visibility", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const ws = await assertCanManageWorkspace(reply, auth, id);
    if (!ws) return;
    const parsed = setWorkspaceVisibilityBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const set: Record<string, unknown> = {
      visibility: parsed.data.visibility,
      updated_at_ms: Date.now(),
    };
    if (!ws.creatorUserId) set.creatorUserId = ws.userId;
    await db().update(wpnWorkspaces).set(set).where(eq(wpnWorkspaces.id, id));
    if (parsed.data.visibility !== "shared") {
      await db()
        .delete(workspaceShares)
        .where(eq(workspaceShares.workspaceId, id));
    }
    if (ws.orgId) {
      await recordAudit({
        orgId: ws.orgId,
        actorUserId: auth.sub,
        action: "workspace.visibility.set",
        targetType: "workspace",
        targetId: id,
        metadata: { from: ws.visibility ?? "public", to: parsed.data.visibility },
      });
    }
    return reply.send({ id, visibility: parsed.data.visibility });
  });

  /** Move workspace into a different space within the same org. */
  app.patch("/wpn/workspaces/:id/space", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const ws = await assertCanManageWorkspace(reply, auth, id);
    if (!ws) return;
    const parsed = moveWorkspaceToSpaceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { targetSpaceId } = parsed.data;
    if (ws.spaceId === targetSpaceId) {
      return reply
        .status(400)
        .send({ error: "Workspace is already in the target space" });
    }
    const ctx = await requireSpaceManage(request, reply, auth, targetSpaceId);
    if (!ctx) return;
    if (ws.orgId && ctx.space.orgId !== ws.orgId) {
      return reply
        .status(400)
        .send({ error: "Target space must belong to the same org as the workspace" });
    }
    const workspace = await pgWpnReassignWorkspaceSpace(id, targetSpaceId);
    if (!workspace) {
      return reply.status(404).send({ error: "Workspace not found" });
    }
    if (ws.orgId) {
      await recordAudit({
        orgId: ws.orgId,
        actorUserId: auth.sub,
        action: "workspace.move_to_space",
        targetType: "workspace",
        targetId: id,
        metadata: {
          fromSpaceId: ws.spaceId ?? null,
          toSpaceId: targetSpaceId,
        },
      });
    }
    return reply.send({ workspace });
  });

  /** List shares on a workspace. */
  app.get("/wpn/workspaces/:id/shares", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const ws = await assertCanReadWorkspace(reply, auth, id);
    if (!ws) return;
    const shares = await db()
      .select()
      .from(workspaceShares)
      .where(eq(workspaceShares.workspaceId, id));
    const userIds = shares.map((s) => s.userId).filter(isUuid);
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
      shares: shares.map((s) => {
        const u = usersById.get(s.userId);
        return {
          userId: s.userId,
          email: u?.email ?? "(unknown)",
          displayName: u?.displayName ?? null,
          role: s.role ?? "reader",
          addedAt: s.addedAt,
        };
      }),
    });
  });

  /** Grant explicit read or write on a `shared` workspace. */
  app.post("/wpn/workspaces/:id/shares", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const ws = await assertCanManageWorkspace(reply, auth, id);
    if (!ws) return;
    const parsed = addWorkspaceShareBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    if (!ws.spaceId) {
      return reply.status(400).send({
        error: "Workspace is legacy single-tenant; assign to a space first",
      });
    }
    const orgMember = ws.orgId
      ? (
          await db()
            .select({ id: orgMemberships.userId })
            .from(orgMemberships)
            .where(
              and(
                eq(orgMemberships.orgId, ws.orgId),
                eq(orgMemberships.userId, parsed.data.userId),
              ),
            )
            .limit(1)
        )[0]
      : null;
    const spaceMember = (
      await db()
        .select({ id: spaceMemberships.userId })
        .from(spaceMemberships)
        .where(
          and(
            eq(spaceMemberships.spaceId, ws.spaceId),
            eq(spaceMemberships.userId, parsed.data.userId),
          ),
        )
        .limit(1)
    )[0];
    if (!orgMember || !spaceMember) {
      return reply.status(400).send({
        error: "Target user must be a member of the workspace's space",
      });
    }
    const shareId = randomUUID();
    await db()
      .insert(workspaceShares)
      .values({
        id: shareId,
        workspaceId: id,
        userId: parsed.data.userId,
        role: parsed.data.role,
        addedByUserId: auth.sub,
        addedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [workspaceShares.workspaceId, workspaceShares.userId],
        set: { role: parsed.data.role },
      });
    if (ws.orgId) {
      await recordAudit({
        orgId: ws.orgId,
        actorUserId: auth.sub,
        action: "workspace.share.add",
        targetType: "workspace",
        targetId: id,
        metadata: { userId: parsed.data.userId, role: parsed.data.role },
      });
    }
    return reply.status(204).send();
  });

  /** Change a workspace share's role. */
  app.patch(
    "/wpn/workspaces/:id/shares/:userId",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { id, userId } = request.params as { id: string; userId: string };
      const ws = await assertCanManageWorkspace(reply, auth, id);
      if (!ws) return;
      const parsed = updateWorkspaceShareBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const result = await db()
        .update(workspaceShares)
        .set({ role: parsed.data.role })
        .where(
          and(
            eq(workspaceShares.workspaceId, id),
            eq(workspaceShares.userId, userId),
          ),
        )
        .returning({ id: workspaceShares.id });
      if (result.length === 0) {
        return reply.status(404).send({ error: "Share not found" });
      }
      if (ws.orgId) {
        await recordAudit({
          orgId: ws.orgId,
          actorUserId: auth.sub,
          action: "workspace.share.update",
          targetType: "workspace",
          targetId: id,
          metadata: { userId, role: parsed.data.role },
        });
      }
      return reply.status(204).send();
    },
  );

  /** Revoke an explicit workspace share. */
  app.delete(
    "/wpn/workspaces/:id/shares/:userId",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { id, userId } = request.params as { id: string; userId: string };
      const ws = await assertCanManageWorkspace(reply, auth, id);
      if (!ws) return;
      const result = await db()
        .delete(workspaceShares)
        .where(
          and(
            eq(workspaceShares.workspaceId, id),
            eq(workspaceShares.userId, userId),
          ),
        )
        .returning({ id: workspaceShares.id });
      if (result.length === 0) {
        return reply.status(404).send({ error: "Share not found" });
      }
      if (ws.orgId) {
        await recordAudit({
          orgId: ws.orgId,
          actorUserId: auth.sub,
          action: "workspace.share.remove",
          targetType: "workspace",
          targetId: id,
          metadata: { userId },
        });
      }
      return reply.status(204).send();
    },
  );

  /** Set project visibility. */
  app.patch("/wpn/projects/:id/visibility", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const manageResult = await assertCanManageProject(reply, auth, id);
    if (!manageResult) return;
    const { workspace: ws, project } = manageResult;
    const parsed = setProjectVisibilityBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const set: Record<string, unknown> = {
      visibility: parsed.data.visibility,
      updated_at_ms: Date.now(),
    };
    if (!project.creatorUserId) set.creatorUserId = project.userId;
    await db().update(wpnProjects).set(set).where(eq(wpnProjects.id, id));
    if (parsed.data.visibility !== "shared") {
      await db()
        .delete(projectShares)
        .where(eq(projectShares.projectId, id));
    }
    if (ws.orgId) {
      await recordAudit({
        orgId: ws.orgId,
        actorUserId: auth.sub,
        action: "project.visibility.set",
        targetType: "project",
        targetId: id,
        metadata: {
          from: project.visibility ?? "public",
          to: parsed.data.visibility,
        },
      });
    }
    return reply.send({ id, visibility: parsed.data.visibility });
  });

  /** List shares on a project. */
  app.get("/wpn/projects/:id/shares", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const readResult = await assertCanReadProject(reply, auth, id);
    if (!readResult) return;
    const shares = await db()
      .select()
      .from(projectShares)
      .where(eq(projectShares.projectId, id));
    const userIds = shares.map((s) => s.userId).filter(isUuid);
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
      shares: shares.map((s) => {
        const u = usersById.get(s.userId);
        return {
          userId: s.userId,
          email: u?.email ?? "(unknown)",
          displayName: u?.displayName ?? null,
          role: s.role ?? "reader",
          addedAt: s.addedAt,
        };
      }),
    });
  });

  /** Grant explicit read or write on a `shared` project. */
  app.post("/wpn/projects/:id/shares", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const manageResult = await assertCanManageProject(reply, auth, id);
    if (!manageResult) return;
    const { workspace: ws } = manageResult;
    const parsed = addProjectShareBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    if (!ws.spaceId) {
      return reply
        .status(400)
        .send({ error: "Project's workspace is legacy single-tenant" });
    }
    const targetReachable = await userCanReadWorkspace(parsed.data.userId, ws.id);
    if (!targetReachable) {
      return reply.status(400).send({
        error: "Target user must have access to the parent workspace first",
      });
    }
    const shareId = randomUUID();
    await db()
      .insert(projectShares)
      .values({
        id: shareId,
        projectId: id,
        userId: parsed.data.userId,
        role: parsed.data.role,
        addedByUserId: auth.sub,
        addedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [projectShares.projectId, projectShares.userId],
        set: { role: parsed.data.role },
      });
    if (ws.orgId) {
      await recordAudit({
        orgId: ws.orgId,
        actorUserId: auth.sub,
        action: "project.share.add",
        targetType: "project",
        targetId: id,
        metadata: { userId: parsed.data.userId, role: parsed.data.role },
      });
    }
    return reply.status(204).send();
  });

  /** Change project share role. */
  app.patch(
    "/wpn/projects/:id/shares/:userId",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { id, userId } = request.params as { id: string; userId: string };
      const manageResult = await assertCanManageProject(reply, auth, id);
      if (!manageResult) return;
      const { workspace: ws } = manageResult;
      const parsed = updateProjectShareBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const result = await db()
        .update(projectShares)
        .set({ role: parsed.data.role })
        .where(
          and(
            eq(projectShares.projectId, id),
            eq(projectShares.userId, userId),
          ),
        )
        .returning({ id: projectShares.id });
      if (result.length === 0) {
        return reply.status(404).send({ error: "Share not found" });
      }
      if (ws.orgId) {
        await recordAudit({
          orgId: ws.orgId,
          actorUserId: auth.sub,
          action: "project.share.update",
          targetType: "project",
          targetId: id,
          metadata: { userId, role: parsed.data.role },
        });
      }
      return reply.status(204).send();
    },
  );

  /** Revoke an explicit project share. */
  app.delete(
    "/wpn/projects/:id/shares/:userId",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { id, userId } = request.params as { id: string; userId: string };
      const manageResult = await assertCanManageProject(reply, auth, id);
      if (!manageResult) return;
      const { workspace: ws } = manageResult;
      const result = await db()
        .delete(projectShares)
        .where(
          and(
            eq(projectShares.projectId, id),
            eq(projectShares.userId, userId),
          ),
        )
        .returning({ id: projectShares.id });
      if (result.length === 0) {
        return reply.status(404).send({ error: "Share not found" });
      }
      if (ws.orgId) {
        await recordAudit({
          orgId: ws.orgId,
          actorUserId: auth.sub,
          action: "project.share.remove",
          targetType: "project",
          targetId: id,
          metadata: { userId },
        });
      }
      return reply.status(204).send();
    },
  );

  app.post("/wpn/workspaces/:workspaceId/projects", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { workspaceId } = request.params as { workspaceId: string };
    const ws = await assertCanWriteWorkspace(reply, auth, workspaceId);
    if (!ws) return;
    const name =
      typeof (request.body as { name?: unknown })?.name === "string"
        ? (request.body as { name: string }).name
        : "Project";
    const project = await pgWpnCreateProject(ws.userId, workspaceId, name, {
      creatorUserId: auth.sub,
    });
    if (!project) {
      return reply.status(404).send({ error: "Workspace not found" });
    }
    return reply.status(201).send({ project });
  });

  app.patch("/wpn/projects/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const writeResult = await assertCanWriteProject(reply, auth, id);
    if (!writeResult) return;
    const { workspace: ws } = writeResult;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const patch: {
      name?: string;
      sort_index?: number;
      color_token?: string | null;
      workspace_id?: string;
    } = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.sort_index === "number") patch.sort_index = body.sort_index;
    if (body.color_token === null || typeof body.color_token === "string") {
      patch.color_token = body.color_token as string | null;
    }
    if (typeof body.workspace_id === "string") {
      patch.workspace_id = body.workspace_id;
    }
    if (patch.workspace_id !== undefined && patch.workspace_id !== ws.id) {
      const targetWs = await assertCanWriteWorkspace(
        reply,
        auth,
        patch.workspace_id,
      );
      if (!targetWs) return;
      if ((targetWs.orgId ?? null) !== (ws.orgId ?? null)) {
        return reply
          .status(400)
          .send({ error: "Cross-org project moves are not supported" });
      }
      if ((targetWs.spaceId ?? null) !== (ws.spaceId ?? null)) {
        return reply.status(400).send({
          error:
            "Cross-space project moves go through PATCH /wpn/workspaces/:id/space",
        });
      }
    }
    const project = await pgWpnUpdateProject(ws.userId, id, patch);
    if (!project) {
      return reply.status(404).send({ error: "Project not found" });
    }
    return reply.send({ project });
  });

  /** Duplicate project. */
  app.post("/wpn/projects/:id/duplicate", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const writeResult = await assertCanWriteProject(reply, auth, id);
    if (!writeResult) return;
    const { workspace: srcWs, project: srcProj } = writeResult;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const targetWorkspaceIdRaw =
      typeof body.targetWorkspaceId === "string"
        ? body.targetWorkspaceId.trim()
        : "";
    const newNameRaw = typeof body.newName === "string" ? body.newName : "";
    const targetWorkspaceId =
      targetWorkspaceIdRaw.length > 0 ? targetWorkspaceIdRaw : srcWs.id;

    let targetWs = srcWs;
    if (targetWorkspaceId !== srcWs.id) {
      const ws = await assertCanWriteWorkspace(reply, auth, targetWorkspaceId);
      if (!ws) return;
      if ((ws.orgId ?? null) !== (srcWs.orgId ?? null)) {
        return reply
          .status(400)
          .send({ error: "Cross-org project duplicates are not supported" });
      }
      if ((ws.spaceId ?? null) !== (srcWs.spaceId ?? null)) {
        return reply.status(400).send({
          error: "Target workspace must be in the same space as the source",
        });
      }
      targetWs = ws;
    }

    try {
      const result = await pgWpnDuplicateProject(targetWs.userId, id, {
        targetWorkspaceId,
        newName: newNameRaw.trim() || undefined,
        creatorUserId: auth.sub,
      });
      return reply.status(201).send(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "Project not found") {
        return reply.status(404).send({ error: msg });
      }
      void srcProj;
      return sendWpnError(reply, e, 400);
    }
  });

  /** Duplicate workspace. */
  app.post("/wpn/workspaces/:id/duplicate", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const srcWs = await assertCanManageWorkspace(reply, auth, id);
    if (!srcWs) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const newNameRaw = typeof body.newName === "string" ? body.newName : "";
    const targetSpaceIdRaw =
      typeof body.targetSpaceId === "string" ? body.targetSpaceId.trim() : "";
    const targetSpaceId =
      targetSpaceIdRaw.length > 0 ? targetSpaceIdRaw : srcWs.spaceId ?? null;

    if (targetSpaceId && targetSpaceId !== (srcWs.spaceId ?? null)) {
      const ctx = await requireSpaceManage(request, reply, auth, targetSpaceId);
      if (!ctx) return;
      if (srcWs.orgId && ctx.space.orgId !== srcWs.orgId) {
        return reply
          .status(400)
          .send({ error: "Cross-org workspace duplicates are not supported" });
      }
    }

    try {
      const result = await pgWpnDuplicateWorkspace(srcWs.userId, id, {
        targetSpaceId: targetSpaceId ?? undefined,
        newName: newNameRaw.trim() || undefined,
        creatorUserId: auth.sub,
      });
      return reply.status(201).send(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "Workspace not found") {
        return reply.status(404).send({ error: msg });
      }
      return sendWpnError(reply, e, 400);
    }
  });

  app.delete("/wpn/projects/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const writeResult = await assertCanWriteProject(reply, auth, id);
    if (!writeResult) return;
    const { workspace: ws } = writeResult;
    const ok = await pgWpnDeleteProject(ws.userId, id);
    if (!ok) {
      return reply.status(404).send({ error: "Project not found" });
    }
    await db().delete(projectShares).where(eq(projectShares.projectId, id));
    return reply.send({ ok: true as const });
  });

  /** Bulk project delete. */
  app.post("/wpn/projects/delete", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const rawIds = Array.isArray(body.ids) ? (body.ids as unknown[]) : [];
    const ids = rawIds.filter(
      (x): x is string => typeof x === "string" && x.length > 0,
    );
    if (ids.length === 0) {
      return reply.send({ deleted: [], denied: [], notFound: [] });
    }
    const projects = await db()
      .select()
      .from(wpnProjects)
      .where(inArray(wpnProjects.id, ids));
    const seenIds = new Set(projects.map((p) => p.id));
    const notFound = ids.filter((i) => !seenIds.has(i));
    if (projects.length === 0) {
      return reply.send({ deleted: [], denied: [], notFound });
    }
    const wsIds = Array.from(new Set(projects.map((p) => p.workspace_id)));
    const wsRows = await db()
      .select()
      .from(wpnWorkspaces)
      .where(inArray(wpnWorkspaces.id, wsIds));
    const wsById = new Map(wsRows.map((w) => [w.id, w] as const));
    const spaceRoles = await getEffectiveSpaceRoles(auth.sub);
    const orgIds = Array.from(
      new Set(
        wsRows
          .map((w) => w.orgId)
          .filter((x): x is string => typeof x === "string"),
      ),
    );
    const memberships = orgIds.length
      ? await db()
          .select()
          .from(orgMemberships)
          .where(
            and(
              eq(orgMemberships.userId, auth.sub),
              inArray(orgMemberships.orgId, orgIds),
            ),
          )
      : [];
    const adminOrgs = new Set(
      memberships.filter((m) => m.role === "admin").map((m) => m.orgId),
    );

    const deletableByUser = new Map<string, string[]>();
    const denied: string[] = [];
    for (const p of projects) {
      const ws = wsById.get(p.workspace_id);
      if (!ws) {
        denied.push(p.id);
        continue;
      }
      if (!ws.spaceId) {
        if (ws.userId !== auth.sub) {
          denied.push(p.id);
          continue;
        }
      } else {
        const isOrgAdmin = ws.orgId ? adminOrgs.has(ws.orgId) : false;
        const role = spaceRoles.get(ws.spaceId);
        const isSpaceOwner = role === "owner";
        const creator = ws.creatorUserId ?? ws.userId;
        const isCreator = creator === auth.sub;
        if (!(isOrgAdmin || isSpaceOwner || isCreator)) {
          denied.push(p.id);
          continue;
        }
      }
      const list = deletableByUser.get(ws.userId) ?? [];
      list.push(p.id);
      deletableByUser.set(ws.userId, list);
    }
    const deleted: string[] = [];
    for (const [userId, idList] of deletableByUser) {
      const r = await pgWpnDeleteProjects(userId, idList);
      deleted.push(...r.deletedProjectIds);
    }
    if (deleted.length > 0) {
      await db()
        .delete(projectShares)
        .where(inArray(projectShares.projectId, deleted));
    }
    return reply.send({ deleted, denied, notFound });
  });

  app.post("/wpn/projects/:projectId/notes", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { projectId } = request.params as { projectId: string };
    const writeResult = await assertCanWriteProject(reply, auth, projectId);
    if (!writeResult) return;
    const { workspace: ws } = writeResult;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const type = typeof body.type === "string" ? body.type.trim() : "";
    if (!type) return reply.status(400).send({ error: "Invalid note type" });
    const rel = body.relation;
    if (rel !== "child" && rel !== "sibling" && rel !== "root") {
      return reply.status(400).send({ error: "Invalid relation" });
    }
    const anchorId =
      typeof body.anchorId === "string" ? body.anchorId : undefined;
    try {
      const created = await pgWpnCreateNote(
        ws.userId,
        projectId,
        {
          anchorId: rel === "root" ? undefined : anchorId,
          relation: rel,
          type,
          content: typeof body.content === "string" ? body.content : undefined,
          title: typeof body.title === "string" ? body.title : undefined,
          metadata:
            body.metadata &&
            typeof body.metadata === "object" &&
            !Array.isArray(body.metadata)
              ? (body.metadata as Record<string, unknown>)
              : undefined,
        },
        { editorUserId: auth.sub },
      );
      return reply.status(201).send(created);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "Project not found") {
        return reply.status(404).send({ error: msg });
      }
      return sendWpnError(reply, e, 400);
    }
  });

  /** Scan all notes for VFS links that reference the renamed note. */
  async function vfsPreviewTitleChange(
    userId: string,
    noteId: string,
    newTitle: string,
  ): Promise<{ dependentNoteCount: number; dependentNoteIds: string[] }> {
    const noteRows = await db()
      .select()
      .from(wpnNotes)
      .where(
        and(
          eq(wpnNotes.id, noteId),
          eq(wpnNotes.userId, userId),
          ne(wpnNotes.deleted, true),
        ),
      )
      .limit(1);
    const note = noteRows[0];
    if (!note) return { dependentNoteCount: 0, dependentNoteIds: [] };
    const projRows = await db()
      .select()
      .from(wpnProjects)
      .where(
        and(eq(wpnProjects.id, note.project_id), eq(wpnProjects.userId, userId)),
      )
      .limit(1);
    const proj = projRows[0];
    if (!proj) return { dependentNoteCount: 0, dependentNoteIds: [] };
    const wsRows = await db()
      .select()
      .from(wpnWorkspaces)
      .where(
        and(
          eq(wpnWorkspaces.id, proj.workspace_id),
          eq(wpnWorkspaces.userId, userId),
        ),
      )
      .limit(1);
    const ws = wsRows[0];
    if (!ws) return { dependentNoteCount: 0, dependentNoteIds: [] };
    const nextTitle = newTitle.trim() || note.title;
    const ctx = { workspace_name: ws.name, project_name: proj.name };
    const paths = await vfsCanonicalPathsForTitleChange(ctx, note.title, nextTitle);
    if (!paths) return { dependentNoteCount: 0, dependentNoteIds: [] };
    const { oldCanonical, newCanonical } = paths;
    const oldSeg = await normalizeVfsSegment(note.title, "Untitled");
    const newSeg = await normalizeVfsSegment(nextTitle, "Untitled");
    const allNotes = await db()
      .select()
      .from(wpnNotes)
      .where(and(eq(wpnNotes.userId, userId), ne(wpnNotes.deleted, true)));
    const dependentNoteIds: string[] = [];
    for (const n of allNotes) {
      const c0 = n.content ?? "";
      const c1 = await rewriteMarkdownForWpnNoteTitleChange(
        c0,
        n.project_id,
        note.project_id,
        oldCanonical,
        newCanonical,
        oldSeg,
        newSeg,
      );
      if (c1 !== c0) dependentNoteIds.push(n.id);
    }
    return { dependentNoteCount: dependentNoteIds.length, dependentNoteIds };
  }

  /** Apply VFS link rewrites across all notes after a title change. */
  async function vfsApplyTitleChange(
    userId: string,
    noteId: string,
    oldTitle: string,
    newTitle: string,
    renamedProjectId: string,
    workspaceName: string,
    projectName: string,
  ): Promise<number> {
    void noteId;
    const ctx = { workspace_name: workspaceName, project_name: projectName };
    const paths = await vfsCanonicalPathsForTitleChange(ctx, oldTitle, newTitle);
    if (!paths) return 0;
    const { oldCanonical, newCanonical } = paths;
    const oldSeg = await normalizeVfsSegment(oldTitle, "Untitled");
    const newSeg = await normalizeVfsSegment(newTitle, "Untitled");
    const allNotes = await db()
      .select()
      .from(wpnNotes)
      .where(and(eq(wpnNotes.userId, userId), ne(wpnNotes.deleted, true)));
    let updatedCount = 0;
    const now = Date.now();
    for (const n of allNotes) {
      const c0 = n.content ?? "";
      const c1 = await rewriteMarkdownForWpnNoteTitleChange(
        c0,
        n.project_id,
        renamedProjectId,
        oldCanonical,
        newCanonical,
        oldSeg,
        newSeg,
      );
      if (c1 !== c0) {
        await db()
          .update(wpnNotes)
          .set({ content: c1, updated_at_ms: now })
          .where(and(eq(wpnNotes.id, n.id), eq(wpnNotes.userId, userId)));
        updatedCount++;
      }
    }
    return updatedCount;
  }

  app.post("/wpn/notes/:id/preview-title-change", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const newTitle = typeof body.title === "string" ? body.title : "";
    const result = await vfsPreviewTitleChange(auth.sub, id, newTitle);
    return reply.send(result);
  });

  app.patch("/wpn/notes/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    const ws = await assertCanWriteWorkspaceForNote(reply, auth, id);
    if (!ws) return;
    const ownerId = ws.userId;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const updateVfsDependentLinks = body.updateVfsDependentLinks !== false;
    const patch: {
      title?: string;
      content?: string;
      type?: string;
      metadata?: Record<string, unknown> | null;
    } = {};
    if (typeof body.title === "string") patch.title = body.title;
    if (typeof body.content === "string") patch.content = body.content;
    if (typeof body.type === "string") patch.type = body.type;
    if (
      body.metadata === null ||
      (body.metadata && typeof body.metadata === "object")
    ) {
      patch.metadata = body.metadata as Record<string, unknown> | null;
    }
    try {
      let oldTitle: string | null = null;
      let renamedProjectId: string | null = null;
      let workspaceName: string | null = null;
      let projectName: string | null = null;
      if (updateVfsDependentLinks && patch.title !== undefined) {
        const beforeRows = await db()
          .select()
          .from(wpnNotes)
          .where(
            and(
              eq(wpnNotes.id, id),
              eq(wpnNotes.userId, ownerId),
              ne(wpnNotes.deleted, true),
            ),
          )
          .limit(1);
        const before = beforeRows[0];
        if (before) {
          oldTitle = before.title;
          renamedProjectId = before.project_id;
          const projRows = await db()
            .select()
            .from(wpnProjects)
            .where(
              and(
                eq(wpnProjects.id, before.project_id),
                eq(wpnProjects.userId, ownerId),
              ),
            )
            .limit(1);
          const proj = projRows[0];
          if (proj) {
            projectName = proj.name;
            const wsRows = await db()
              .select()
              .from(wpnWorkspaces)
              .where(
                and(
                  eq(wpnWorkspaces.id, proj.workspace_id),
                  eq(wpnWorkspaces.userId, ownerId),
                ),
              )
              .limit(1);
            if (wsRows[0]) workspaceName = wsRows[0].name;
          }
        }
      }

      const note = await pgWpnUpdateNote(ownerId, id, patch, {
        editorUserId: auth.sub,
      });
      if (!note) {
        return reply.status(404).send({ error: "Note not found" });
      }
      if (
        updateVfsDependentLinks &&
        oldTitle !== null &&
        renamedProjectId &&
        workspaceName &&
        projectName &&
        oldTitle !== note.title
      ) {
        try {
          await vfsApplyTitleChange(
            ownerId,
            id,
            oldTitle,
            note.title,
            renamedProjectId,
            workspaceName,
            projectName,
          );
        } catch (err) {
          console.error("[PATCH /wpn/notes/:id] VFS rewrite failed:", err);
        }
      }
      return reply.send({ note });
    } catch (e) {
      if (e instanceof WpnDuplicateSiblingTitleError) {
        return reply.status(409).send({ error: WPN_DUPLICATE_NOTE_TITLE_MESSAGE });
      }
      throw e;
    }
  });

  app.post("/wpn/notes/delete", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const raw = (request.body as { ids?: unknown })?.ids;
    if (!Array.isArray(raw)) {
      return reply.status(400).send({ error: "Expected ids array" });
    }
    const ids = raw.filter((x): x is string => typeof x === "string");
    if (ids.length === 0) {
      return reply.send({ ok: true as const, deleted: 0 });
    }
    const notes = await db()
      .select()
      .from(wpnNotes)
      .where(inArray(wpnNotes.id, ids));
    if (notes.length === 0) {
      return reply.send({ ok: true as const, deleted: 0 });
    }
    const ownerByIdMap = new Map<string, string>();
    const projectIds = [...new Set(notes.map((n) => n.project_id))];
    for (const projectId of projectIds) {
      const writeResult = await assertCanWriteProject(reply, auth, projectId);
      if (!writeResult) return;
      const { workspace: ws } = writeResult;
      for (const n of notes) {
        if (n.project_id === projectId) {
          ownerByIdMap.set(n.id, ws.userId);
        }
      }
    }
    const byOwner = new Map<string, string[]>();
    for (const noteId of ids) {
      const ownerId = ownerByIdMap.get(noteId);
      if (!ownerId) continue;
      const arr = byOwner.get(ownerId) ?? [];
      arr.push(noteId);
      byOwner.set(ownerId, arr);
    }
    for (const [ownerId, group] of byOwner) {
      await pgWpnDeleteNotes(ownerId, group);
    }
    return reply.send({ ok: true as const });
  });

  app.post("/wpn/notes/move", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const projectId = typeof body.projectId === "string" ? body.projectId : "";
    const draggedId = typeof body.draggedId === "string" ? body.draggedId : "";
    const targetId = typeof body.targetId === "string" ? body.targetId : "";
    const p = body.placement;
    if (!projectId || !draggedId || !targetId) {
      return reply.status(400).send({ error: "projectId, draggedId, targetId required" });
    }
    if (p !== "before" && p !== "after" && p !== "into") {
      return reply.status(400).send({ error: "Invalid placement" });
    }
    const writeResult = await assertCanWriteProject(reply, auth, projectId);
    if (!writeResult) return;
    const { workspace: ws } = writeResult;
    try {
      await pgWpnMoveNote(
        ws.userId,
        projectId,
        draggedId,
        targetId,
        p as NoteMovePlacement,
      );
      return reply.send({ ok: true as const });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "Project not found") {
        return reply.status(404).send({ error: msg });
      }
      return sendWpnError(reply, e, 400);
    }
  });

  /** Cross-project note move. */
  app.post("/wpn/notes/move-to-project", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const noteId = typeof body.noteId === "string" ? body.noteId : "";
    const targetProjectId =
      typeof body.targetProjectId === "string" ? body.targetProjectId : "";
    const rawTargetParent = body.targetParentId;
    const targetParentId =
      typeof rawTargetParent === "string" && rawTargetParent.length > 0
        ? rawTargetParent
        : null;
    if (!noteId || !targetProjectId) {
      return reply
        .status(400)
        .send({ error: "noteId, targetProjectId required" });
    }
    const srcNoteRows = await db()
      .select()
      .from(wpnNotes)
      .where(eq(wpnNotes.id, noteId))
      .limit(1);
    const srcNote = srcNoteRows[0];
    if (!srcNote || srcNote.deleted === true) {
      return reply.status(404).send({ error: "Note not found" });
    }
    const srcWs = await assertCanWriteWorkspaceForNote(reply, auth, noteId);
    if (!srcWs) return;
    const dstResult = await assertCanWriteProject(reply, auth, targetProjectId);
    if (!dstResult) return;
    const { workspace: dstWs } = dstResult;
    if (srcWs.userId !== dstWs.userId) {
      return reply
        .status(400)
        .send({ error: "Cross-owner moves are not supported" });
    }
    try {
      await pgWpnMoveNoteToProject(
        srcWs.userId,
        noteId,
        targetProjectId,
        targetParentId,
      );
      return reply.send({ ok: true as const });
    } catch (e) {
      return sendWpnError(reply, e, 400);
    }
  });

  app.post(
    "/wpn/projects/:projectId/notes/:noteId/duplicate",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { projectId, noteId } = request.params as {
        projectId: string;
        noteId: string;
      };
      const writeResult = await assertCanWriteProject(reply, auth, projectId);
      if (!writeResult) return;
      const { workspace: ws } = writeResult;
      try {
        const result = await pgWpnDuplicateSubtree(ws.userId, projectId, noteId);
        return reply.status(201).send(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "Project not found") {
          return reply.status(404).send({ error: msg });
        }
        return sendWpnError(reply, e, 400);
      }
    },
  );

  app.patch(
    "/wpn/projects/:projectId/explorer-state",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { projectId } = request.params as { projectId: string };
      const readResult = await assertCanReadProject(reply, auth, projectId);
      if (!readResult) return;
      const raw = (request.body as { expanded_ids?: unknown })?.expanded_ids;
      const expanded_ids = Array.isArray(raw)
        ? raw.filter((x): x is string => typeof x === "string")
        : [];
      try {
        await pgWpnSetExplorerExpanded(auth.sub, projectId, expanded_ids);
        return reply.send({ expanded_ids });
      } catch (e) {
        return sendWpnError(reply, e);
      }
    },
  );

  app.get("/wpn/workspaces/:workspaceId/settings", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { workspaceId } = request.params as { workspaceId: string };
    const owns = await db()
      .select({ id: wpnWorkspaces.id })
      .from(wpnWorkspaces)
      .where(
        and(
          eq(wpnWorkspaces.id, workspaceId),
          eq(wpnWorkspaces.userId, auth.sub),
        ),
      )
      .limit(1);
    if (owns.length === 0) {
      return reply.status(404).send({ error: "Workspace not found" });
    }
    const settings = await pgWpnGetWorkspaceSettings(auth.sub, workspaceId);
    return reply.send({ settings });
  });

  app.patch("/wpn/workspaces/:workspaceId/settings", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { workspaceId } = request.params as { workspaceId: string };
    const patch =
      request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    try {
      const settings = await pgWpnPatchWorkspaceSettings(
        auth.sub,
        workspaceId,
        patch,
      );
      return reply.send({ settings });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "Workspace not found") {
        return reply.status(404).send({ error: msg });
      }
      return sendWpnError(reply, e);
    }
  });

  app.get("/wpn/projects/:projectId/settings", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { projectId } = request.params as { projectId: string };
    const owns = await db()
      .select({ id: wpnProjects.id })
      .from(wpnProjects)
      .where(
        and(eq(wpnProjects.id, projectId), eq(wpnProjects.userId, auth.sub)),
      )
      .limit(1);
    if (owns.length === 0) {
      return reply.status(404).send({ error: "Project not found" });
    }
    const settings = await pgWpnGetProjectSettings(auth.sub, projectId);
    return reply.send({ settings });
  });

  app.patch("/wpn/projects/:projectId/settings", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { projectId } = request.params as { projectId: string };
    const patch =
      request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    try {
      const settings = await pgWpnPatchProjectSettings(auth.sub, projectId, patch);
      return reply.send({ settings });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "Project not found") {
        return reply.status(404).send({ error: msg });
      }
      return sendWpnError(reply, e);
    }
  });

  // Suppress unused-import warnings.
  void sql;
  void isNull;
}
