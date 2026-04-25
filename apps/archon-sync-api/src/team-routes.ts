import * as crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq, and, inArray, ne, sql } from "drizzle-orm";
import { requireAuth, type JwtPayload } from "./auth.js";
import { getDb } from "./pg.js";
import {
  orgMemberships,
  spaces,
  teamMemberships,
  teamSpaceGrants,
  teams,
  users,
} from "./db/schema.js";
import { requireOrgRole } from "./org-auth.js";
import { recordAudit } from "./audit.js";
import {
  addTeamMemberBody,
  createTeamBody,
  grantTeamSpaceBody,
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
        name: t.name,
        colorToken: t.colorToken,
        memberCount: countByTeam.get(t.id) ?? 0,
        createdAt: t.createdAt,
      })),
    });
  });

  /** Admin-only: create a team. */
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
      metadata: { name: parsed.data.name },
    });
    return reply.send({
      teamId,
      orgId,
      name: parsed.data.name,
      colorToken: parsed.data.colorToken ?? null,
    });
  });

  /** Admin-only: rename / recolor a team. */
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
    if (Object.keys(patch).length === 0) {
      return reply.status(400).send({ error: "No fields to update" });
    }
    await db().update(teams).set(patch).where(eq(teams.id, r.team.id));
    return reply.status(204).send();
  });

  /** Admin-only: delete a team and cascade memberships + grants. */
  app.delete("/teams/:teamId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { teamId } = request.params as { teamId: string };
    const r = await requireTeamAdmin(request, reply, auth, teamId);
    if (!r) return;
    await db().delete(teamMemberships).where(eq(teamMemberships.teamId, r.team.id));
    await db().delete(teamSpaceGrants).where(eq(teamSpaceGrants.teamId, r.team.id));
    await db().delete(teams).where(eq(teams.id, r.team.id));
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
          joinedAt: m.joinedAt,
        };
      }),
    });
  });

  /** Admin-only: add an org member to a team. */
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
        addedByUserId: auth.sub,
        joinedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [teamMemberships.teamId, teamMemberships.userId],
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
    return reply.status(204).send();
  });

  /** List grants for a team. */
  app.get("/teams/:teamId/grants", async (request, reply) => {
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
      .from(teamSpaceGrants)
      .where(eq(teamSpaceGrants.teamId, teamId));
    const spaceIds = grantRows.map((g) => g.spaceId);
    const spaceRows = spaceIds.length
      ? await db()
          .select({ id: spaces.id, name: spaces.name })
          .from(spaces)
          .where(inArray(spaces.id, spaceIds))
      : [];
    const spacesById = new Map(spaceRows.map((s) => [s.id, s]));
    return reply.send({
      grants: grantRows.map((g) => {
        const s = spacesById.get(g.spaceId);
        return {
          spaceId: g.spaceId,
          spaceName: s?.name ?? "(unknown space)",
          role: g.role,
          grantedAt: g.grantedAt,
        };
      }),
    });
  });

  /** Admin-only: grant a team a role on a space (idempotent — upsert). */
  app.post("/teams/:teamId/grants", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { teamId } = request.params as { teamId: string };
    const r = await requireTeamAdmin(request, reply, auth, teamId);
    if (!r) return;
    const parsed = grantTeamSpaceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    if (!isUuid(parsed.data.spaceId)) {
      return reply.status(400).send({ error: "Invalid spaceId" });
    }
    const spaceRows = await db()
      .select()
      .from(spaces)
      .where(eq(spaces.id, parsed.data.spaceId))
      .limit(1);
    const space = spaceRows[0];
    if (!space || space.orgId !== r.team.orgId) {
      return reply
        .status(400)
        .send({ error: "Space must belong to the team's organization" });
    }
    await db()
      .insert(teamSpaceGrants)
      .values({
        teamId,
        spaceId: parsed.data.spaceId,
        role: parsed.data.role,
        grantedByUserId: auth.sub,
        grantedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [teamSpaceGrants.teamId, teamSpaceGrants.spaceId],
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
      action: "team.grant.set",
      targetType: "team_space_grant",
      targetId: `${teamId}:${parsed.data.spaceId}`,
      metadata: { teamId, spaceId: parsed.data.spaceId, role: parsed.data.role },
    });
    return reply.status(204).send();
  });

  /** Admin-only: revoke a team's grant on a space. */
  app.delete("/teams/:teamId/grants/:spaceId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { teamId, spaceId } = request.params as {
      teamId: string;
      spaceId: string;
    };
    const r = await requireTeamAdmin(request, reply, auth, teamId);
    if (!r) return;
    const result = await db()
      .delete(teamSpaceGrants)
      .where(
        and(
          eq(teamSpaceGrants.teamId, teamId),
          eq(teamSpaceGrants.spaceId, spaceId),
        ),
      )
      .returning({ teamId: teamSpaceGrants.teamId });
    if (result.length === 0) {
      return reply.status(404).send({ error: "Grant not found" });
    }
    return reply.status(204).send();
  });
}
