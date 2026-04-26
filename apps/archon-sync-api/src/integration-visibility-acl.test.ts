import "./load-root-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { ARCHON_SYNC_API_V1_PREFIX } from "./api-v1-prefix.js";
import { buildSyncApiApp } from "./build-app.js";
import { setupPgTestSchema, type TestPgSchemaContext } from "./test-pg-helper.js";

const jwtSecret = "dev-only-archon-sync-secret-min-32-chars!!";

async function registerUser(
  app: FastifyInstance,
  email: string,
): Promise<{ token: string; userId: string; defaultOrgId: string }> {
  const r = await app.inject({
    method: "POST",
    url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/register`,
    payload: { email, password: "password12345" },
  });
  return JSON.parse(r.body) as {
    token: string;
    userId: string;
    defaultOrgId: string;
  };
}

async function inviteAndAccept(
  app: FastifyInstance,
  adminAuth: Record<string, string>,
  orgId: string,
  email: string,
): Promise<{ token: string; userId: string }> {
  const inv = await app.inject({
    method: "POST",
    url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${orgId}/invites`,
    headers: { ...adminAuth, "content-type": "application/json" },
    payload: JSON.stringify({ email, role: "member" }),
  });
  const invJson = JSON.parse(inv.body) as { token: string };
  const accept = await app.inject({
    method: "POST",
    url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/accept-invite`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ token: invJson.token, password: "newuserpw1234" }),
  });
  return JSON.parse(accept.body) as { token: string; userId: string };
}

test(
  "Phase 4: workspace visibility (public/private/shared) gates reads correctly",
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

      // Admin (creator), member-A (will be in space), member-B (will be in space + shared list).
      const admin = await registerUser(app, `admin-${Date.now()}@p4.test`);
      const adminAuth = { authorization: `Bearer ${admin.token}` };
      const memberA = await inviteAndAccept(
        app, adminAuth, admin.defaultOrgId, `mem-a-${Date.now()}@p4.test`,
      );
      const memberB = await inviteAndAccept(
        app, adminAuth, admin.defaultOrgId, `mem-b-${Date.now()}@p4.test`,
      );
      const memberAAuth = { authorization: `Bearer ${memberA.token}` };
      const memberBAuth = { authorization: `Bearer ${memberB.token}` };

      // Admin creates Engineering and adds both members.
      const eng = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/spaces`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Engineering" }),
      });
      const engJson = JSON.parse(eng.body) as { spaceId: string };
      for (const m of [memberA, memberB]) {
        await app.inject({
          method: "POST",
          url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engJson.spaceId}/members`,
          headers: { ...adminAuth, "content-type": "application/json" },
          payload: JSON.stringify({ userId: m.userId, role: "member" }),
        });
      }

      // Admin creates a workspace inside Engineering (default visibility=public).
      const wsCreate = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces`,
        headers: {
          ...adminAuth,
          "content-type": "application/json",
          "x-archon-org": admin.defaultOrgId,
          "x-archon-space": engJson.spaceId,
        },
        payload: JSON.stringify({ name: "API Service" }),
      });
      const wsId = (JSON.parse(wsCreate.body) as { workspace: { id: string } })
        .workspace.id;
      const projects = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/projects`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Backend" }),
      });
      assert.strictEqual(projects.statusCode, 201);

      // Public default → member-A and member-B can both read /projects.
      const pubA = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/projects`,
        headers: memberAAuth,
      });
      assert.strictEqual(pubA.statusCode, 200, pubA.body);

      // Set visibility=private → only the creator (admin) sees it.
      const setPrivate = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/visibility`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ visibility: "private" }),
      });
      assert.strictEqual(setPrivate.statusCode, 200);

      const privA = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/projects`,
        headers: memberAAuth,
      });
      assert.strictEqual(privA.statusCode, 404, "private excludes other space members");

      const privAdmin = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/projects`,
        headers: adminAuth,
      });
      assert.strictEqual(privAdmin.statusCode, 200, "creator can still read private");

      // Set visibility=shared and add member-B to the share list.
      const setShared = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/visibility`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ visibility: "shared" }),
      });
      assert.strictEqual(setShared.statusCode, 200);
      const addShare = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/shares`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ userId: memberB.userId }),
      });
      assert.strictEqual(addShare.statusCode, 204, addShare.body);

      const sharedA = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/projects`,
        headers: memberAAuth,
      });
      assert.strictEqual(sharedA.statusCode, 404, "non-shared member excluded from shared workspace");
      const sharedB = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/projects`,
        headers: memberBAuth,
      });
      assert.strictEqual(sharedB.statusCode, 200, "shared member sees shared workspace");

      // Outsider (different org) gets 404.
      const outsider = await registerUser(app, `out-${Date.now()}@p4.test`);
      const outsiderRead = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/projects`,
        headers: { authorization: `Bearer ${outsider.token}` },
      });
      assert.strictEqual(outsiderRead.statusCode, 404);

      // Member-B can read the workspace but is not a creator/owner → cannot mutate.
      const memberBPatch = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}`,
        headers: { ...memberBAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Hijack" }),
      });
      assert.strictEqual(memberBPatch.statusCode, 403);

      // Toggle back to public → member-A regains access immediately.
      const setPublic = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/visibility`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ visibility: "public" }),
      });
      assert.strictEqual(setPublic.statusCode, 200);
      const pubAAfter = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/projects`,
        headers: memberAAuth,
      });
      assert.strictEqual(pubAAfter.statusCode, 200);

      // Audit row created for visibility change (Phase 7 instrumentation).
      const audit = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/audit`,
        headers: adminAuth,
      });
      assert.strictEqual(audit.statusCode, 200);
      const auditJson = JSON.parse(audit.body) as {
        events: Array<{ action: string; targetId: string }>;
      };
      const visEvent = auditJson.events.find(
        (e) => e.action === "workspace.visibility.set" && e.targetId === wsId,
      );
      assert.ok(visEvent, "visibility change must be in the audit log");
    } finally {
      if (app) await app.close();
      await ctx?.teardown();
    }
  },
);
