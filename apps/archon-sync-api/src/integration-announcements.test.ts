import "./load-root-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { ARCHON_SYNC_API_V1_PREFIX } from "./api-v1-prefix.js";
import { buildSyncApiApp } from "./build-app.js";
import { setupPgTestSchema, type TestPgSchemaContext } from "./test-pg-helper.js";

const jwtSecret = "dev-only-archon-sync-secret-min-32-chars!!";

test(
  "Phase 5: announcements (owner-only post; member read; non-member 404)",
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
        payload: { email: `admin-${Date.now()}@p5.test`, password: "password12345" },
      });
      const admin = JSON.parse(adminReg.body) as {
        token: string;
        userId: string;
        defaultOrgId: string;
      };
      const adminAuth = { authorization: `Bearer ${admin.token}` };

      // Invite a non-owner member.
      const inv = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${admin.defaultOrgId}/invites`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ email: `mem-${Date.now()}@p5.test`, role: "member" }),
      });
      const invJson = JSON.parse(inv.body) as { token: string };
      const accept = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/accept-invite`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ token: invJson.token, password: "newuserpw1234" }),
      });
      const member = JSON.parse(accept.body) as { token: string; userId: string };
      const memberAuth = { authorization: `Bearer ${member.token}` };

      // Admin creates Engineering and adds member.
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

      // Admin (Space Owner) posts an announcement.
      const post = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engJson.spaceId}/announcements`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({
          title: "Q2 freeze Friday",
          contentMarkdown: "**Heads up** — merge freeze starts Friday at 5pm.",
          pinned: true,
        }),
      });
      assert.strictEqual(post.statusCode, 200, post.body);
      const postJson = JSON.parse(post.body) as { announcementId: string };

      // Member can read.
      const memberRead = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engJson.spaceId}/announcements`,
        headers: memberAuth,
      });
      assert.strictEqual(memberRead.statusCode, 200);
      const memberReadJson = JSON.parse(memberRead.body) as {
        announcements: Array<{ announcementId: string; title: string; pinned: boolean }>;
      };
      assert.strictEqual(memberReadJson.announcements.length, 1);
      assert.strictEqual(memberReadJson.announcements[0]!.pinned, true);

      // Member cannot post.
      const memberPost = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engJson.spaceId}/announcements`,
        headers: { ...memberAuth, "content-type": "application/json" },
        payload: JSON.stringify({ title: "x", contentMarkdown: "y" }),
      });
      assert.strictEqual(memberPost.statusCode, 403);

      // Member cannot edit.
      const memberPatch = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engJson.spaceId}/announcements/${postJson.announcementId}`,
        headers: { ...memberAuth, "content-type": "application/json" },
        payload: JSON.stringify({ title: "Hijack" }),
      });
      assert.strictEqual(memberPatch.statusCode, 403);

      // Owner edits — title updates.
      const ownerPatch = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engJson.spaceId}/announcements/${postJson.announcementId}`,
        headers: { ...adminAuth, "content-type": "application/json" },
        payload: JSON.stringify({ title: "Q2 freeze Friday (updated)" }),
      });
      assert.strictEqual(ownerPatch.statusCode, 204);

      // Outsider gets 404 on the listing endpoint.
      const outsiderReg = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/register`,
        payload: { email: `out-${Date.now()}@p5.test`, password: "password12345" },
      });
      const outsiderToken = (JSON.parse(outsiderReg.body) as { token: string }).token;
      const outsiderRead = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engJson.spaceId}/announcements`,
        headers: { authorization: `Bearer ${outsiderToken}` },
      });
      assert.strictEqual(outsiderRead.statusCode, 404);

      // Owner deletes.
      const del = await app.inject({
        method: "DELETE",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engJson.spaceId}/announcements/${postJson.announcementId}`,
        headers: adminAuth,
      });
      assert.strictEqual(del.statusCode, 204);
      const afterDelete = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/${engJson.spaceId}/announcements`,
        headers: memberAuth,
      });
      const afterJson = JSON.parse(afterDelete.body) as { announcements: unknown[] };
      assert.strictEqual(afterJson.announcements.length, 0);
    } finally {
      if (app) await app.close();
      await ctx?.teardown();
    }
  },
);
