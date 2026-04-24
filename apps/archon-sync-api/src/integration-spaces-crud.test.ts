import "./load-root-env.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { ARCHON_SYNC_API_V1_PREFIX } from "./api-v1-prefix.js";
import { buildSyncApiApp } from "./build-app.js";
import {
  closeMongo,
  connectMongo,
  getAuditEventsCollection,
} from "./db.js";
import { dropActiveMongoDb, resolveTestMongoUri } from "./test-mongo-helper.js";

const jwtSecret = "dev-only-archon-sync-secret-min-32-chars!!";

async function registerUser(
  app: FastifyInstance,
  email: string,
): Promise<{ token: string; userId: string; defaultOrgId: string }> {
  const res = await app.inject({
    method: "POST",
    url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/register`,
    payload: { email, password: "password12345" },
  });
  assert.strictEqual(res.statusCode, 200, res.body);
  return JSON.parse(res.body);
}

async function inviteAndAccept(
  app: FastifyInstance,
  adminAuthHeader: Record<string, string>,
  orgId: string,
  email: string,
): Promise<{ token: string; userId: string }> {
  const inv = await app.inject({
    method: "POST",
    url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${orgId}/invites`,
    headers: { ...adminAuthHeader, "content-type": "application/json" },
    payload: JSON.stringify({ email, role: "member" }),
  });
  assert.strictEqual(inv.statusCode, 200, inv.body);
  const invJson = JSON.parse(inv.body) as { token: string };
  const accept = await app.inject({
    method: "POST",
    url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/accept-invite`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ token: invJson.token, password: "newuserpw1234" }),
  });
  assert.strictEqual(accept.statusCode, 200, accept.body);
  return JSON.parse(accept.body);
}

test(
  "Admin Spaces CRUD: rename + hide + includeHidden + audit rows",
  { timeout: 30_000 },
  async (t) => {
    const dbName = `archon_sync_spaces_crud_it_${randomBytes(8).toString("hex")}`;
    let app: FastifyInstance | undefined;

    try {
      await connectMongo(resolveTestMongoUri(), dbName);
    } catch (err) {
      t.skip(`MongoDB not reachable: ${String(err)}`);
      return;
    }

    try {
      app = await buildSyncApiApp({
        jwtSecret,
        corsOrigin: "true",
        logger: false,
      });

      // ----- Setup: admin + two normal users in one org.
      const admin = await registerUser(app, `crud-admin-${Date.now()}@p2.test`);
      const adminAuth = { authorization: `Bearer ${admin.token}` };
      const member = await inviteAndAccept(
        app,
        adminAuth,
        admin.defaultOrgId,
        `crud-member-${Date.now()}@p2.test`,
      );
      const memberAuth = { authorization: `Bearer ${member.token}` };

      // Locate the default space.
      const listDefault = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/spaces`,
        headers: adminAuth,
      });
      assert.strictEqual(listDefault.statusCode, 200, listDefault.body);
      const defaultListJson = JSON.parse(listDefault.body) as {
        spaces: Array<{ spaceId: string; kind: string }>;
      };
      const defaultSpaceId = defaultListJson.spaces.find(
        (s) => s.kind === "default",
      )!.spaceId;

      // Admin creates Engineering (normal space).
      const engRes = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/spaces`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Engineering" }),
      });
      assert.strictEqual(engRes.statusCode, 200, engRes.body);
      const engId = (JSON.parse(engRes.body) as { spaceId: string }).spaceId;

      // Admin creates Finance (to exercise name-conflict later).
      const finRes = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/spaces`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Finance" }),
      });
      assert.strictEqual(finRes.statusCode, 200, finRes.body);

      // ----- PATCH rename — success, emits space.rename audit.
      const rename = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engId}`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Engineering-2" }),
      });
      assert.strictEqual(rename.statusCode, 200, rename.body);
      const renameJson = JSON.parse(rename.body) as {
        name: string;
        hidden: boolean;
        hiddenAt: string | null;
      };
      assert.strictEqual(renameJson.name, "Engineering-2");
      assert.strictEqual(renameJson.hidden, false);
      assert.strictEqual(renameJson.hiddenAt, null);

      // ----- PATCH rename name_conflict.
      const clash = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engId}`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Finance" }),
      });
      assert.strictEqual(clash.statusCode, 409, clash.body);
      assert.match(clash.body, /name_conflict/);

      // ----- PATCH hide — default space is protected.
      const hideDefault = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${defaultSpaceId}`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ hidden: true }),
      });
      assert.strictEqual(hideDefault.statusCode, 400, hideDefault.body);
      assert.match(hideDefault.body, /cannot_hide_default_space/);

      // ----- PATCH hide — Engineering-2.
      const hide = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engId}`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ hidden: true }),
      });
      assert.strictEqual(hide.statusCode, 200, hide.body);
      const hideJson = JSON.parse(hide.body) as {
        hidden: boolean;
        hiddenAt: string | null;
        hiddenByUserId: string | null;
      };
      assert.strictEqual(hideJson.hidden, true);
      assert.ok(hideJson.hiddenAt, "hiddenAt should be set after hide");
      assert.strictEqual(hideJson.hiddenByUserId, admin.userId);

      // ----- Default list excludes hidden for admin too (safe default).
      const adminListDefault = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/spaces`,
        headers: adminAuth,
      });
      const adminListDefaultJson = JSON.parse(adminListDefault.body) as {
        spaces: Array<{ spaceId: string }>;
      };
      assert.ok(
        !adminListDefaultJson.spaces.some((s) => s.spaceId === engId),
        "hidden space should be absent from default list",
      );

      // ----- includeHidden=true as admin returns the hidden space.
      const adminListAll = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/spaces?includeHidden=true`,
        headers: adminAuth,
      });
      assert.strictEqual(adminListAll.statusCode, 200, adminListAll.body);
      const adminListAllJson = JSON.parse(adminListAll.body) as {
        spaces: Array<{ spaceId: string; hidden: boolean }>;
      };
      const engInAdminList = adminListAllJson.spaces.find(
        (s) => s.spaceId === engId,
      );
      assert.ok(engInAdminList, "admin should see hidden space with ?includeHidden=true");
      assert.strictEqual(engInAdminList.hidden, true);

      // ----- includeHidden=true as non-admin is 403.
      const memberListAll = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/spaces?includeHidden=true`,
        headers: memberAuth,
      });
      assert.strictEqual(memberListAll.statusCode, 403, memberListAll.body);

      // ----- PATCH unhide — success, fields cleared.
      const unhide = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engId}`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ hidden: false }),
      });
      assert.strictEqual(unhide.statusCode, 200, unhide.body);
      const unhideJson = JSON.parse(unhide.body) as {
        hidden: boolean;
        hiddenAt: string | null;
        hiddenByUserId: string | null;
      };
      assert.strictEqual(unhideJson.hidden, false);
      assert.strictEqual(unhideJson.hiddenAt, null);
      assert.strictEqual(unhideJson.hiddenByUserId, null);

      // ----- PATCH with empty body is 400 nothing_to_update.
      const empty = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engId}`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({}),
      });
      assert.strictEqual(empty.statusCode, 400, empty.body);
      assert.match(empty.body, /nothing_to_update/);

      // ----- DELETE empty non-default space — success + audit.
      const del = await app.inject({
        method: "DELETE",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engId}`,
        headers: adminAuth,
      });
      assert.strictEqual(del.statusCode, 204, del.body);

      // ----- Audit rows — verify every expected action landed.
      const auditRows = await getAuditEventsCollection()
        .find({ orgId: admin.defaultOrgId, targetId: engId })
        .sort({ ts: 1 })
        .toArray();
      const actions = auditRows.map((r) => r.action);
      assert.ok(
        actions.includes("space.create"),
        `space.create expected in ${actions.join(",")}`,
      );
      assert.ok(
        actions.includes("space.rename"),
        `space.rename expected in ${actions.join(",")}`,
      );
      assert.ok(
        actions.includes("space.hide"),
        `space.hide expected in ${actions.join(",")}`,
      );
      assert.ok(
        actions.includes("space.unhide"),
        `space.unhide expected in ${actions.join(",")}`,
      );
      assert.ok(
        actions.includes("space.delete"),
        `space.delete expected in ${actions.join(",")}`,
      );

      // Rename metadata carries oldName/newName.
      const renameRow = auditRows.find((r) => r.action === "space.rename");
      assert.ok(renameRow);
      assert.deepStrictEqual(renameRow.metadata, {
        oldName: "Engineering",
        newName: "Engineering-2",
      });
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
