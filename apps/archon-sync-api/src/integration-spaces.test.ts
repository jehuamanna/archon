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
  "Phase 2: default space backfilled, second space + member visibility, last-owner protection",
  { timeout: 20_000 },
  async (t) => {
    const dbName = `archon_sync_spaces_it_${randomBytes(8).toString("hex")}`;
    let app: FastifyInstance | undefined;

    try {
      await connectMongo(resolveTestMongoUri(), dbName);
    } catch (err) {
      t.skip(`MongoDB not reachable: ${String(err)}`);
      return;
    }

    try {
      app = await buildSyncApiApp({ jwtSecret, corsOrigin: "true", logger: false });

      // ----- Admin registers + invites + invitee accepts (Phase 1 surface)
      const adminEmail = `admin-${Date.now()}@p2.test`;
      const reg = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/register`,
        payload: { email: adminEmail, password: "password12345" },
      });
      assert.strictEqual(reg.statusCode, 200);
      const regJson = JSON.parse(reg.body) as {
        token: string;
        userId: string;
        defaultOrgId: string;
      };
      const adminAuth = { authorization: `Bearer ${regJson.token}` };

      // ----- Default space exists for the new org and admin is its owner
      const orgSpaces = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${regJson.defaultOrgId}/spaces`,
        headers: adminAuth,
      });
      assert.strictEqual(orgSpaces.statusCode, 200, orgSpaces.body);
      const orgSpacesJson = JSON.parse(orgSpaces.body) as {
        spaces: Array<{
          spaceId: string;
          kind: string;
          role: string | null;
          name: string;
        }>;
      };
      assert.strictEqual(orgSpacesJson.spaces.length, 1);
      const defaultSpace = orgSpacesJson.spaces[0]!;
      assert.strictEqual(defaultSpace.kind, "default");
      assert.strictEqual(defaultSpace.role, "owner");

      // ----- Invite a second user
      const inviteEmail = `invitee-${Date.now()}@p2.test`;
      const inv = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${regJson.defaultOrgId}/invites`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ email: inviteEmail, role: "member" }),
      });
      assert.strictEqual(inv.statusCode, 200);
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
      assert.strictEqual(accept.statusCode, 200);
      const acceptJson = JSON.parse(accept.body) as {
        token: string;
        userId: string;
      };
      const inviteeAuth = { authorization: `Bearer ${acceptJson.token}` };

      // ----- Invitee can list spaces in the org → admin sees all, invitee
      //       (org member, not yet space member) sees nothing.
      const inviteeOrgSpaces = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${regJson.defaultOrgId}/spaces`,
        headers: inviteeAuth,
      });
      assert.strictEqual(inviteeOrgSpaces.statusCode, 200);
      const inviteeSpacesList = JSON.parse(inviteeOrgSpaces.body) as {
        spaces: unknown[];
      };
      assert.strictEqual(inviteeSpacesList.spaces.length, 0);

      // ----- Admin creates a second Space; admin is owner.
      const newSpace = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${regJson.defaultOrgId}/spaces`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Engineering" }),
      });
      assert.strictEqual(newSpace.statusCode, 200, newSpace.body);
      const newSpaceJson = JSON.parse(newSpace.body) as {
        spaceId: string;
        role: string;
        kind: string;
      };
      assert.strictEqual(newSpaceJson.role, "owner");
      assert.strictEqual(newSpaceJson.kind, "normal");

      // ----- Admin adds invitee to Engineering as member.
      const addMember = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${newSpaceJson.spaceId}/members`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ userId: acceptJson.userId, role: "member" }),
      });
      assert.strictEqual(addMember.statusCode, 204, addMember.body);

      // ----- Invitee can now see Engineering in the org spaces listing.
      const inviteeOrgSpaces2 = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${regJson.defaultOrgId}/spaces`,
        headers: inviteeAuth,
      });
      const inviteeSpaces2 = JSON.parse(inviteeOrgSpaces2.body) as {
        spaces: Array<{ spaceId: string; role: string | null; name: string }>;
      };
      const eng = inviteeSpaces2.spaces.find(
        (s) => s.spaceId === newSpaceJson.spaceId,
      );
      assert.ok(eng, "invitee should see Engineering after being added");
      assert.strictEqual(eng.role, "member");

      // ----- Invitee can NOT delete the space (owner-only).
      const inviteeDelete = await app.inject({
        method: "DELETE",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${newSpaceJson.spaceId}`,
        headers: inviteeAuth,
      });
      assert.strictEqual(inviteeDelete.statusCode, 403, inviteeDelete.body);

      // ----- Switch active space → JWT carries activeSpaceId claim.
      const setActive = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/active`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ spaceId: newSpaceJson.spaceId }),
      });
      assert.strictEqual(setActive.statusCode, 200, setActive.body);
      const setActiveJson = JSON.parse(setActive.body) as {
        token: string;
        activeSpaceId: string;
      };
      const decoded = jwt.verify(setActiveJson.token, jwtSecret) as {
        activeSpaceId?: string;
        activeOrgId?: string;
      };
      assert.strictEqual(decoded.activeSpaceId, newSpaceJson.spaceId);
      assert.strictEqual(decoded.activeOrgId, regJson.defaultOrgId);

      // ----- Workspace created with X-Archon-Space header lands in that space.
      const wsInSpace = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces`,
        headers: {
          ...adminAuth,
          "content-type": "application/json",
          "x-archon-org": regJson.defaultOrgId,
          "x-archon-space": newSpaceJson.spaceId,
        },
        payload: JSON.stringify({ name: "Eng WS" }),
      });
      assert.strictEqual(wsInSpace.statusCode, 201, wsInSpace.body);
      const wsInSpaceJson = JSON.parse(wsInSpace.body) as {
        workspace: { id: string; orgId?: string; spaceId?: string };
      };
      assert.strictEqual(wsInSpaceJson.workspace.spaceId, newSpaceJson.spaceId);
      assert.strictEqual(wsInSpaceJson.workspace.orgId, regJson.defaultOrgId);

      // ----- Space-scoped workspace listing returns it for members…
      const adminListInSpace = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${newSpaceJson.spaceId}/workspaces`,
        headers: adminAuth,
      });
      assert.strictEqual(adminListInSpace.statusCode, 200);
      const adminWsList = JSON.parse(adminListInSpace.body) as {
        workspaces: Array<{ id: string }>;
      };
      assert.ok(adminWsList.workspaces.some((w) => w.id === wsInSpaceJson.workspace.id));

      // …and refuses non-members.
      const outsiderRegEmail = `outsider-${Date.now()}@p2.test`;
      const outsiderReg = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/register`,
        payload: { email: outsiderRegEmail, password: "password12345" },
      });
      assert.strictEqual(outsiderReg.statusCode, 200);
      const outsiderJson = JSON.parse(outsiderReg.body) as { token: string };
      const outsiderListInSpace = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${newSpaceJson.spaceId}/workspaces`,
        headers: { authorization: `Bearer ${outsiderJson.token}` },
      });
      assert.strictEqual(outsiderListInSpace.statusCode, 404);

      // ----- Last-owner protection: admin (sole owner) cannot demote self.
      const demoteSelf = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${newSpaceJson.spaceId}/members/${regJson.userId}/role`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ role: "member" }),
      });
      assert.strictEqual(demoteSelf.statusCode, 400);

      // ----- Default space cannot be deleted.
      const deleteDefault = await app.inject({
        method: "DELETE",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${defaultSpace.spaceId}`,
        headers: adminAuth,
      });
      assert.strictEqual(deleteDefault.statusCode, 400);

      // ----- Engineering still has a workspace, so admin's delete attempt is refused.
      const tryDeleteEng = await app.inject({
        method: "DELETE",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${newSpaceJson.spaceId}`,
        headers: adminAuth,
      });
      assert.strictEqual(tryDeleteEng.statusCode, 400);

      // ----- Legacy /wpn/workspaces still works for the admin.
      const legacy = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces`,
        headers: adminAuth,
      });
      assert.strictEqual(legacy.statusCode, 200);
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
