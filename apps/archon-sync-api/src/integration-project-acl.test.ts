import "./load-root-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { ARCHON_SYNC_API_V1_PREFIX } from "./api-v1-prefix.js";
import { buildSyncApiApp } from "./build-app.js";
import { setupPgTestSchema, type TestPgSchemaContext } from "./test-pg-helper.js";

const jwtSecret = "dev-only-archon-sync-secret-min-32-chars!!";

type RegisterResult = { token: string; userId: string; defaultOrgId: string };

async function registerUser(app: FastifyInstance, email: string): Promise<RegisterResult> {
  const r = await app.inject({
    method: "POST",
    url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/register`,
    payload: { email, password: "password12345" },
  });
  return JSON.parse(r.body) as RegisterResult;
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
  "Phase 8: project visibility + share roles gate access correctly",
  { timeout: 30_000 },
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

      const admin = await registerUser(app, `admin-${Date.now()}@p8.test`);
      const adminAuth = { authorization: `Bearer ${admin.token}` };
      const bob = await inviteAndAccept(
        app, adminAuth, admin.defaultOrgId, `bob-${Date.now()}@p8.test`,
      );
      const carol = await inviteAndAccept(
        app, adminAuth, admin.defaultOrgId, `carol-${Date.now()}@p8.test`,
      );
      const bobAuth = { authorization: `Bearer ${bob.token}` };
      const carolAuth = { authorization: `Bearer ${carol.token}` };

      // Create a space and add bob (member) + carol (viewer).
      const space = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/spaces`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "P8 Space" }),
      });
      const spaceId = (JSON.parse(space.body) as { spaceId: string }).spaceId;
      await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${spaceId}/members`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ userId: bob.userId, role: "member" }),
      });
      await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${spaceId}/members`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ userId: carol.userId, role: "viewer" }),
      });

      // Admin creates workspace W (public) with project P1 in it.
      const scopeHeaders = {
        "x-archon-org": admin.defaultOrgId,
        "x-archon-space": spaceId,
      };
      const wsCreate = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces`,
        headers: { ...adminAuth, "content-type": "application/json", ...scopeHeaders },
        payload: JSON.stringify({ name: "Workspace-W" }),
      });
      const wsId = (JSON.parse(wsCreate.body) as { workspace: { id: string } }).workspace.id;
      const p1Create = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/projects`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "P1" }),
      });
      assert.strictEqual(p1Create.statusCode, 201);
      const p1Id = (JSON.parse(p1Create.body) as { project: { id: string; visibility: string } }).project.id;

      // 1. Default visibility public: bob sees P1 in list.
      const bobSees = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/projects`,
        headers: bobAuth,
      });
      assert.strictEqual(bobSees.statusCode, 200);
      const bobProjects = (JSON.parse(bobSees.body) as { projects: Array<{ id: string }> }).projects;
      assert.ok(bobProjects.find((p) => p.id === p1Id), "bob sees public project");

      // 2. Admin flips P1 to private → bob no longer sees it; admin still does.
      const setPriv = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${p1Id}/visibility`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ visibility: "private" }),
      });
      assert.strictEqual(setPriv.statusCode, 200, setPriv.body);
      const bobAfterPriv = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/projects`,
        headers: bobAuth,
      });
      const bobAfterPrivList = (JSON.parse(bobAfterPriv.body) as { projects: Array<{ id: string }> }).projects;
      assert.ok(!bobAfterPrivList.find((p) => p.id === p1Id), "bob no longer sees private project");
      // Admin (org admin) still sees it via the override set.
      const adminAfterPriv = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/projects`,
        headers: adminAuth,
      });
      const adminList = (JSON.parse(adminAfterPriv.body) as { projects: Array<{ id: string }> }).projects;
      assert.ok(adminList.find((p) => p.id === p1Id), "admin still sees private project (org-admin override)");

      // 3. Switch to shared + add carol as writer + bob as reader.
      const setShared = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${p1Id}/visibility`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ visibility: "shared" }),
      });
      assert.strictEqual(setShared.statusCode, 200);
      const shareBob = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${p1Id}/shares`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ userId: bob.userId, role: "reader" }),
      });
      assert.strictEqual(shareBob.statusCode, 204, shareBob.body);
      const shareCarol = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${p1Id}/shares`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ userId: carol.userId, role: "writer" }),
      });
      assert.strictEqual(shareCarol.statusCode, 204);

      // Bob (reader-share) can see but cannot write.
      const bobReadNotes = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${p1Id}/notes`,
        headers: bobAuth,
      });
      assert.strictEqual(bobReadNotes.statusCode, 200);
      const bobWriteNote = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${p1Id}/notes`,
        headers: { ...bobAuth, "content-type": "application/json" },
        payload: JSON.stringify({ type: "markdown", relation: "root", title: "Bob note" }),
      });
      assert.strictEqual(bobWriteNote.statusCode, 403, "reader-share should 403 on write");

      // Carol is a space-viewer but has a project writer-share → she can write.
      const carolWriteNote = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${p1Id}/notes`,
        headers: { ...carolAuth, "content-type": "application/json" },
        payload: JSON.stringify({ type: "markdown", relation: "root", title: "Carol note" }),
      });
      assert.strictEqual(
        carolWriteNote.statusCode,
        201,
        `viewer + writer-share should write: ${carolWriteNote.body}`,
      );

      // 4. Writer (Bob via workspace) cannot mutate project visibility — manage required.
      // Bob doesn't have a writer-share right now; give him one to prove the distinction.
      await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${p1Id}/shares/${bob.userId}`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ role: "writer" }),
      });
      const bobTriesVis = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${p1Id}/visibility`,
        headers: { ...bobAuth, "content-type": "application/json" },
        payload: JSON.stringify({ visibility: "public" }),
      });
      assert.strictEqual(bobTriesVis.statusCode, 403, "writer cannot change visibility");

      // 5. Flip away from shared sweeps project_shares.
      const flipPub = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${p1Id}/visibility`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ visibility: "public" }),
      });
      assert.strictEqual(flipPub.statusCode, 200);
      const listAfterFlip = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${p1Id}/shares`,
        headers: adminAuth,
      });
      const sharesAfter = (JSON.parse(listAfterFlip.body) as { shares: unknown[] }).shares;
      assert.strictEqual(sharesAfter.length, 0, "shares wiped on flip away from shared");

      // 6. Workspace-denial is a hard stop: flip workspace to private (so bob loses workspace access),
      // then grant bob a shared project share on P1 — he should still 404 at project level.
      await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/visibility`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ visibility: "private" }),
      });
      await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${p1Id}/visibility`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ visibility: "shared" }),
      });
      // Attempt to grant bob on the project — server must reject (bob can't read workspace).
      const grantAttempt = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${p1Id}/shares`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ userId: bob.userId, role: "writer" }),
      });
      assert.strictEqual(
        grantAttempt.statusCode,
        400,
        "share grant rejected when target can't read workspace",
      );

      // 7. Cascade: delete the project → its shares are gone. Re-open workspace first.
      await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/visibility`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ visibility: "public" }),
      });
      // Grant carol again first so we have something to verify gets swept.
      await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${p1Id}/shares`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ userId: carol.userId, role: "reader" }),
      });
      const delProj = await app.inject({
        method: "DELETE",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${p1Id}`,
        headers: adminAuth,
      });
      assert.strictEqual(delProj.statusCode, 200);
      // A fresh listing of the now-deleted project's shares should 404 (project gone).
      const staleShares = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${p1Id}/shares`,
        headers: adminAuth,
      });
      assert.strictEqual(staleShares.statusCode, 404);

      // 8. Audit entries for the new project events exist.
      const audit = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/audit`,
        headers: adminAuth,
      });
      assert.strictEqual(audit.statusCode, 200);
      const auditActions = (
        JSON.parse(audit.body) as { events: Array<{ action: string }> }
      ).events.map((e) => e.action);
      assert.ok(
        auditActions.includes("project.visibility.set"),
        "project.visibility.set recorded",
      );
      assert.ok(
        auditActions.includes("project.share.add"),
        "project.share.add recorded",
      );
    } finally {
      if (app) await app.close();
      await ctx?.teardown();
    }
  },
);

test(
  "Phase 8: workspace share role (reader vs writer) gates writes correctly",
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
      const admin = await registerUser(app, `admin-${Date.now()}@wsrole.test`);
      const adminAuth = { authorization: `Bearer ${admin.token}` };
      const writer = await inviteAndAccept(
        app, adminAuth, admin.defaultOrgId, `wr-${Date.now()}@wsrole.test`,
      );
      const reader = await inviteAndAccept(
        app, adminAuth, admin.defaultOrgId, `rd-${Date.now()}@wsrole.test`,
      );

      const space = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/spaces`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "WSRole space" }),
      });
      const spaceId = (JSON.parse(space.body) as { spaceId: string }).spaceId;
      for (const u of [writer, reader]) {
        await app.inject({
          method: "POST",
          url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${spaceId}/members`,
          headers: { ...adminAuth, "content-type": "application/json" },
          payload: JSON.stringify({ userId: u.userId, role: "viewer" }),
        });
      }

      const scopeHeaders = {
        "x-archon-org": admin.defaultOrgId,
        "x-archon-space": spaceId,
      };
      const wsCreate = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces`,
        headers: { ...adminAuth, "content-type": "application/json", ...scopeHeaders },
        payload: JSON.stringify({ name: "Shared-W" }),
      });
      const wsId = (JSON.parse(wsCreate.body) as { workspace: { id: string } }).workspace.id;
      await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/visibility`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ visibility: "shared" }),
      });
      // Reader: default role = reader.
      await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/shares`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ userId: reader.userId }),
      });
      // Writer: explicit writer role.
      await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/shares`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ userId: writer.userId, role: "writer" }),
      });

      // Create a project for them to write into.
      const pRes = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/projects`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Shared-P" }),
      });
      const pId = (JSON.parse(pRes.body) as { project: { id: string } }).project.id;

      // Reader can GET notes but not write.
      const readerRead = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${pId}/notes`,
        headers: { authorization: `Bearer ${reader.token}` },
      });
      assert.strictEqual(readerRead.statusCode, 200);
      const readerWrite = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${pId}/notes`,
        headers: {
          authorization: `Bearer ${reader.token}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ type: "markdown", relation: "root", title: "nope" }),
      });
      assert.strictEqual(readerWrite.statusCode, 403);

      // Writer (viewer + writer-share) can write.
      const writerWrite = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${pId}/notes`,
        headers: {
          authorization: `Bearer ${writer.token}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ type: "markdown", relation: "root", title: "yep" }),
      });
      assert.strictEqual(
        writerWrite.statusCode,
        201,
        `writer-share should allow write: ${writerWrite.body}`,
      );

      // Promote reader to writer via PATCH.
      const promote = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/shares/${reader.userId}`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ role: "writer" }),
      });
      assert.strictEqual(promote.statusCode, 204);
      const readerNowWrites = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${pId}/notes`,
        headers: {
          authorization: `Bearer ${reader.token}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ type: "markdown", relation: "root", title: "now yes" }),
      });
      assert.strictEqual(
        readerNowWrites.statusCode,
        201,
        `promoted reader should now write: ${readerNowWrites.body}`,
      );
    } finally {
      if (app) await app.close();
      await ctx?.teardown();
    }
  },
);
