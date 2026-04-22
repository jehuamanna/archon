import "./load-root-env.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { ARCHON_SYNC_API_V1_PREFIX } from "./api-v1-prefix.js";
import { buildSyncApiApp } from "./build-app.js";
import { closeMongo, connectMongo } from "./db.js";
import { dropActiveMongoDb, resolveTestMongoUri } from "./test-mongo-helper.js";

const jwtSecret = "dev-only-archon-sync-secret-min-32-chars!!";

/**
 * End-to-end HTTP flow against a disposable DB: register → JWT → shell layout,
 * WPN workspace/project/note CRUD surface, built-in plugin render.
 * Skips when Mongo is not running (local dev without docker).
 */
test(
  "sign-in, shell layout persist, WPN note create, builtin markdown render",
  { timeout: 20_000 },
  async (t) => {
    const dbName = `archon_sync_it_${randomBytes(8).toString("hex")}`;
    let app: FastifyInstance | undefined;

    const uri = resolveTestMongoUri();
    try {
      await connectMongo(uri, dbName);
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

      const email = `it-${Date.now()}@archon-integration.test`;
      const password = "password12345";

      const reg = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/auth/register`,
        payload: { email, password },
      });
      assert.strictEqual(reg.statusCode, 200, reg.body);
      const regJson = JSON.parse(reg.body) as { token: string; userId: string };
      assert.ok(regJson.token?.length > 10);
      const authHeader = { authorization: `Bearer ${regJson.token}` };

      const layout0 = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/me/shell-layout`,
        headers: authHeader,
      });
      assert.strictEqual(layout0.statusCode, 200);
      const layout0Json = JSON.parse(layout0.body) as { layout: unknown };
      assert.strictEqual(layout0Json.layout, null);

      const putLayout = await app.inject({
        method: "PUT",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/me/shell-layout`,
        headers: { ...authHeader, "content-type": "application/json" },
        payload: JSON.stringify({ layout: { panels: ["a"], v: 1 } }),
      });
      assert.strictEqual(putLayout.statusCode, 204, putLayout.body);

      const layout1 = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/me/shell-layout`,
        headers: authHeader,
      });
      assert.strictEqual(layout1.statusCode, 200);
      const layout1Json = JSON.parse(layout1.body) as {
        layout: { panels: string[]; v: number };
      };
      assert.deepStrictEqual(layout1Json.layout, { panels: ["a"], v: 1 });

      const ws = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces`,
        headers: { ...authHeader, "content-type": "application/json" },
        payload: JSON.stringify({ name: "IT Workspace" }),
      });
      assert.strictEqual(ws.statusCode, 201, ws.body);
      const wsId = (JSON.parse(ws.body) as { workspace: { id: string } }).workspace.id;

      const proj = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/workspaces/${wsId}/projects`,
        headers: { ...authHeader, "content-type": "application/json" },
        payload: JSON.stringify({ name: "IT Project" }),
      });
      assert.strictEqual(proj.statusCode, 201, proj.body);
      const projectId = (JSON.parse(proj.body) as { project: { id: string } }).project.id;

      const note = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/projects/${projectId}/notes`,
        headers: { ...authHeader, "content-type": "application/json" },
        payload: JSON.stringify({
          type: "markdown",
          relation: "root",
          title: "Hello",
          content: "# Integration",
        }),
      });
      assert.strictEqual(note.statusCode, 201, note.body);
      const noteRow = JSON.parse(note.body) as { id: string };
      assert.ok(noteRow.id);

      const meta = await app.inject({
        method: "GET",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/plugins/builtin-renderer-meta?type=markdown`,
        headers: authHeader,
      });
      assert.strictEqual(meta.statusCode, 200, meta.body);

      const render = await app.inject({
        method: "POST",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/plugins/builtin-render`,
        headers: { ...authHeader, "content-type": "application/json" },
        payload: JSON.stringify({
          type: "markdown",
          note: {
            id: noteRow.id,
            type: "markdown",
            title: "Hello",
            content: "# Rendered",
          },
        }),
      });
      assert.strictEqual(render.statusCode, 200, render.body);
      const renderJson = JSON.parse(render.body) as { html: string };
      assert.match(renderJson.html, /Rendered/);
    } finally {
      if (app) {
        await app.close();
      }
      await dropActiveMongoDb();
      await closeMongo();
    }
  },
);
