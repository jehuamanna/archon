/**
 * Regression test for Bug-8fa027 (mcp-yjs-race): a `PATCH /wpn/notes/:id`
 * issued while a Hocuspocus editor session is open used to be silently
 * overwritten by the next debounced autosave, because the editor's
 * in-memory Y.Doc was unaware of the REST write.
 *
 * The fix routes REST writes through `applyContentToYjsDoc`, which uses
 * `Server.openDirectConnection(noteId)` to replace `Y.Text("content")`
 * inside one transaction. This test asserts:
 *   1. an open Hocuspocus client receives the new content via Yjs
 *      broadcast within the configured debounce window;
 *   2. once the autosave fires, `wpn_notes.content` matches the REST-
 *      written value (i.e. the bridge no longer reverts the row).
 */
import "../load-root-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { ARCHON_SYNC_API_V1_PREFIX } from "../api-v1-prefix.js";
import { buildSyncApiApp } from "../build-app.js";
import { getDb } from "../pg.js";
import { wpnNotes } from "../db/schema.js";
import {
  setupPgTestSchema,
  type TestPgSchemaContext,
  factoryUser,
  factoryOrg,
  factorySpace,
  factoryWorkspace,
  factoryProject,
} from "../test-pg-helper.js";
import { signToken } from "../auth.js";
import { _shutdownYjsServerForTests } from "./yjs-ws.js";

const jwtSecret = "dev-only-archon-sync-secret-min-32-chars!!";

async function waitFor<T>(
  predicate: () => T | Promise<T>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

test(
  "Bug-8fa027 — REST PATCH content is reflected in the live Yjs doc and not reverted by autosave",
  { timeout: 25_000 },
  async (t) => {
    let ctx: TestPgSchemaContext | undefined;
    try {
      ctx = await setupPgTestSchema();
    } catch (err) {
      t.skip(`Postgres not reachable: ${String(err)}`);
      return;
    }

    const prevDebounce = process.env.ARCHON_YJS_AUTOSAVE_DEBOUNCE_MS;
    const prevMaxDebounce = process.env.ARCHON_YJS_AUTOSAVE_MAX_DEBOUNCE_MS;
    process.env.ARCHON_YJS_AUTOSAVE_DEBOUNCE_MS = "100";
    process.env.ARCHON_YJS_AUTOSAVE_MAX_DEBOUNCE_MS = "300";

    const userEmail = `mcp-race-${Date.now()}@p4.test`;
    const userId = await factoryUser({ email: userEmail });
    const orgId = await factoryOrg({ ownerUserId: userId });
    const spaceId = await factorySpace({ orgId, ownerUserId: userId });
    const workspaceId = await factoryWorkspace({ userId, orgId, spaceId });
    const projectId = await factoryProject({
      userId,
      workspaceId,
      orgId,
      spaceId,
    });
    const noteId = randomUUID();
    const t0 = Date.now();
    const seedContent = "seed body before MCP write";
    await getDb().insert(wpnNotes).values({
      id: noteId,
      userId,
      orgId,
      spaceId,
      project_id: projectId,
      parent_id: null,
      type: "markdown",
      title: "Race test note",
      content: seedContent,
      sibling_index: 0,
      created_at_ms: t0,
      updated_at_ms: t0,
      deleted: false,
    });

    const app = await buildSyncApiApp({
      jwtSecret,
      corsOrigin: "true",
      logger: false,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address() as AddressInfo;
    const wsBase = `ws://127.0.0.1:${addr.port}/api/v1/ws/yjs`;

    const wsToken = signToken(
      jwtSecret,
      {
        sub: userId,
        email: userEmail,
        typ: "spaceWs",
        principal: { type: "user" },
        activeOrgId: orgId,
        activeSpaceId: spaceId,
      },
      "5m",
    );
    const accessToken = signToken(
      jwtSecret,
      {
        sub: userId,
        email: userEmail,
        typ: "access",
        principal: { type: "user" },
        activeOrgId: orgId,
        activeSpaceId: spaceId,
      },
      "5m",
    );

    const docClient = new Y.Doc();
    const provClient = new HocuspocusProvider({
      url: wsBase,
      name: noteId,
      document: docClient,
      token: wsToken,
      onAuthenticationFailed: ({ reason }) => {
        // eslint-disable-next-line no-console
        console.error("[mcp-race] auth failed:", reason);
      },
    });

    try {
      await waitFor(() => provClient.synced && provClient.isConnected, 8000);
      // After sync, the server's onLoadDocument seeded Y.Text("content")
      // from `wpn_notes.content`, so the client sees the seed body.
      assert.strictEqual(
        docClient.getText("content").toString(),
        seedContent,
      );

      // Issue the REST PATCH (this is the path archon_write_note hits).
      const newContent = "MCP-written body — this must survive autosave";
      const patchRes = await app.inject({
        method: "PATCH",
        url: `${ARCHON_SYNC_API_V1_PREFIX}/wpn/notes/${noteId}`,
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ content: newContent }),
      });
      assert.strictEqual(patchRes.statusCode, 200, patchRes.body);

      // Assertion 1: open Hocuspocus client receives the new content via
      // the Yjs broadcast that `applyContentToYjsDoc` triggers.
      await waitFor(
        () => docClient.getText("content").toString() === newContent,
        4000,
      );

      // Assertion 2: after the autosave debounce fires, the bridge keeps
      // wpn_notes.content in sync with the (REST-written) Yjs state — the
      // pre-fix bug was that this would revert to the editor's stale
      // in-memory copy of seedContent.
      await waitFor(
        async () => {
          const rows = await getDb()
            .select({ content: wpnNotes.content })
            .from(wpnNotes)
            .where(eq(wpnNotes.id, noteId))
            .limit(1);
          return rows[0]?.content === newContent;
        },
        4000,
      );

      // Hold the connection open a bit longer so any further autosave
      // tick that might (incorrectly) overwrite the row would surface.
      await new Promise((r) => setTimeout(r, 600));
      const finalRow = (
        await getDb()
          .select({ content: wpnNotes.content })
          .from(wpnNotes)
          .where(eq(wpnNotes.id, noteId))
          .limit(1)
      )[0];
      assert.strictEqual(
        finalRow?.content,
        newContent,
        "wpn_notes.content reverted after autosave — Bug-8fa027 regressed",
      );
    } finally {
      provClient.disconnect();
      provClient.destroy();
      await _shutdownYjsServerForTests();
      await app.close();
      if (prevDebounce === undefined) {
        delete process.env.ARCHON_YJS_AUTOSAVE_DEBOUNCE_MS;
      } else {
        process.env.ARCHON_YJS_AUTOSAVE_DEBOUNCE_MS = prevDebounce;
      }
      if (prevMaxDebounce === undefined) {
        delete process.env.ARCHON_YJS_AUTOSAVE_MAX_DEBOUNCE_MS;
      } else {
        process.env.ARCHON_YJS_AUTOSAVE_MAX_DEBOUNCE_MS = prevMaxDebounce;
      }
      await ctx.teardown();
    }
  },
);
