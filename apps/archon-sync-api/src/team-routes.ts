import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { requireAuth } from "./auth.js";
import {
  getOrgMembershipsCollection,
  getSpacesCollection,
  getTeamMembershipsCollection,
  getTeamSpaceGrantsCollection,
  getTeamsCollection,
  getUsersCollection,
  type UserDoc,
} from "./db.js";
import { requireOrgRole } from "./org-auth.js";
import { recordAudit } from "./audit.js";
import {
  addTeamMemberBody,
  createTeamBody,
  grantTeamSpaceBody,
  updateTeamBody,
} from "./org-schemas.js";

function isObjectIdHex(s: string): boolean {
  return /^[a-f0-9]{24}$/i.test(s);
}

/** Resolve a team and ensure the caller is admin of its org. */
async function requireTeamAdmin(
  request: import("fastify").FastifyRequest,
  reply: import("fastify").FastifyReply,
  auth: import("./auth.js").JwtPayload,
  teamIdHex: string,
): Promise<{ team: import("./org-schemas.js").TeamDoc } | null> {
  if (!isObjectIdHex(teamIdHex)) {
    await reply.status(404).send({ error: "Team not found" });
    return null;
  }
  const team = await getTeamsCollection().findOne({
    _id: new ObjectId(teamIdHex),
  });
  if (!team) {
    await reply.status(404).send({ error: "Team not found" });
    return null;
  }
  const ctx = await requireOrgRole(request, reply, auth, team.orgId, "admin");
  if (!ctx) {
    return null;
  }
  return { team };
}

export function registerTeamRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  /** List teams in an org. Org members see all teams; non-members get 404. */
  app.get("/orgs/:orgId/teams", async (request, reply) => {
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
    const teams = await getTeamsCollection().find({ orgId }).toArray();
    const teamIds = teams.map((t) => t._id.toHexString());
    const memberCounts = teamIds.length
      ? await getTeamMembershipsCollection()
          .aggregate<{ _id: string; count: number }>([
            { $match: { teamId: { $in: teamIds } } },
            { $group: { _id: "$teamId", count: { $sum: 1 } } },
          ])
          .toArray()
      : [];
    const countByTeam = new Map(memberCounts.map((c) => [c._id, c.count]));
    return reply.send({
      teams: teams.map((t) => ({
        teamId: t._id.toHexString(),
        orgId: t.orgId,
        name: t.name,
        colorToken: t.colorToken,
        memberCount: countByTeam.get(t._id.toHexString()) ?? 0,
        createdAt: t.createdAt,
      })),
    });
  });

  /** Admin-only: create a team. */
  app.post("/orgs/:orgId/teams", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { orgId } = request.params as { orgId: string };
    const ctx = await requireOrgRole(request, reply, auth, orgId, "admin");
    if (!ctx) {
      return;
    }
    const parsed = createTeamBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const teams = getTeamsCollection();
    const dup = await teams.findOne({ orgId, name: parsed.data.name });
    if (dup) {
      return reply.status(409).send({ error: "Team name already in use" });
    }
    const ins = await teams.insertOne({
      orgId,
      name: parsed.data.name,
      colorToken: parsed.data.colorToken ?? null,
      createdByUserId: auth.sub,
      createdAt: new Date(),
    } as never);
    await recordAudit({
      orgId,
      actorUserId: auth.sub,
      action: "team.create",
      targetType: "team",
      targetId: ins.insertedId.toHexString(),
      metadata: { name: parsed.data.name },
    });
    return reply.send({
      teamId: ins.insertedId.toHexString(),
      orgId,
      name: parsed.data.name,
      colorToken: parsed.data.colorToken ?? null,
    });
  });

  /** Admin-only: rename / recolor a team. */
  app.patch("/teams/:teamId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { teamId } = request.params as { teamId: string };
    const r = await requireTeamAdmin(request, reply, auth, teamId);
    if (!r) {
      return;
    }
    const parsed = updateTeamBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const patch: Record<string, unknown> = {};
    if (parsed.data.name) {
      const dup = await getTeamsCollection().findOne({
        orgId: r.team.orgId,
        name: parsed.data.name,
        _id: { $ne: r.team._id },
      });
      if (dup) {
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
    await getTeamsCollection().updateOne({ _id: r.team._id }, { $set: patch });
    return reply.status(204).send();
  });

  /** Admin-only: delete a team and cascade memberships + grants. */
  app.delete("/teams/:teamId", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { teamId } = request.params as { teamId: string };
    const r = await requireTeamAdmin(request, reply, auth, teamId);
    if (!r) {
      return;
    }
    await getTeamMembershipsCollection().deleteMany({ teamId });
    await getTeamSpaceGrantsCollection().deleteMany({ teamId });
    await getTeamsCollection().deleteOne({ _id: r.team._id });
    return reply.status(204).send();
  });

  /** List members of a team. Any org member may read. */
  app.get("/teams/:teamId/members", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { teamId } = request.params as { teamId: string };
    if (!isObjectIdHex(teamId)) {
      return reply.status(404).send({ error: "Team not found" });
    }
    const team = await getTeamsCollection().findOne({
      _id: new ObjectId(teamId),
    });
    if (!team) {
      return reply.status(404).send({ error: "Team not found" });
    }
    const orgMember = await getOrgMembershipsCollection().findOne({
      orgId: team.orgId,
      userId: auth.sub,
    });
    if (!orgMember) {
      return reply.status(404).send({ error: "Team not found" });
    }
    const rows = await getTeamMembershipsCollection()
      .find({ teamId })
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
          joinedAt: m.joinedAt,
        };
      }),
    });
  });

  /** Admin-only: add an org member to a team. */
  app.post("/teams/:teamId/members", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { teamId } = request.params as { teamId: string };
    const r = await requireTeamAdmin(request, reply, auth, teamId);
    if (!r) {
      return;
    }
    const parsed = addTeamMemberBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const isOrgMember = await getOrgMembershipsCollection().findOne({
      orgId: r.team.orgId,
      userId: parsed.data.userId,
    });
    if (!isOrgMember) {
      return reply
        .status(400)
        .send({ error: "User must be a member of the parent organization" });
    }
    await getTeamMembershipsCollection().updateOne(
      { teamId, userId: parsed.data.userId },
      {
        $setOnInsert: {
          teamId,
          userId: parsed.data.userId,
          addedByUserId: auth.sub,
          joinedAt: new Date(),
        },
      },
      { upsert: true },
    );
    return reply.status(204).send();
  });

  /** Admin-only: remove a team member. */
  app.delete(
    "/teams/:teamId/members/:userId",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) {
        return;
      }
      const { teamId, userId } = request.params as {
        teamId: string;
        userId: string;
      };
      const r = await requireTeamAdmin(request, reply, auth, teamId);
      if (!r) {
        return;
      }
      const result = await getTeamMembershipsCollection().deleteOne({
        teamId,
        userId,
      });
      if (result.deletedCount === 0) {
        return reply.status(404).send({ error: "Member not found" });
      }
      return reply.status(204).send();
    },
  );

  /** List grants for a team (which spaces it has access to + role). */
  app.get("/teams/:teamId/grants", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const { teamId } = request.params as { teamId: string };
    if (!isObjectIdHex(teamId)) {
      return reply.status(404).send({ error: "Team not found" });
    }
    const team = await getTeamsCollection().findOne({
      _id: new ObjectId(teamId),
    });
    if (!team) {
      return reply.status(404).send({ error: "Team not found" });
    }
    const orgMember = await getOrgMembershipsCollection().findOne({
      orgId: team.orgId,
      userId: auth.sub,
    });
    if (!orgMember) {
      return reply.status(404).send({ error: "Team not found" });
    }
    const grants = await getTeamSpaceGrantsCollection()
      .find({ teamId })
      .toArray();
    const spaceIds = grants.map((g) => g.spaceId).filter(isObjectIdHex);
    const spaces = await getSpacesCollection()
      .find({ _id: { $in: spaceIds.map((s) => new ObjectId(s)) } })
      .toArray();
    const spacesById = new Map(spaces.map((s) => [s._id.toHexString(), s]));
    return reply.send({
      grants: grants.map((g) => {
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
    if (!auth) {
      return;
    }
    const { teamId } = request.params as { teamId: string };
    const r = await requireTeamAdmin(request, reply, auth, teamId);
    if (!r) {
      return;
    }
    const parsed = grantTeamSpaceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    if (!isObjectIdHex(parsed.data.spaceId)) {
      return reply.status(400).send({ error: "Invalid spaceId" });
    }
    const space = await getSpacesCollection().findOne({
      _id: new ObjectId(parsed.data.spaceId),
    });
    if (!space || space.orgId !== r.team.orgId) {
      return reply
        .status(400)
        .send({ error: "Space must belong to the team's organization" });
    }
    await getTeamSpaceGrantsCollection().updateOne(
      { teamId, spaceId: parsed.data.spaceId },
      {
        $set: {
          role: parsed.data.role,
          grantedByUserId: auth.sub,
          grantedAt: new Date(),
        },
        $setOnInsert: {
          teamId,
          spaceId: parsed.data.spaceId,
        },
      },
      { upsert: true },
    );
    await recordAudit({
      orgId: r.team.orgId,
      actorUserId: auth.sub,
      action: "team.grant.set",
      targetType: "team_space_grant",
      targetId: `${teamId}:${parsed.data.spaceId}`,
      metadata: { teamId, spaceId: parsed.data.spaceId, role: parsed.data.role },
    });
    return reply.status(204).send();
  });

  /** Admin-only: revoke a team's grant on a space. */
  app.delete(
    "/teams/:teamId/grants/:spaceId",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) {
        return;
      }
      const { teamId, spaceId } = request.params as {
        teamId: string;
        spaceId: string;
      };
      const r = await requireTeamAdmin(request, reply, auth, teamId);
      if (!r) {
        return;
      }
      const result = await getTeamSpaceGrantsCollection().deleteOne({
        teamId,
        spaceId,
      });
      if (result.deletedCount === 0) {
        return reply.status(404).send({ error: "Grant not found" });
      }
      return reply.status(204).send();
    },
  );
}
