/**
 * Regression test for Bug-0ae7ee (active-space-reset): after a user picks a
 * non-default space via `POST /spaces/active`, the choice must survive a
 * subsequent `/auth/refresh` so the new access token still carries the same
 * `activeSpaceId` claim. Without this, the refresh path consults
 * `lastActiveSpaceByOrg[orgId]` first (preferred over `lastActiveSpaceId`)
 * and silently reverts to the default space, causing the renderer's tree
 * explorer to "jump" back to the default scope.
 */
import "./load-root-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ARCHON_SYNC_API_V1_PREFIX } from "./api-v1-prefix.js";
import { buildSyncApiApp } from "./build-app.js";
import { getDb } from "./pg.js";
import { users } from "./db/schema.js";
import { setupPgTestSchema, type TestPgSchemaContext } from "./test-pg-helper.js";

const jwtSecret = "dev-only-archon-sync-secret-min-32-chars!!";

test(
  "Bug-0ae7ee — /spaces/active pin survives /auth/refresh (no drift back to default)",
  { timeout: 20_000 },
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
      app = await buildSyncApiApp({
        jwtSecret,
        corsOrigin: "true",
        logger: false,
      });

      const email = `space-pin-${Date.now()}@p2.test`;
      const reg = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/register`,
        payload: { email, password: "password12345" },
      });
      assert.strictEqual(reg.statusCode, 200, reg.body);
      const regJson = JSON.parse(reg.body) as {
        token: string;
        refreshToken: string;
        userId: string;
        defaultOrgId: string;
        defaultSpaceId: string;
      };
      const auth = { authorization: `Bearer ${regJson.token}` };

      // Create a second space ("jehu") in the same org and switch to it.
      const newSpaceRes = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/orgs/${regJson.defaultOrgId}/spaces`,
        headers: { ...auth, "content-type": "application/json" },
        payload: JSON.stringify({ name: "jehu" }),
      });
      assert.strictEqual(newSpaceRes.statusCode, 200, newSpaceRes.body);
      const jehuSpaceId = (
        JSON.parse(newSpaceRes.body) as { spaceId: string }
      ).spaceId;
      assert.notStrictEqual(jehuSpaceId, regJson.defaultSpaceId);

      const setActive = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/spaces/active`,
        headers: { ...auth, "content-type": "application/json" },
        payload: JSON.stringify({ spaceId: jehuSpaceId }),
      });
      assert.strictEqual(setActive.statusCode, 200, setActive.body);
      const setActiveJson = JSON.parse(setActive.body) as {
        token: string;
        activeSpaceId: string;
        activeOrgId: string;
      };
      assert.strictEqual(setActiveJson.activeSpaceId, jehuSpaceId);

      // Direct DB check: the per-org pin was persisted, not just the global
      // last-active fields. This is the bit the bug was missing.
      const userRowAfterPin = (
        await getDb()
          .select({
            lastActiveOrgId: users.lastActiveOrgId,
            lastActiveSpaceId: users.lastActiveSpaceId,
            lastActiveSpaceByOrg: users.lastActiveSpaceByOrg,
          })
          .from(users)
          .where(eq(users.id, regJson.userId))
          .limit(1)
      )[0];
      assert.ok(userRowAfterPin, "user row after pin");
      assert.strictEqual(
        userRowAfterPin.lastActiveSpaceId,
        jehuSpaceId,
        "global lastActiveSpaceId was not updated",
      );
      const pinMap =
        (userRowAfterPin.lastActiveSpaceByOrg as Record<string, string> | null) ??
        {};
      assert.strictEqual(
        pinMap[regJson.defaultOrgId],
        jehuSpaceId,
        "lastActiveSpaceByOrg per-org pin was not updated",
      );

      // Now exercise /auth/refresh and verify the new access token still
      // carries `activeSpaceId = jehuSpaceId`. Pre-fix, the per-org map held
      // a stale entry (or nothing) for this org and `resolveSessionSpaceId`
      // returned the default space, flipping the claim under the renderer.
      const refresh = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/refresh`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ refreshToken: regJson.refreshToken }),
      });
      assert.strictEqual(refresh.statusCode, 200, refresh.body);
      const refreshJson = JSON.parse(refresh.body) as {
        token: string;
        refreshToken: string;
      };
      const decoded = jwt.verify(refreshJson.token, jwtSecret) as {
        activeSpaceId?: string;
        activeOrgId?: string;
      };
      assert.strictEqual(
        decoded.activeOrgId,
        regJson.defaultOrgId,
        "refresh dropped activeOrgId",
      );
      assert.strictEqual(
        decoded.activeSpaceId,
        jehuSpaceId,
        "refresh reverted activeSpaceId — Bug-0ae7ee regressed",
      );
    } finally {
      await app?.close();
      await ctx.teardown();
    }
  },
);
