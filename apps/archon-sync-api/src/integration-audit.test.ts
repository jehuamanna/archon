import "./load-root-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { ARCHON_SYNC_API_V1_PREFIX } from "./api-v1-prefix.js";
import { buildSyncApiApp } from "./build-app.js";
import { setupPgTestSchema, type TestPgSchemaContext } from "./test-pg-helper.js";

const jwtSecret = "dev-only-archon-sync-secret-min-32-chars!!";

test(
  "Phase 7: audit log captures admin actions; admin-only; paginated",
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

      const adminReg = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/register`,
        payload: { email: `admin-${Date.now()}@p7.test`, password: "password12345" },
      });
      const admin = JSON.parse(adminReg.body) as {
        token: string;
        userId: string;
        defaultOrgId: string;
      };
      const adminAuth = { authorization: `Bearer ${admin.token}` };

      // Generate several distinct audited actions.
      const inv = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/invites`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ email: `mem-${Date.now()}@p7.test`, role: "member" }),
      });
      const invJson = JSON.parse(inv.body) as { token: string };
      const accept = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/accept-invite`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ token: invJson.token, password: "newuserpw1234" }),
      });
      const member = JSON.parse(accept.body) as { token: string; userId: string };

      const eng = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/spaces`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Engineering" }),
      });
      const engJson = JSON.parse(eng.body) as { spaceId: string };
      await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engJson.spaceId}/members`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ userId: member.userId, role: "member" }),
      });

      const team = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/teams`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Backend", colorToken: "#7C3AED" }),
      });
      const teamJson = JSON.parse(team.body) as { teamId: string };
      await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/teams/${teamJson.teamId}/grants`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ spaceId: engJson.spaceId, role: "member" }),
      });

      // Read audit log.
      const audit = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/audit`,
        headers: adminAuth,
      });
      assert.strictEqual(audit.statusCode, 200);
      const auditJson = JSON.parse(audit.body) as {
        events: Array<{ action: string; actorUserId: string; targetType: string }>;
        nextBefore: number | null;
      };
      const actions = new Set(auditJson.events.map((e) => e.action));
      for (const expected of [
        "org.invite.create",
        "org.invite.accept",
        "space.create",
        "space.member.add",
        "team.create",
        "team.grant.set",
      ]) {
        assert.ok(actions.has(expected), `missing audit action: ${expected}`);
      }

      // Non-admin (member) gets 403.
      const memberAudit = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/audit`,
        headers: { authorization: `Bearer ${member.token}` },
      });
      assert.strictEqual(memberAudit.statusCode, 403);

      // Pagination: limit=2, then nextBefore continues.
      const page1 = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/audit?limit=2`,
        headers: adminAuth,
      });
      assert.strictEqual(page1.statusCode, 200);
      const page1Json = JSON.parse(page1.body) as {
        events: unknown[];
        nextBefore: number | null;
      };
      assert.strictEqual(page1Json.events.length, 2);
      assert.ok(page1Json.nextBefore !== null);
      const page2 = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/audit?limit=2&before=${page1Json.nextBefore}`,
        headers: adminAuth,
      });
      assert.strictEqual(page2.statusCode, 200);
      const page2Json = JSON.parse(page2.body) as { events: unknown[] };
      assert.ok(page2Json.events.length > 0);
    } finally {
      if (app) await app.close();
      await ctx?.teardown();
    }
  },
);
