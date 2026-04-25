import "./load-root-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { ARCHON_SYNC_API_V1_PREFIX } from "./api-v1-prefix.js";
import { buildSyncApiApp } from "./build-app.js";
import { setupPgTestSchema, type TestPgSchemaContext } from "./test-pg-helper.js";

const jwtSecret = "dev-only-archon-sync-secret-min-32-chars!!";

test(
  "MCP device login: start → authorize → token",
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

      const start = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/mcp/device/start`,
        payload: {},
      });
      assert.strictEqual(start.statusCode, 200, start.body);
      const s = JSON.parse(start.body) as {
        device_code: string;
        user_code: string;
        verification_uri: string;
      };
      assert.ok(s.device_code?.length > 8);
      assert.ok(s.user_code?.length > 4);

      const badAuthz = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/mcp/device/authorize`,
        payload: { user_code: s.user_code },
      });
      assert.strictEqual(badAuthz.statusCode, 401);

      const email = `mcp-dev-${Date.now()}@archon.test`;
      const password = "password12345";
      const reg = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/register`,
        payload: { email, password },
      });
      assert.strictEqual(reg.statusCode, 200, reg.body);
      const { token } = JSON.parse(reg.body) as { token: string };

      const authz = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/mcp/device/authorize`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ user_code: s.user_code }),
      });
      assert.strictEqual(authz.statusCode, 200, authz.body);

      const tok = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/mcp/device/token`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ device_code: s.device_code }),
      });
      assert.strictEqual(tok.statusCode, 200, tok.body);
      const tj = JSON.parse(tok.body) as {
        status: string;
        token?: string;
        refreshToken?: string;
      };
      assert.strictEqual(tj.status, "authorized");
      assert.ok(tj.token && tj.refreshToken);

      const tok2 = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/mcp/device/token`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ device_code: s.device_code }),
      });
      assert.strictEqual(tok2.statusCode, 200);
      const tj2 = JSON.parse(tok2.body) as { status: string };
      assert.strictEqual(tj2.status, "invalid");
    } finally {
      if (app) {
        await app.close();
      }
      await ctx?.teardown();
    }
  },
);

test(
  "MCP device login: max 5 awaiting_mcp per user",
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
      app = await buildSyncApiApp({
        jwtSecret,
        corsOrigin: "true",
        logger: false,
      });
      const api = app;

      const email = `mcp-cap-${Date.now()}@archon.test`;
      const password = "password12345";
      const reg = await api.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/register`,
        payload: { email, password },
      });
      assert.strictEqual(reg.statusCode, 200, reg.body);
      const { token } = JSON.parse(reg.body) as { token: string };
      const authH = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };

      for (let i = 0; i < 5; i++) {
        const start = await api.inject({
          method: "POST",
          url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/mcp/device/start`,
          payload: {},
        });
        assert.strictEqual(start.statusCode, 200);
        const { user_code } = JSON.parse(start.body) as { user_code: string };
        const authz = await api.inject({
          method: "POST",
          url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/mcp/device/authorize`,
          headers: authH,
          payload: JSON.stringify({ user_code }),
        });
        assert.strictEqual(authz.statusCode, 200, `authorize ${i}: ${authz.body}`);
      }

      const start6 = await api.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/mcp/device/start`,
        payload: {},
      });
      assert.strictEqual(start6.statusCode, 200);
      const { user_code: uc6 } = JSON.parse(start6.body) as { user_code: string };
      const authz6 = await api.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/mcp/device/authorize`,
        headers: authH,
        payload: JSON.stringify({ user_code: uc6 }),
      });
      assert.strictEqual(authz6.statusCode, 409, authz6.body);
    } finally {
      if (app) {
        await app.close();
      }
      await ctx?.teardown();
    }
  },
);
