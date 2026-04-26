import "./load-root-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { ARCHON_SYNC_API_V1_PREFIX } from "./api-v1-prefix.js";
import { buildSyncApiApp } from "./build-app.js";
import { setupPgTestSchema, type TestPgSchemaContext } from "./test-pg-helper.js";

const jwtSecret = "dev-only-archon-sync-secret-min-32-chars!!";

test(
  "Phase 3: team grants spaces; member sees space without direct membership; revoke clears access",
  { timeout: 25_000 },
  async (t) => {
    let app: FastifyInstance | undefined;
    let ctx: TestPgSchemaContext | undefined;
    try {
      ctx = await setupPgTestSchema();
    } catch (err) {
      t.skip(`Postgres not reachable: ${String(err)}`);
      return;
    }

    try {
      app = await buildSyncApiApp({ jwtSecret, corsOrigin: "true", logger: false });

      // ----- Admin registers, invites a member who accepts.
      const adminEmail = `admin-${Date.now()}@p3.test`;
      const reg = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/register`,
        payload: { email: adminEmail, password: "password12345" },
      });
      const regJson = JSON.parse(reg.body) as {
        token: string;
        userId: string;
        defaultOrgId: string;
      };
      const adminAuth = { authorization: `Bearer ${regJson.token}` };

      const inviteEmail = `invitee-${Date.now()}@p3.test`;
      const inv = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${regJson.defaultOrgId}/invites`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ email: inviteEmail, role: "member" }),
      });
      const invJson = JSON.parse(inv.body) as { token: string };
      const accept = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/accept-invite`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          token: invJson.token,
          password: "newuserpw1234",
        }),
      });
      const acceptJson = JSON.parse(accept.body) as {
        token: string;
        userId: string;
      };
      const inviteeAuth = { authorization: `Bearer ${acceptJson.token}` };

      // ----- Admin creates an "Engineering" space + drops a workspace into it.
      const eng = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${regJson.defaultOrgId}/spaces`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Engineering" }),
      });
      const engJson = JSON.parse(eng.body) as { spaceId: string };
      const ws = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces`,
        headers: {
          ...adminAuth,
          "content-type": "application/json",
          "x-archon-org": regJson.defaultOrgId,
          "x-archon-space": engJson.spaceId,
        },
        payload: JSON.stringify({ name: "API Service" }),
      });
      const wsJson = JSON.parse(ws.body) as { workspace: { id: string } };

      // ----- Invitee initially cannot see Engineering.
      const before = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engJson.spaceId}/workspaces`,
        headers: inviteeAuth,
      });
      assert.strictEqual(before.statusCode, 404, before.body);

      // ----- Admin creates a "Backend" team.
      const team = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${regJson.defaultOrgId}/teams`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Backend", colorToken: "#7C3AED" }),
      });
      assert.strictEqual(team.statusCode, 200, team.body);
      const teamJson = JSON.parse(team.body) as { teamId: string };

      // Duplicate name → 409.
      const dup = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${regJson.defaultOrgId}/teams`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Backend" }),
      });
      assert.strictEqual(dup.statusCode, 409);

      // ----- Adds invitee to the team.
      const addMember = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/teams/${teamJson.teamId}/members`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ userId: acceptJson.userId }),
      });
      assert.strictEqual(addMember.statusCode, 204, addMember.body);

      // Adding the same member is idempotent.
      const dupAdd = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/teams/${teamJson.teamId}/members`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ userId: acceptJson.userId }),
      });
      assert.strictEqual(dupAdd.statusCode, 204);

      // ----- Grant Backend → Engineering as member. This should give the
      //       invitee read access to Engineering through team mediation.
      const grant = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/teams/${teamJson.teamId}/grants`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ spaceId: engJson.spaceId, role: "member" }),
      });
      assert.strictEqual(grant.statusCode, 204, grant.body);

      // ----- Invitee now sees Engineering's workspace despite no direct
      //       row in space_memberships.
      const after = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engJson.spaceId}/workspaces`,
        headers: inviteeAuth,
      });
      assert.strictEqual(after.statusCode, 200, after.body);
      const afterJson = JSON.parse(after.body) as {
        workspaces: Array<{ id: string }>;
      };
      assert.ok(afterJson.workspaces.some((w) => w.id === wsJson.workspace.id));

      // GET /spaces/me reflects the team-mediated membership.
      const inviteeSpacesMe = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/me`,
        headers: inviteeAuth,
      });
      assert.strictEqual(inviteeSpacesMe.statusCode, 200);
      const spacesMeJson = JSON.parse(inviteeSpacesMe.body) as {
        spaces: Array<{ spaceId: string; role: string }>;
      };
      assert.ok(
        spacesMeJson.spaces.some(
          (s) => s.spaceId === engJson.spaceId && s.role === "member",
        ),
        "invitee should see Engineering via team grant in /spaces/me",
      );

      // ----- Re-grant as owner → role upgrades.
      const regrant = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/teams/${teamJson.teamId}/grants`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ spaceId: engJson.spaceId, role: "owner" }),
      });
      assert.strictEqual(regrant.statusCode, 204);

      // Invitee can now PATCH the space (owner-only) via team-mediated owner role.
      // The route returns 200 with the updated space body (REST convention),
      // not 204 No Content.
      const renameAttempt = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engJson.spaceId}`,
        headers: { ...inviteeAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Engineering Renamed" }),
      });
      assert.strictEqual(renameAttempt.statusCode, 200, renameAttempt.body);
      const renameBody = JSON.parse(renameAttempt.body) as { name: string };
      assert.strictEqual(renameBody.name, "Engineering Renamed");

      // ----- Cross-org grant is rejected.
      const otherEmail = `other-${Date.now()}@p3.test`;
      const otherReg = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/register`,
        payload: { email: otherEmail, password: "password12345" },
      });
      const otherJson = JSON.parse(otherReg.body) as { defaultOrgId: string };
      const fakeSpace = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${otherJson.defaultOrgId}/spaces`,
        headers: {
          authorization: `Bearer ${(JSON.parse(otherReg.body) as { token: string }).token}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ name: "Other-Space" }),
      });
      const fakeSpaceJson = JSON.parse(fakeSpace.body) as { spaceId: string };
      const crossOrgGrant = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/teams/${teamJson.teamId}/grants`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ spaceId: fakeSpaceJson.spaceId, role: "member" }),
      });
      assert.strictEqual(crossOrgGrant.statusCode, 400);

      // ----- Revoke grant clears access.
      const revoke = await app.inject({
        method: "DELETE",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/teams/${teamJson.teamId}/grants/${engJson.spaceId}`,
        headers: adminAuth,
      });
      assert.strictEqual(revoke.statusCode, 204);
      const after2 = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engJson.spaceId}/workspaces`,
        headers: inviteeAuth,
      });
      assert.strictEqual(after2.statusCode, 404, "team-mediated access must end after revoke");

      // ----- Removing a team member also revokes access (re-grant first).
      await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/teams/${teamJson.teamId}/grants`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ spaceId: engJson.spaceId, role: "member" }),
      });
      const removeMember = await app.inject({
        method: "DELETE",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/teams/${teamJson.teamId}/members/${acceptJson.userId}`,
        headers: adminAuth,
      });
      assert.strictEqual(removeMember.statusCode, 204);
      const after3 = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engJson.spaceId}/workspaces`,
        headers: inviteeAuth,
      });
      assert.strictEqual(after3.statusCode, 404, "removing team member ends mediated access");

      // ----- Non-admin invitee cannot create teams in this org.
      const inviteeCreateTeam = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${regJson.defaultOrgId}/teams`,
        headers: { ...inviteeAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Should-Fail" }),
      });
      assert.strictEqual(inviteeCreateTeam.statusCode, 403);

      // ----- Delete team cascades memberships + grants.
      await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/teams/${teamJson.teamId}/grants`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ spaceId: engJson.spaceId, role: "member" }),
      });
      const del = await app.inject({
        method: "DELETE",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/teams/${teamJson.teamId}`,
        headers: adminAuth,
      });
      assert.strictEqual(del.statusCode, 204);
      const grantsAfter = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/teams/${teamJson.teamId}/grants`,
        headers: adminAuth,
      });
      assert.strictEqual(grantsAfter.statusCode, 404);
    } finally {
      if (app) {
        await app.close();
      }
      await ctx?.teardown();
    }
  },
);
