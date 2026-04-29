/**
 * Team routes (post-migration).
 *
 * Teams live under departments and grant access to projects via
 * `team_projects` (many-to-many). `team_space_grants` is gone — every
 * team↔resource edge in the new model is a `team_projects` row.
 *
 * Routes:
 *   GET    /orgs/:orgId/teams                  — list teams in org
 *   POST   /orgs/:orgId/teams                  — admin: create team under a dept
 *   PATCH  /teams/:teamId                      — admin: rename / recolor / move
 *   DELETE /teams/:teamId                      — admin: delete (cascade
 *                                                memberships + project grants)
 *   GET    /teams/:teamId/members              — list members
 *   POST   /teams/:teamId/members              — admin: add member
 *   PATCH  /teams/:teamId/members/:userId      — admin: change role
 *   DELETE /teams/:teamId/members/:userId      — admin: remove member
 *   GET    /teams/:teamId/projects             — list project grants
 *   POST   /teams/:teamId/projects             — admin: grant project (upsert)
 *   PATCH  /teams/:teamId/projects/:projectId  — admin: change role
 *   DELETE /teams/:teamId/projects/:projectId  — admin: revoke grant
 */
import * as crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq, and, inArray, ne, sql } from "drizzle-orm";
import { requireAuth, type JwtPayload } from "./auth.js";
import { getDb } from "./pg.js";
import {
  departments,
  orgMemberships,
  projects,
  teamMemberships,
  teamProjects,
  teams,
  users,
} from "./db/schema.js";
import { requireOrgRole } from "./org-auth.js";
import { recordAudit } from "./audit.js";
import {
  addTeamMemberBody,
  createTeamBody,
  grantTeamProjectBody,
  setTeamMemberRoleBody,
  setTeamProjectRoleBody,
  updateTeamBody,
} from "./org-schemas.js";
import { isUuid } from "./db/legacy-id-map.js";

type TeamRow = typeof teams.$inferSelect;

/** Resolve a team and ensure the caller is admin of its org. */
async function requireTeamAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: JwtPayload,
  teamId: string,
): Promise<{ team: TeamRow } | null> {
  if (!isUuid(teamId)) {
    await reply.status(404).send({ error: "Team not found" });
    return null;
  }
  const rows = await getDb()
    .select()
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);
  const team = rows[0];
  if (!team) {
    await reply.status(404).send({ error: "Team not found" });
    return null;
  }
  const ctx = await requireOrgRole(request, reply, auth, team.orgId, "admin");
  if (!ctx) return null;
  return { team };
}

export function registerTeamRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;
  const db = (): ReturnType<typeof getDb> => getDb();

  /** List teams in an org. Org members see all teams; non-members get 404. */
  app.get("/orgs/:orgId/teams", async (request, reply) => {
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
    const teamRows = await db()
      .select()
      .from(teams)
      .where(eq(teams.orgId, orgId));
    const teamIds = teamRows.map((t) => t.id);
    const counts = teamIds.length
      ? await db()
          .select({
            teamId: teamMemberships.teamId,
            count: sql<number>`count(*)::int`,
          })
          .from(teamMemberships)
          .where(inArray(teamMemberships.teamId, teamIds))
          .groupBy(teamMemberships.teamId)
      : [];
    const countByTeam = new Map(counts.map((c) => [c.teamId, c.count]));
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

  /** Admin-only: create a team in a department of the org. */
  app.post("/orgs/:orgId/teams", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { orgId } = request.params as { orgId: string };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) return;
    const parsed = createTeamBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    if (!isUuid(parsed.data.departmentId)) {
      return reply.status(400).send({ error: "Invalid departmentId" });
    }
    // Department must belong to the same org as the team being created.
    const deptRows = await db()
      .select()
      .from(departments)
      .where(eq(departments.id, parsed.data.departmentId))
      .limit(1);
    const dept = deptRows[0];
    if (!dept || dept.orgId !== orgId) {
      return reply
        .status(400)
        .send({ error: "Department must belong to the team's organization" });
    }
    const dup = await db()
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.orgId, orgId), eq(teams.name, parsed.data.name)))
      .limit(1);
    if (dup.length > 0) {
      return reply.status(409).send({ error: "Team name already in use" });
    }
    const teamId = crypto.randomUUID();
    await db().insert(teams).values({
      id: teamId,
      orgId,
      departmentId: parsed.data.departmentId,
      name: parsed.data.name,
      colorToken: parsed.data.colorToken ?? null,
      createdByUserId: auth.sub,
      createdAt: new Date(),
    });
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "team.create",
      targetType: "team",
      targetId: teamId,
      metadata: { name: parsed.data.name, departmentId: parsed.data.departmentId },
    });
    return reply.send({
      teamId,
      orgId,
      departmentId: parsed.data.departmentId,
      name: parsed.data.name,
      colorToken: parsed.data.colorToken ?? null,
    });
  });

  /** Admin-only: rename / recolor / move team. */
  app.patch("/teams/:teamId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { teamId } = request.params as { teamId: string };
    const r = await requireTeamAdmin(request, reply, auth, teamId);
    if (!r) return;
    const parsed = updateTeamBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const patch: Record<string, unknown> = {};
    if (parsed.data.name) {
      const dup = await db()
        .select({ id: teams.id })
        .from(teams)
        .where(
          and(
            eq(teams.orgId, r.team.orgId),
            eq(teams.name, parsed.data.name),
            ne(teams.id, r.team.id),
          ),
        )
        .limit(1);
      if (dup.length > 0) {
        return reply.status(409).send({ error: "Team name already in use" });
      }
      patch.name = parsed.data.name;
    }
    if (parsed.data.colorToken !== undefined) {
      patch.colorToken = parsed.data.colorToken;
    }
    if (parsed.data.departmentId !== undefined) {
      if (!isUuid(parsed.data.departmentId)) {
        return reply.status(400).send({ error: "Invalid departmentId" });
      }
      const deptRows = await db()
        .select()
        .from(departments)
        .where(eq(departments.id, parsed.data.departmentId))
        .limit(1);
      const dept = deptRows[0];
      if (!dept || dept.orgId !== r.team.orgId) {
        return reply
          .status(400)
          .send({ error: "Department must belong to the team's organization" });
      }
      patch.departmentId = parsed.data.departmentId;
    }
    if (Object.keys(patch).length === 0) {
      return reply.status(400).send({ error: "No fields to update" });
    }
    await db().update(teams).set(patch).where(eq(teams.id, r.team.id));
    await recordAudit({
      orgId: r.team.orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "team.update",
      targetType: "team",
      targetId: r.team.id,
      metadata: patch,
    });
    return reply.status(204).send();
  });

  /**
   * Admin-only: delete a team. FK cascade drops `team_memberships` and
   * `team_projects`; we issue explicit deletes too because the schema is
   * young and the test suite asserts row counts.
   */
  app.delete("/teams/:teamId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { teamId } = request.params as { teamId: string };
    const r = await requireTeamAdmin(request, reply, auth, teamId);
    if (!r) return;
    await db().delete(teamMemberships).where(eq(teamMemberships.teamId, r.team.id));
    await db().delete(teamProjects).where(eq(teamProjects.teamId, r.team.id));
    await db().delete(teams).where(eq(teams.id, r.team.id));
    await recordAudit({
      orgId: r.team.orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "team.delete",
      targetType: "team",
      targetId: r.team.id,
      metadata: { name: r.team.name },
    });
    return reply.status(204).send();
  });

  /** List members of a team. Any org member may read. */
  app.get("/teams/:teamId/members", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { teamId } = request.params as { teamId: string };
    if (!isUuid(teamId)) {
      return reply.status(404).send({ error: "Team not found" });
    }
    const teamRows = await db()
      .select()
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);
    const team = teamRows[0];
    if (!team) {
      return reply.status(404).send({ error: "Team not found" });
    }
    const orgMember = await db()
      .select({ id: orgMemberships.userId })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.orgId, team.orgId),
          eq(orgMemberships.userId, auth.sub),
        ),
      )
      .limit(1);
    if (orgMember.length === 0) {
      return reply.status(404).send({ error: "Team not found" });
    }
    const memberRows = await db()
      .select()
      .from(teamMemberships)
      .where(eq(teamMemberships.teamId, teamId));
    const userIds = memberRows.map((r) => r.userId);
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

  /** Admin-only: add an org member to a team with a role. */
  app.post("/teams/:teamId/members", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { teamId } = request.params as { teamId: string };
    const r = await requireTeamAdmin(request, reply, auth, teamId);
    if (!r) return;
    const parsed = addTeamMemberBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const isOrgMember = await db()
      .select({ id: orgMemberships.userId })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.orgId, r.team.orgId),
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
      .insert(teamMemberships)
      .values({
        teamId,
        userId: parsed.data.userId,
        role: parsed.data.role,
        addedByUserId: auth.sub,
        joinedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [teamMemberships.teamId, teamMemberships.userId],
      });
    await recordAudit({
      orgId: r.team.orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "team.member.add",
      targetType: "team_membership",
      targetId: `${teamId}:${parsed.data.userId}`,
      metadata: { teamId, userId: parsed.data.userId, role: parsed.data.role },
    });
    return reply.status(204).send();
  });

  /** Admin-only: change a team member's role. */
  app.patch("/teams/:teamId/members/:userId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { teamId, userId } = request.params as {
      teamId: string;
      userId: string;
    };
    const r = await requireTeamAdmin(request, reply, auth, teamId);
    if (!r) return;
    const parsed = setTeamMemberRoleBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const result = await db()
      .update(teamMemberships)
      .set({ role: parsed.data.role })
      .where(
        and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, userId)),
      )
      .returning({ teamId: teamMemberships.teamId });
    if (result.length === 0) {
      return reply.status(404).send({ error: "Member not found" });
    }
    await recordAudit({
      orgId: r.team.orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "team.member.role_change",
      targetType: "team_membership",
      targetId: `${teamId}:${userId}`,
      metadata: { teamId, userId, role: parsed.data.role },
    });
    return reply.status(204).send();
  });

  /** Admin-only: remove a team member. */
  app.delete("/teams/:teamId/members/:userId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { teamId, userId } = request.params as {
      teamId: string;
      userId: string;
    };
    const r = await requireTeamAdmin(request, reply, auth, teamId);
    if (!r) return;
    const result = await db()
      .delete(teamMemberships)
      .where(
        and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, userId)),
      )
      .returning({ teamId: teamMemberships.teamId });
    if (result.length === 0) {
      return reply.status(404).send({ error: "Member not found" });
    }
    await recordAudit({
      orgId: r.team.orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "team.member.remove",
      targetType: "team_membership",
      targetId: `${teamId}:${userId}`,
      metadata: { teamId, userId },
    });
    return reply.status(204).send();
  });

  /** List a team's project grants. */
  app.get("/teams/:teamId/projects", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { teamId } = request.params as { teamId: string };
    if (!isUuid(teamId)) {
      return reply.status(404).send({ error: "Team not found" });
    }
    const teamRows = await db()
      .select()
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);
    const team = teamRows[0];
    if (!team) {
      return reply.status(404).send({ error: "Team not found" });
    }
    const orgMember = await db()
      .select({ id: orgMemberships.userId })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.orgId, team.orgId),
          eq(orgMemberships.userId, auth.sub),
        ),
      )
      .limit(1);
    if (orgMember.length === 0) {
      return reply.status(404).send({ error: "Team not found" });
    }
    const grantRows = await db()
      .select()
      .from(teamProjects)
      .where(eq(teamProjects.teamId, teamId));
    const projectIds = grantRows.map((g) => g.projectId);
    const projectRows = projectIds.length
      ? await db()
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, projectIds))
      : [];
    const projectsById = new Map(projectRows.map((p) => [p.id, p]));
    return reply.send({
      grants: grantRows.map((g) => {
        const p = projectsById.get(g.projectId);
        return {
          projectId: g.projectId,
          projectName: p?.name ?? "(unknown project)",
          role: g.role,
          grantedAt: g.grantedAt,
        };
      }),
    });
  });

  /**
   * Admin-only: grant the team a role on a project (idempotent — upserts on
   * (team_id, project_id), updating role on conflict).
   */
  app.post("/teams/:teamId/projects", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { teamId } = request.params as { teamId: string };
    const r = await requireTeamAdmin(request, reply, auth, teamId);
    if (!r) return;
    const parsed = grantTeamProjectBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    if (!isUuid(parsed.data.projectId)) {
      return reply.status(400).send({ error: "Invalid projectId" });
    }
    const projectRows = await db()
      .select()
      .from(projects)
      .where(eq(projects.id, parsed.data.projectId))
      .limit(1);
    const project = projectRows[0];
    if (!project || project.orgId !== r.team.orgId) {
      return reply
        .status(400)
        .send({ error: "Project must belong to the team's organization" });
    }
    await db()
      .insert(teamProjects)
      .values({
        teamId,
        projectId: parsed.data.projectId,
        role: parsed.data.role,
        grantedByUserId: auth.sub,
        grantedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [teamProjects.teamId, teamProjects.projectId],
        set: {
          role: parsed.data.role,
          grantedByUserId: auth.sub,
          grantedAt: new Date(),
        },
      });
    await recordAudit({
      orgId: r.team.orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "team.project.grant",
      targetType: "team_project",
      targetId: `${teamId}:${parsed.data.projectId}`,
      metadata: { teamId, projectId: parsed.data.projectId, role: parsed.data.role },
    });
    return reply.status(204).send();
  });

  /** Admin-only: change a project grant's role. */
  app.patch("/teams/:teamId/projects/:projectId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { teamId, projectId } = request.params as {
      teamId: string;
      projectId: string;
    };
    const r = await requireTeamAdmin(request, reply, auth, teamId);
    if (!r) return;
    const parsed = setTeamProjectRoleBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const result = await db()
      .update(teamProjects)
      .set({
        role: parsed.data.role,
        grantedByUserId: auth.sub,
        grantedAt: new Date(),
      })
      .where(
        and(
          eq(teamProjects.teamId, teamId),
          eq(teamProjects.projectId, projectId),
        ),
      )
      .returning({ teamId: teamProjects.teamId });
    if (result.length === 0) {
      return reply.status(404).send({ error: "Grant not found" });
    }
    await recordAudit({
      orgId: r.team.orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "team.project.role_change",
      targetType: "team_project",
      targetId: `${teamId}:${projectId}`,
      metadata: { teamId, projectId, role: parsed.data.role },
    });
    return reply.status(204).send();
  });

  /** Admin-only: revoke a team's project grant. */
  app.delete("/teams/:teamId/projects/:projectId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { teamId, projectId } = request.params as {
      teamId: string;
      projectId: string;
    };
    const r = await requireTeamAdmin(request, reply, auth, teamId);
    if (!r) return;
    const result = await db()
      .delete(teamProjects)
      .where(
        and(
          eq(teamProjects.teamId, teamId),
          eq(teamProjects.projectId, projectId),
        ),
      )
      .returning({ teamId: teamProjects.teamId });
    if (result.length === 0) {
      return reply.status(404).send({ error: "Grant not found" });
    }
    await recordAudit({
      orgId: r.team.orgId,
      actorUserId: auth.sub,
      principal: auth.principal ?? { type: "user" },
      action: "team.project.revoke",
      targetType: "team_project",
      targetId: `${teamId}:${projectId}`,
      metadata: { teamId, projectId },
    });
    return reply.status(204).send();
  });
}
