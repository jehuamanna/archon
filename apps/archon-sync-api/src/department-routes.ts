/**
 * Department routes (post-migration).
 *
 * Departments sit between Org and Team. Every team belongs to a department
 * (NOT NULL FK), so deleting a department is constrained to empty ones.
 *
 * Routes:
 *   GET    /orgs/:orgId/departments                    — list departments in org
 *   POST   /orgs/:orgId/departments                    — admin: create
 *   PATCH  /departments/:departmentId                  — admin: rename / recolor
 *   DELETE /departments/:departmentId                  — admin: delete (only if empty)
 *   GET    /departments/:departmentId/members          — list members
 *   POST   /departments/:departmentId/members          — admin: add member
 *   PATCH  /departments/:departmentId/members/:userId  — admin: change role
 *   DELETE /departments/:departmentId/members/:userId  — admin: remove member
 *   GET    /departments/:departmentId/teams            — list teams in dept
 */
import * as crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray, ne } from "drizzle-orm";
import { requireAuth, type JwtPayload } from "./auth.js";
import { getDb } from "./pg.js";
import {
  departmentMemberships,
  departments,
  orgMemberships,
  teamMemberships,
  teams,
  users,
} from "./db/schema.js";
import { requireOrgRole } from "./org-auth.js";
import { recordAudit } from "./audit.js";
import {
  addDepartmentMemberBody,
  createDepartmentBody,
  setDepartmentMemberRoleBody,
  updateDepartmentBody,
} from "./org-schemas.js";
import { isUuid } from "./db/legacy-id-map.js";

type DepartmentRow = typeof departments.$inferSelect;

/** Resolve a department and ensure the caller is admin of its org. */
async function requireDepartmentAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: JwtPayload,
  departmentId: string,
): Promise<{ dept: DepartmentRow } | null> {
  if (!isUuid(departmentId)) {
    await reply.status(404).send({ error: "Department not found" });
    return null;
  }
  const rows = await getDb()
    .select()
    .from(departments)
    .where(eq(departments.id, departmentId))
    .limit(1);
  const dept = rows[0];
  if (!dept) {
    await reply.status(404).send({ error: "Department not found" });
    return null;
  }
  const ctx = await requireOrgRole(request, reply, auth, dept.orgId, "admin");
  if (!ctx) return null;
  return { dept };
}

export function registerDepartmentRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;
  const db = (): ReturnType<typeof getDb> => getDb();

  /** List departments in an org. Org members see all; non-members get 404. */
  app.get("/orgs/:orgId/departments", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { orgId } = request.params as { orgId: string };
    const orgMember = await db()
      .select({ id: orgMemberships.userId })
      .from(orgMemberships)
      .where(
        and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, auth.sub)),
      )
      .limit(1);
    if (orgMember.length === 0) {
      return reply.status(404).send({ error: "Organization not found" });
    }
    const deptRows = await db()
      .select()
      .from(departments)
      .where(eq(departments.orgId, orgId));
    const deptIds = deptRows.map((d) => d.id);
    // Aggregate team and member counts in two cheap queries.
    const teamCounts = deptIds.length
      ? await db()
          .select({ departmentId: teams.departmentId, id: teams.id })
          .from(teams)
          .where(inArray(teams.departmentId, deptIds))
      : [];
    const memberCounts = deptIds.length
      ? await db()
          .select({
            departmentId: departmentMemberships.departmentId,
            userId: departmentMemberships.userId,
          })
          .from(departmentMemberships)
          .where(inArray(departmentMemberships.departmentId, deptIds))
      : [];
    const teamCountByDept = new Map<string, number>();
    for (const t of teamCounts) {
      teamCountByDept.set(
        t.departmentId,
        (teamCountByDept.get(t.departmentId) ?? 0) + 1,
      );
    }
    const memberCountByDept = new Map<string, number>();
    for (const m of memberCounts) {
      memberCountByDept.set(
        m.departmentId,
        (memberCountByDept.get(m.departmentId) ?? 0) + 1,
      );
    }
    return reply.send({
      departments: deptRows.map((d) => ({
        departmentId: d.id,
        orgId: d.orgId,
        name: d.name,
        colorToken: d.colorToken,
        teamCount: teamCountByDept.get(d.id) ?? 0,
        memberCount: memberCountByDept.get(d.id) ?? 0,
        createdAt: d.createdAt,
      })),
    });
  });

  /** Admin-only: create a department. */
  app.post("/orgs/:orgId/departments", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { orgId } = request.params as { orgId: string };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) return;
    const parsed = createDepartmentBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const dup = await db()
      .select({ id: departments.id })
      .from(departments)
      .where(
        and(eq(departments.orgId, orgId), eq(departments.name, parsed.data.name)),
      )
      .limit(1);
    if (dup.length > 0) {
      return reply.status(409).send({ error: "Department name already in use" });
    }
    const departmentId = crypto.randomUUID();
    await db().insert(departments).values({
      id: departmentId,
      orgId,
      name: parsed.data.name,
      colorToken: parsed.data.colorToken ?? null,
      createdByUserId: auth.sub,
      createdAt: new Date(),
    });
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "department.create",
      targetType: "department",
      targetId: departmentId,
      metadata: { name: parsed.data.name },
    });
    return reply.send({
      departmentId,
      orgId,
      name: parsed.data.name,
      colorToken: parsed.data.colorToken ?? null,
    });
  });

  /** Admin-only: rename / recolor a department. */
  app.patch("/departments/:departmentId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { departmentId } = request.params as { departmentId: string };
    const r = await requireDepartmentAdmin(request, reply, auth, departmentId);
    if (!r) return;
    const parsed = updateDepartmentBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const patch: Record<string, unknown> = {};
    if (parsed.data.name) {
      const dup = await db()
        .select({ id: departments.id })
        .from(departments)
        .where(
          and(
            eq(departments.orgId, r.dept.orgId),
            eq(departments.name, parsed.data.name),
            ne(departments.id, r.dept.id),
          ),
        )
        .limit(1);
      if (dup.length > 0) {
        return reply.status(409).send({ error: "Department name already in use" });
      }
      patch.name = parsed.data.name;
    }
    if (parsed.data.colorToken !== undefined) {
      patch.colorToken = parsed.data.colorToken;
    }
    if (Object.keys(patch).length === 0) {
      return reply.status(400).send({ error: "No fields to update" });
    }
    await db().update(departments).set(patch).where(eq(departments.id, r.dept.id));
    await recordAudit({
      orgId: r.dept.orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "department.update",
      targetType: "department",
      targetId: r.dept.id,
      metadata: patch,
    });
    return reply.status(204).send();
  });

  /**
   * Admin-only: delete a department. Refuse when teams still belong to it
   * (FK is RESTRICT) — caller must move or delete those teams first. Member
   * rows cascade.
   */
  app.delete("/departments/:departmentId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { departmentId } = request.params as { departmentId: string };
    const r = await requireDepartmentAdmin(request, reply, auth, departmentId);
    if (!r) return;
    const teamRows = await db()
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.departmentId, r.dept.id))
      .limit(1);
    if (teamRows.length > 0) {
      return reply
        .status(409)
        .send({ error: "Department has teams; move or delete them first" });
    }
    await db()
      .delete(departmentMemberships)
      .where(eq(departmentMemberships.departmentId, r.dept.id));
    await db().delete(departments).where(eq(departments.id, r.dept.id));
    await recordAudit({
      orgId: r.dept.orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "department.delete",
      targetType: "department",
      targetId: r.dept.id,
      metadata: { name: r.dept.name },
    });
    return reply.status(204).send();
  });

  /** List members of a department. Org members may read. */
  app.get("/departments/:departmentId/members", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { departmentId } = request.params as { departmentId: string };
    if (!isUuid(departmentId)) {
      return reply.status(404).send({ error: "Department not found" });
    }
    const deptRows = await db()
      .select()
      .from(departments)
      .where(eq(departments.id, departmentId))
      .limit(1);
    const dept = deptRows[0];
    if (!dept) {
      return reply.status(404).send({ error: "Department not found" });
    }
    const orgMember = await db()
      .select({ id: orgMemberships.userId })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.orgId, dept.orgId),
          eq(orgMemberships.userId, auth.sub),
        ),
      )
      .limit(1);
    if (orgMember.length === 0) {
      return reply.status(404).send({ error: "Department not found" });
    }
    const memberRows = await db()
      .select()
      .from(departmentMemberships)
      .where(eq(departmentMemberships.departmentId, departmentId));
    const userIds = memberRows.map((m) => m.userId);
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
      members: memberRows.map((m) => {
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

  /** Admin-only: add an org member to a department. */
  app.post("/departments/:departmentId/members", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { departmentId } = request.params as { departmentId: string };
    const r = await requireDepartmentAdmin(request, reply, auth, departmentId);
    if (!r) return;
    const parsed = addDepartmentMemberBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const isOrgMember = await db()
      .select({ id: orgMemberships.userId })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.orgId, r.dept.orgId),
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
      .insert(departmentMemberships)
      .values({
        departmentId,
        userId: parsed.data.userId,
        role: parsed.data.role,
        addedByUserId: auth.sub,
        joinedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [
          departmentMemberships.departmentId,
          departmentMemberships.userId,
        ],
      });
    await recordAudit({
      orgId: r.dept.orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "department.member.add",
      targetType: "department_membership",
      targetId: `${departmentId}:${parsed.data.userId}`,
      metadata: { departmentId, userId: parsed.data.userId, role: parsed.data.role },
    });
    return reply.status(204).send();
  });

  /** Admin-only: change a department member's role. */
  app.patch("/departments/:departmentId/members/:userId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { departmentId, userId } = request.params as {
      departmentId: string;
      userId: string;
    };
    const r = await requireDepartmentAdmin(request, reply, auth, departmentId);
    if (!r) return;
    const parsed = setDepartmentMemberRoleBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const result = await db()
      .update(departmentMemberships)
      .set({ role: parsed.data.role })
      .where(
        and(
          eq(departmentMemberships.departmentId, departmentId),
          eq(departmentMemberships.userId, userId),
        ),
      )
      .returning({ departmentId: departmentMemberships.departmentId });
    if (result.length === 0) {
      return reply.status(404).send({ error: "Member not found" });
    }
    await recordAudit({
      orgId: r.dept.orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "department.member.role_change",
      targetType: "department_membership",
      targetId: `${departmentId}:${userId}`,
      metadata: { departmentId, userId, role: parsed.data.role },
    });
    return reply.status(204).send();
  });

  /** Admin-only: remove a department member. */
  app.delete("/departments/:departmentId/members/:userId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { departmentId, userId } = request.params as {
      departmentId: string;
      userId: string;
    };
    const r = await requireDepartmentAdmin(request, reply, auth, departmentId);
    if (!r) return;
    const result = await db()
      .delete(departmentMemberships)
      .where(
        and(
          eq(departmentMemberships.departmentId, departmentId),
          eq(departmentMemberships.userId, userId),
        ),
      )
      .returning({ departmentId: departmentMemberships.departmentId });
    if (result.length === 0) {
      return reply.status(404).send({ error: "Member not found" });
    }
    await recordAudit({
      orgId: r.dept.orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "department.member.remove",
      targetType: "department_membership",
      targetId: `${departmentId}:${userId}`,
      metadata: { departmentId, userId },
    });
    return reply.status(204).send();
  });

  /** List teams in a department. Any org member may read. */
  app.get("/departments/:departmentId/teams", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { departmentId } = request.params as { departmentId: string };
    if (!isUuid(departmentId)) {
      return reply.status(404).send({ error: "Department not found" });
    }
    const deptRows = await db()
      .select()
      .from(departments)
      .where(eq(departments.id, departmentId))
      .limit(1);
    const dept = deptRows[0];
    if (!dept) {
      return reply.status(404).send({ error: "Department not found" });
    }
    const orgMember = await db()
      .select({ id: orgMemberships.userId })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.orgId, dept.orgId),
          eq(orgMemberships.userId, auth.sub),
        ),
      )
      .limit(1);
    if (orgMember.length === 0) {
      return reply.status(404).send({ error: "Department not found" });
    }
    const teamRows = await db()
      .select()
      .from(teams)
      .where(eq(teams.departmentId, departmentId));
    const teamIds = teamRows.map((t) => t.id);
    const memberCounts = teamIds.length
      ? await db()
          .select({
            teamId: teamMemberships.teamId,
            userId: teamMemberships.userId,
          })
          .from(teamMemberships)
          .where(inArray(teamMemberships.teamId, teamIds))
      : [];
    const countByTeam = new Map<string, number>();
    for (const m of memberCounts) {
      countByTeam.set(m.teamId, (countByTeam.get(m.teamId) ?? 0) + 1);
    }
    return reply.send({
      teams: teamRows.map((t) => ({
        teamId: t.id,
        orgId: t.orgId,
        departmentId: t.departmentId,
        name: t.name,
        colorToken: t.colorToken,
        memberCount: countByTeam.get(t.id) ?? 0,
        createdAt: t.createdAt,
      })),
    });
  });
}
