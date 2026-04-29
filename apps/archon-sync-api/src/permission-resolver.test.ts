/**
 * Permission resolver coverage. Exercises the `team_projects` ↔
 * `team_memberships` join folded by `getEffectiveProjectRoles`, plus the
 * org-admin and per-action assertion paths. Runs against an isolated PG
 * schema like the other integration tests; skips when Postgres is not
 * reachable.
 */
import "./load-root-env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  setupPgTestSchema,
  type TestPgSchemaContext,
  factoryUser,
  factoryOrg,
  factoryOrgMembership,
  factoryDepartment,
  factoryTeam,
  factoryTeamMembership,
  factoryProject,
} from "./test-pg-helper.js";
import {
  effectiveRoleInProject,
  getEffectiveProjectRoles,
  userCanReadProject,
  userCanWriteProject,
} from "./permission-resolver.js";
import { getDb } from "./pg.js";
import { teamProjects, users } from "./db/schema.js";
import { eq } from "drizzle-orm";

async function withSchema(
  fn: (ctx: TestPgSchemaContext) => Promise<void>,
  skip: (reason: string) => void,
): Promise<void> {
  let ctx: TestPgSchemaContext | undefined;
  try {
    ctx = await setupPgTestSchema();
  } catch (err) {
    skip(`Postgres not reachable: ${String(err)}`);
    return;
  }
  try {
    await fn(ctx);
  } finally {
    await ctx.teardown();
  }
}

describe("getEffectiveProjectRoles", () => {
  it("returns empty map when the user is on no teams", async (t) => {
    await withSchema(async () => {
      const userId = await factoryUser({ email: `lone-${Date.now()}@p.test` });
      const roles = await getEffectiveProjectRoles(userId);
      assert.equal(roles.size, 0);
    }, t.skip.bind(t));
  });

  it("surfaces the team's role on each granted project", async (t) => {
    await withSchema(async () => {
      const userId = await factoryUser({
        email: `solo-${Date.now()}@p.test`,
      });
      const orgId = await factoryOrg({ ownerUserId: userId });
      const departmentId = await factoryDepartment({
        orgId,
        createdByUserId: userId,
      });
      const teamId = await factoryTeam({
        orgId,
        departmentId,
        createdByUserId: userId,
      });
      await factoryTeamMembership({
        teamId,
        userId,
        addedByUserId: userId,
        role: "member",
      });
      const projectAlpha = await factoryProject({
        orgId,
        creatorUserId: userId,
        teamId,
        teamRole: "contributor",
      });
      const projectBeta = await factoryProject({
        orgId,
        creatorUserId: userId,
        teamId,
        teamRole: "viewer",
      });

      const roles = await getEffectiveProjectRoles(userId);
      assert.equal(roles.size, 2);
      assert.equal(roles.get(projectAlpha), "contributor");
      assert.equal(roles.get(projectBeta), "viewer");
    }, t.skip.bind(t));
  });

  it("folds two teams' grants on the same project to the strongest role", async (t) => {
    await withSchema(async () => {
      const userId = await factoryUser({
        email: `multi-${Date.now()}@p.test`,
      });
      const orgId = await factoryOrg({ ownerUserId: userId });
      const departmentId = await factoryDepartment({
        orgId,
        createdByUserId: userId,
      });
      const teamA = await factoryTeam({
        orgId,
        departmentId,
        createdByUserId: userId,
        name: "Team A",
      });
      const teamB = await factoryTeam({
        orgId,
        departmentId,
        createdByUserId: userId,
        name: "Team B",
      });
      await factoryTeamMembership({
        teamId: teamA,
        userId,
        addedByUserId: userId,
      });
      await factoryTeamMembership({
        teamId: teamB,
        userId,
        addedByUserId: userId,
      });
      // Same project granted to both teams: A=viewer, B=owner.
      // The fold takes the max → owner.
      const projectId = await factoryProject({
        orgId,
        creatorUserId: userId,
        teamId: teamA,
        teamRole: "viewer",
      });
      await getDb()
        .insert(teamProjects)
        .values({
          teamId: teamB,
          projectId,
          role: "owner",
          grantedByUserId: userId,
          grantedAt: new Date(),
        });

      const roles = await getEffectiveProjectRoles(userId);
      assert.equal(roles.get(projectId), "owner");
    }, t.skip.bind(t));
  });

  it("ignores projects whose teams the user is not on", async (t) => {
    await withSchema(async () => {
      const ownerId = await factoryUser({
        email: `owner-${Date.now()}@p.test`,
      });
      const otherId = await factoryUser({
        email: `other-${Date.now()}@p.test`,
      });
      const orgId = await factoryOrg({ ownerUserId: ownerId });
      const departmentId = await factoryDepartment({
        orgId,
        createdByUserId: ownerId,
      });
      const ownerTeam = await factoryTeam({
        orgId,
        departmentId,
        createdByUserId: ownerId,
      });
      await factoryTeamMembership({
        teamId: ownerTeam,
        userId: ownerId,
        addedByUserId: ownerId,
      });
      // Project granted only to ownerTeam.
      await factoryProject({
        orgId,
        creatorUserId: ownerId,
        teamId: ownerTeam,
        teamRole: "owner",
      });

      const otherRoles = await getEffectiveProjectRoles(otherId);
      assert.equal(otherRoles.size, 0);
    }, t.skip.bind(t));
  });
});

describe("effectiveRoleInProject", () => {
  it("returns null when the user has no grant on the project", async (t) => {
    await withSchema(async () => {
      const ownerId = await factoryUser({
        email: `o-${Date.now()}@p.test`,
      });
      const otherId = await factoryUser({
        email: `x-${Date.now()}@p.test`,
      });
      const orgId = await factoryOrg({ ownerUserId: ownerId });
      const departmentId = await factoryDepartment({
        orgId,
        createdByUserId: ownerId,
      });
      const teamId = await factoryTeam({
        orgId,
        departmentId,
        createdByUserId: ownerId,
      });
      await factoryTeamMembership({
        teamId,
        userId: ownerId,
        addedByUserId: ownerId,
      });
      const projectId = await factoryProject({
        orgId,
        creatorUserId: ownerId,
        teamId,
        teamRole: "owner",
      });
      const role = await effectiveRoleInProject(otherId, projectId);
      assert.equal(role, null);
    }, t.skip.bind(t));
  });

  it("returns the role for the granted project", async (t) => {
    await withSchema(async () => {
      const userId = await factoryUser({ email: `u-${Date.now()}@p.test` });
      const orgId = await factoryOrg({ ownerUserId: userId });
      const departmentId = await factoryDepartment({
        orgId,
        createdByUserId: userId,
      });
      const teamId = await factoryTeam({
        orgId,
        departmentId,
        createdByUserId: userId,
      });
      await factoryTeamMembership({
        teamId,
        userId,
        addedByUserId: userId,
      });
      const projectId = await factoryProject({
        orgId,
        creatorUserId: userId,
        teamId,
        teamRole: "contributor",
      });
      const role = await effectiveRoleInProject(userId, projectId);
      assert.equal(role, "contributor");
    }, t.skip.bind(t));
  });
});

describe("userCanReadProject + userCanWriteProject", () => {
  it("read returns false when no role; write returns false when only viewer", async (t) => {
    await withSchema(async () => {
      const ownerId = await factoryUser({
        email: `roOwner-${Date.now()}@p.test`,
      });
      const viewerId = await factoryUser({
        email: `roView-${Date.now()}@p.test`,
      });
      const orgId = await factoryOrg({ ownerUserId: ownerId });
      const departmentId = await factoryDepartment({
        orgId,
        createdByUserId: ownerId,
      });
      // Two teams under the same dept.
      const ownerTeam = await factoryTeam({
        orgId,
        departmentId,
        createdByUserId: ownerId,
        name: "Owner Team",
      });
      const viewerTeam = await factoryTeam({
        orgId,
        departmentId,
        createdByUserId: ownerId,
        name: "Viewer Team",
      });
      await factoryTeamMembership({
        teamId: ownerTeam,
        userId: ownerId,
        addedByUserId: ownerId,
      });
      await factoryTeamMembership({
        teamId: viewerTeam,
        userId: viewerId,
        addedByUserId: ownerId,
      });
      // Make viewerId an org *member* (not admin) so the per-project role
      // is the only path to access. factoryOrg only enrols the ownerUserId
      // as admin; manually add viewerId as a plain member.
      await factoryOrgMembership({
        orgId,
        userId: viewerId,
        role: "member",
      });
      // Project granted to ownerTeam=owner, viewerTeam=viewer.
      const projectId = await factoryProject({
        orgId,
        creatorUserId: ownerId,
        teamId: ownerTeam,
        teamRole: "owner",
      });
      await getDb()
        .insert(teamProjects)
        .values({
          teamId: viewerTeam,
          projectId,
          role: "viewer",
          grantedByUserId: ownerId,
          grantedAt: new Date(),
        });

      // owner: can read, can write.
      assert.equal(await userCanReadProject(ownerId, projectId), true);
      assert.equal(
        await userCanWriteProject({ sub: ownerId } as never, projectId),
        true,
      );
      // viewer: can read, CANNOT write.
      assert.equal(await userCanReadProject(viewerId, projectId), true);
      assert.equal(
        await userCanWriteProject({ sub: viewerId } as never, projectId),
        false,
      );

      // A user with no team membership: cannot read.
      const strangerId = await factoryUser({
        email: `strange-${Date.now()}@p.test`,
      });
      assert.equal(await userCanReadProject(strangerId, projectId), false);
    }, t.skip.bind(t));
  });

  it("org-admin role bypasses team grants entirely", async (t) => {
    await withSchema(async () => {
      const ownerId = await factoryUser({
        email: `ad-${Date.now()}@p.test`,
      });
      const adminId = await factoryUser({
        email: `adm-${Date.now()}@p.test`,
      });
      const orgId = await factoryOrg({ ownerUserId: ownerId });
      // Promote `adminId` to org-admin.
      await factoryOrgMembership({ orgId, userId: adminId, role: "admin" });
      const departmentId = await factoryDepartment({
        orgId,
        createdByUserId: ownerId,
      });
      const teamId = await factoryTeam({
        orgId,
        departmentId,
        createdByUserId: ownerId,
      });
      await factoryTeamMembership({
        teamId,
        userId: ownerId,
        addedByUserId: ownerId,
      });
      const projectId = await factoryProject({
        orgId,
        creatorUserId: ownerId,
        teamId,
        teamRole: "owner",
      });

      // adminId has NO team membership → no project grant → but org-admin
      // bypasses this gate.
      const r = await getEffectiveProjectRoles(adminId);
      assert.equal(r.has(projectId), false, "no per-project role for org-admin");
      assert.equal(await userCanReadProject(adminId, projectId), true);
      assert.equal(
        await userCanWriteProject({ sub: adminId } as never, projectId),
        true,
      );
    }, t.skip.bind(t));
  });

  it("master-admin bypasses both team grants and org membership", async (t) => {
    await withSchema(async () => {
      const ownerId = await factoryUser({
        email: `mo-${Date.now()}@p.test`,
      });
      const masterId = await factoryUser({
        email: `mast-${Date.now()}@p.test`,
      });
      // Mark masterId as platform master admin.
      await getDb()
        .update(users)
        .set({ isMasterAdmin: true })
        .where(eq(users.id, masterId));
      const orgId = await factoryOrg({ ownerUserId: ownerId });
      const departmentId = await factoryDepartment({
        orgId,
        createdByUserId: ownerId,
      });
      const teamId = await factoryTeam({
        orgId,
        departmentId,
        createdByUserId: ownerId,
      });
      await factoryTeamMembership({
        teamId,
        userId: ownerId,
        addedByUserId: ownerId,
      });
      const projectId = await factoryProject({
        orgId,
        creatorUserId: ownerId,
        teamId,
        teamRole: "owner",
      });

      // masterId is in NO org membership but should still pass the read
      // (master-admin override). Write also passes — master-admin is the
      // platform escape hatch.
      assert.equal(await userCanReadProject(masterId, projectId), true);
      assert.equal(
        await userCanWriteProject({ sub: masterId } as never, projectId),
        true,
      );
    }, t.skip.bind(t));
  });
});
