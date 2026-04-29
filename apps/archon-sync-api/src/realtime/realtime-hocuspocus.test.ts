import "../load-root-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import type { AddressInfo } from "node:net";
import { buildSyncApiApp } from "../build-app.js";
import { getDb } from "../pg.js";
import { notes } from "../db/schema.js";
import {
  setupPgTestSchema,
  type TestPgSchemaContext,
  factoryUser,
  factoryOrg,
  factoryDepartment,
  factoryTeam,
  factoryTeamMembership,
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

async function setupOrgProject(): Promise<{
  userId: string;
  orgId: string;
  teamId: string;
  projectId: string;
  noteId: string;
  emailPrefix: string;
}> {
  const emailPrefix = `hp-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const userId = await factoryUser({ email: `${emailPrefix}@p4.test` });
  const orgId = await factoryOrg({ ownerUserId: userId });
  const departmentId = await factoryDepartment({
    orgId,
    createdByUserId: userId,
  });
  const teamId = await factoryTeam({
    orgId,
    departmentId,
    createdByUserId: userId,
  });
  await factoryTeamMembership({
    teamId,
    userId,
    addedByUserId: userId,
    role: "admin",
  });
  const projectId = await factoryProject({
    orgId,
    creatorUserId: userId,
    teamId,
    teamRole: "owner",
  });
  const noteId = randomUUID();
  const t0 = Date.now();
  await getDb().insert(notes).values({
    id: noteId,
    orgId,
    projectId,
    parentId: null,
    createdByUserId: userId,
    updatedByUserId: userId,
    type: "page",
    title: "Body collab test",
    content: "",
    metadata: null,
    siblingIndex: 0,
    createdAtMs: t0,
    updatedAtMs: t0,
  });
  return { userId, orgId, teamId, projectId, noteId, emailPrefix };
}

test(
  "AC4.1 — two-tab body collab converges via Hocuspocus",
  { timeout: 20_000 },
  async (t) => {
    let ctx: TestPgSchemaContext | undefined;
    try {
      ctx = await setupPgTestSchema();
    } catch (err) {
      t.skip(`Postgres not reachable: ${String(err)}`);
      return;
    }

    const prevDebounce = process.env.ARCHON_YJS_AUTOSAVE_DEBOUNCE_MS;
    process.env.ARCHON_YJS_AUTOSAVE_DEBOUNCE_MS = "100";

    const { userId, orgId, noteId, emailPrefix } = await setupOrgProject();

    const app = await buildSyncApiApp({
      jwtSecret,
      corsOrigin: "true",
      logger: false,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address() as AddressInfo;
    // HocuspocusProvider uses this URL verbatim; documentName goes in the
    // protocol auth message (not the URL).
    const wsBase = `ws://127.0.0.1:${addr.port}/api/v1/ws/yjs`;

    // The `typ: "wsClient"` JWT name is vestigial after the spaces squash —
    // identity-only token. Per-note authorisation runs at WS open in
    // yjs-ws.ts onAuthenticate; the active org carries the membership that
    // gates project access.
    const wsToken = signToken(
      jwtSecret,
      {
        sub: userId,
        email: `${emailPrefix}@example.test`,
        typ: "wsClient",
        principal: { type: "user" },
        activeOrgId: orgId,
      },
      "5m",
    );

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const provA = new HocuspocusProvider({
      url: wsBase,
      name: noteId,
      document: docA,
      token: wsToken,
      onAuthenticationFailed: ({ reason }) => {
        // eslint-disable-next-line no-console
        console.error("[hp test] tab A auth failed:", reason);
      },
      onClose: ({ event }) => {
        // eslint-disable-next-line no-console
        console.log("[hp test] tab A closed", event.code, event.reason);
      },
    });
    const provB = new HocuspocusProvider({
      url: wsBase,
      name: noteId,
      document: docB,
      token: wsToken,
    });

    try {
      await waitFor(() => provA.synced && provB.synced, 8000);

      docA.getText("content").insert(0, "hello world");
      await waitFor(
        () => docB.getText("content").toString() === "hello world",
        4000,
      );
      assert.strictEqual(docB.getText("content").toString(), "hello world");
    } finally {
      provA.disconnect();
      provA.destroy();
      provB.disconnect();
      provB.destroy();
      await _shutdownYjsServerForTests();
      await app.close();
      if (prevDebounce === undefined) {
        delete process.env.ARCHON_YJS_AUTOSAVE_DEBOUNCE_MS;
      } else {
        process.env.ARCHON_YJS_AUTOSAVE_DEBOUNCE_MS = prevDebounce;
      }
      await ctx.teardown();
    }
  },
);

test(
  "AC4.5 — offline edits made while disconnected merge in on reconnect",
  { timeout: 30_000 },
  async (t) => {
    let ctx: TestPgSchemaContext | undefined;
    try {
      ctx = await setupPgTestSchema();
    } catch (err) {
      t.skip(`Postgres not reachable: ${String(err)}`);
      return;
    }

    const prevDebounce = process.env.ARCHON_YJS_AUTOSAVE_DEBOUNCE_MS;
    process.env.ARCHON_YJS_AUTOSAVE_DEBOUNCE_MS = "100";

    const { userId, orgId, noteId, emailPrefix } = await setupOrgProject();

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
        email: `${emailPrefix}@example.test`,
        typ: "wsClient",
        principal: { type: "user" },
        activeOrgId: orgId,
      },
      "5m",
    );

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const provA = new HocuspocusProvider({
      url: wsBase,
      name: noteId,
      document: docA,
      token: wsToken,
    });
    const provB = new HocuspocusProvider({
      url: wsBase,
      name: noteId,
      document: docB,
      token: wsToken,
    });

    try {
      await waitFor(() => provA.synced && provB.synced, 8000);

      // Initial online edit on A; B sees it.
      docA.getText("content").insert(0, "online ");
      await waitFor(
        () => docB.getText("content").toString() === "online ",
        4000,
      );

      // Tab A goes offline. While offline, the local Y.Doc still accepts
      // mutations — those updates are buffered in the provider and will be
      // flushed on reconnect.
      provA.disconnect();
      await waitFor(() => !provA.isConnected, 2000);
      docA.getText("content").insert(
        docA.getText("content").length,
        "offline-edit ",
      );

      // Tab B keeps editing while A is offline.
      docB.getText("content").insert(
        docB.getText("content").length,
        "B-edit ",
      );
      await new Promise((r) => setTimeout(r, 250));

      // Reconnect A.
      provA.connect();
      await waitFor(() => provA.synced && provA.isConnected, 8000);

      await waitFor(
        () =>
          docA.getText("content").toString() ===
          docB.getText("content").toString(),
        5000,
      );
      const merged = docA.getText("content").toString();
      assert.ok(merged.includes("online "), `merged missing online: "${merged}"`);
      assert.ok(
        merged.includes("offline-edit "),
        `merged missing offline-edit: "${merged}"`,
      );
      assert.ok(merged.includes("B-edit "), `merged missing B-edit: "${merged}"`);
    } finally {
      provA.disconnect();
      provA.destroy();
      provB.disconnect();
      provB.destroy();
      await _shutdownYjsServerForTests();
      await app.close();
      if (prevDebounce === undefined) {
        delete process.env.ARCHON_YJS_AUTOSAVE_DEBOUNCE_MS;
      } else {
        process.env.ARCHON_YJS_AUTOSAVE_DEBOUNCE_MS = prevDebounce;
      }
      await ctx.teardown();
    }
  },
);
