import "./load-root-env.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import jwt from "jsonwebtoken";
import type { FastifyInstance } from "fastify";
import { ARCHON_SYNC_API_V1_PREFIX } from "./api-v1-prefix.js";
import { buildSyncApiApp } from "./build-app.js";
import { closeMongo, connectMongo } from "./db.js";
import { dropActiveMongoDb, resolveTestMongoUri } from "./test-mongo-helper.js";

const jwtSecret = "dev-only-archon-sync-secret-min-32-chars!!";

test(
  "Phase 1: register sets defaultOrg, admin invites, second user accepts and joins",
  { timeout: 20_000 },
  async (t) => {
    const dbName = `archon_sync_org_it_${randomBytes(8).toString("hex")}`;
    let app: FastifyInstance | undefined;

    try {
      await connectMongo(resolveTestMongoUri(), dbName);
    } catch (err) {
      t.skip(`MongoDB not reachable: ${String(err)}`);
      return;
    }

    try {
      app = await buildSyncApiApp({ jwtSecret, corsOrigin: "true", logger: false });

      // ----- Step 1: register the admin user
      const adminEmail = `admin-${Date.now()}@archon-org.test`;
      const adminPassword = "password12345";
      const reg = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/register`,
        payload: { email: adminEmail, password: adminPassword },
      });
      assert.strictEqual(reg.statusCode, 200, reg.body);
      const regJson = JSON.parse(reg.body) as {
        token: string;
        userId: string;
        defaultOrgId: string;
      };
      assert.ok(regJson.defaultOrgId, "register response must include defaultOrgId");

      const decoded = jwt.verify(regJson.token, jwtSecret) as {
        sub: string;
        email: string;
        activeOrgId?: string;
      };
      assert.strictEqual(
        decoded.activeOrgId,
        regJson.defaultOrgId,
        "JWT must carry activeOrgId matching defaultOrgId",
      );

      const adminAuth = { authorization: `Bearer ${regJson.token}` };

      // ----- Step 2: GET /orgs/me lists the default org as admin
      const orgsMe = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/me`,
        headers: adminAuth,
      });
      assert.strictEqual(orgsMe.statusCode, 200, orgsMe.body);
      const orgsMeJson = JSON.parse(orgsMe.body) as {
        orgs: Array<{ orgId: string; role: string; isDefault: boolean }>;
        activeOrgId: string | null;
        defaultOrgId: string | null;
      };
      assert.strictEqual(orgsMeJson.orgs.length, 1);
      assert.strictEqual(orgsMeJson.orgs[0]!.role, "admin");
      assert.strictEqual(orgsMeJson.orgs[0]!.isDefault, true);
      assert.strictEqual(orgsMeJson.defaultOrgId, regJson.defaultOrgId);

      // ----- Step 3: admin creates an invite
      const inviteEmail = `invitee-${Date.now()}@archon-org.test`;
      const createInvite = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${regJson.defaultOrgId}/invites`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ email: inviteEmail, role: "member" }),
      });
      assert.strictEqual(createInvite.statusCode, 200, createInvite.body);
      const inviteJson = JSON.parse(createInvite.body) as {
        inviteId: string;
        email: string;
        role: string;
        token: string;
      };
      assert.strictEqual(inviteJson.email, inviteEmail);
      assert.strictEqual(inviteJson.role, "member");
      assert.ok(inviteJson.token.length > 20);

      // ----- Step 3b: preview the invite (no auth required)
      const preview = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/invites/preview?token=${encodeURIComponent(inviteJson.token)}`,
      });
      assert.strictEqual(preview.statusCode, 200, preview.body);
      const previewJson = JSON.parse(preview.body) as {
        orgId: string;
        email: string;
        needsPassword: boolean;
      };
      assert.strictEqual(previewJson.email, inviteEmail);
      assert.strictEqual(previewJson.needsPassword, true);

      // ----- Step 4: invitee accepts (creates the account)
      const accept = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/accept-invite`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          token: inviteJson.token,
          password: "newuserpw1234",
          displayName: "Invited User",
        }),
      });
      assert.strictEqual(accept.statusCode, 200, accept.body);
      const acceptJson = JSON.parse(accept.body) as {
        token: string;
        userId: string;
        orgId: string;
        role: string;
        createdUser: boolean;
      };
      assert.strictEqual(acceptJson.orgId, regJson.defaultOrgId);
      assert.strictEqual(acceptJson.role, "member");
      assert.strictEqual(acceptJson.createdUser, true);

      // ----- Step 5: invitee can list orgs and is a member
      const inviteeAuth = { authorization: `Bearer ${acceptJson.token}` };
      const inviteeOrgs = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/me`,
        headers: inviteeAuth,
      });
      assert.strictEqual(inviteeOrgs.statusCode, 200);
      const inviteeOrgsJson = JSON.parse(inviteeOrgs.body) as {
        orgs: Array<{ orgId: string; role: string; isDefault: boolean }>;
      };
      const adminOrgRow = inviteeOrgsJson.orgs.find(
        (o) => o.orgId === regJson.defaultOrgId,
      );
      assert.ok(adminOrgRow, "invitee should belong to the admin's org");
      assert.strictEqual(adminOrgRow.role, "member");

      // ----- Step 6: invitee cannot create invites in the admin's org
      const forbidden = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${regJson.defaultOrgId}/invites`,
        headers: { ...inviteeAuth, "content-type": "application/json" },
        payload: JSON.stringify({ email: "x@x.test", role: "member" }),
      });
      assert.strictEqual(forbidden.statusCode, 403, forbidden.body);

      // ----- Step 7: re-creating the same invite while pending is 409
      const dup = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${regJson.defaultOrgId}/invites`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ email: `dup-${Date.now()}@x.test` }),
      });
      assert.strictEqual(dup.statusCode, 200);
      const dupJson = JSON.parse(dup.body) as { email: string };
      const dup2 = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${regJson.defaultOrgId}/invites`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ email: dupJson.email }),
      });
      assert.strictEqual(dup2.statusCode, 409);

      // ----- Step 8: switch active org returns a new token with new claim
      const setActive = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/active`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ orgId: regJson.defaultOrgId }),
      });
      assert.strictEqual(setActive.statusCode, 200, setActive.body);
      const setActiveJson = JSON.parse(setActive.body) as { token: string };
      const newDecoded = jwt.verify(setActiveJson.token, jwtSecret) as {
        activeOrgId?: string;
      };
      assert.strictEqual(newDecoded.activeOrgId, regJson.defaultOrgId);

      // ----- Step 9: legacy /wpn/workspaces still works (no regression)
      const legacy = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces`,
        headers: adminAuth,
      });
      assert.strictEqual(legacy.statusCode, 200, legacy.body);
    } finally {
      if (app) {
        await app.close();
      }
      await dropActiveMongoDb();
      try {
        await closeMongo();
      } catch {
        /* ignore */
      }
    }
  },
);
