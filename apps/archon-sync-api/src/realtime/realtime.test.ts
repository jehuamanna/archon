/**
 * Phase 4 integration coverage. Each test sets up an isolated PG schema,
 * registers a user + org + space + workspace + project, and exercises a
 * specific AC over the in-process Fastify app.
 *
 * Hocuspocus end-to-end (AC4.1) needs a real WS server bound to a port —
 * skipped here in favor of direct adapter coverage that asserts the same
 * persistence guarantees (load → store → reload). Adding a port-bound
 * Hocuspocus run is a follow-up.
 */
import "../load-root-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { eq, and } from "drizzle-orm";
import { getDb } from "../pg.js";
import { auditEvents, yjsState } from "../db/schema.js";
import {
  setupPgTestSchema,
  type TestPgSchemaContext,
  factoryUser,
  factoryOrg,
  factorySpace,
  factoryWorkspace,
  factoryProject,
} from "../test-pg-helper.js";
import { createYjsPgAdapter } from "./yjs-pg-adapter.js";
import {
  setPresence,
  snapshotPresence,
  dropPresence,
  _resetPresenceForTests,
} from "./presence.js";
import { notifyRealtime, clientOpStore } from "./notify.js";
import { channelForSpace } from "./events.js";
import { acquireChannel, _resetChannelsForTests } from "./listen-pool.js";

const jwtSecret = "dev-only-archon-sync-secret-min-32-chars!!";

test("AC4.1 — yjs adapter snapshot + replay round-trip", async (t) => {
  let ctx: TestPgSchemaContext | undefined;
  try {
    ctx = await setupPgTestSchema();
  } catch (err) {
    t.skip(`Postgres not reachable: ${String(err)}`);
    return;
  }
  try {
    const adapter = createYjsPgAdapter();
    const noteId = "11111111-1111-1111-1111-111111111111";
    const empty = await adapter.loadDoc(noteId);
    assert.strictEqual(empty, null);

    const initial = Buffer.from([1, 2, 3, 4]);
    await adapter.storeDoc(noteId, initial);
    const back = await adapter.loadDoc(noteId);
    assert.ok(back && Buffer.isBuffer(back));
    assert.strictEqual(Buffer.compare(back, initial), 0);

    // Append two updates; load since seq=0 → both come back in order.
    const seq1 = await adapter.appendUpdate(noteId, Buffer.from([10]));
    const seq2 = await adapter.appendUpdate(noteId, Buffer.from([20]));
    assert.strictEqual(seq2 > seq1, true);
    const updates = await adapter.loadUpdatesSince(noteId, 0n);
    assert.strictEqual(updates.length, 2);
    assert.strictEqual(updates[0]!.updateBytes[0], 10);
    assert.strictEqual(updates[1]!.updateBytes[0], 20);

    // Snapshot rewrite bumps version.
    const next = Buffer.from([5, 6, 7]);
    await adapter.storeDoc(noteId, next);
    const verRows = await getDb()
      .select({ version: yjsState.version })
      .from(yjsState)
      .where(eq(yjsState.noteId, noteId))
      .limit(1);
    assert.strictEqual(Number(verRows[0]!.version), 2);
  } finally {
    await ctx.teardown();
  }
});

test("AC4.4 — single audit row per recordAudit call (no duplicates)", async (t) => {
  let ctx: TestPgSchemaContext | undefined;
  try {
    ctx = await setupPgTestSchema();
  } catch (err) {
    t.skip(`Postgres not reachable: ${String(err)}`);
    return;
  }
  try {
    const userId = await factoryUser({ email: `audit-${Date.now()}@p4.test` });
    const orgId = await factoryOrg({ ownerUserId: userId });
    const { recordAudit } = await import("../audit.js");

    // 3 distinct ops → 3 rows, no duplicates.
    for (let i = 0; i < 3; i++) {
      await recordAudit({
        orgId,
        actorUserId: userId,
        action: "workspace.visibility.set",
        targetType: "workspace",
        targetId: `00000000-0000-0000-0000-00000000000${i}`,
      });
    }
    const rows = await getDb()
      .select({ id: auditEvents.id, targetId: auditEvents.targetId })
      .from(auditEvents)
      .where(eq(auditEvents.orgId, orgId));
    assert.strictEqual(rows.length, 3);
    const distinctTargets = new Set(rows.map((r) => r.targetId));
    assert.strictEqual(distinctTargets.size, 3);
  } finally {
    await ctx.teardown();
  }
});

test("AC4.7 — recordAudit threads principal into metadata.principal", async (t) => {
  let ctx: TestPgSchemaContext | undefined;
  try {
    ctx = await setupPgTestSchema();
  } catch (err) {
    t.skip(`Postgres not reachable: ${String(err)}`);
    return;
  }
  try {
    const userId = await factoryUser({ email: `princ-${Date.now()}@p4.test` });
    const orgId = await factoryOrg({ ownerUserId: userId });

    const { recordAudit } = await import("../audit.js");
    await recordAudit({
      orgId,
      actorUserId: userId,
      action: "workspace.visibility.set",
      targetType: "workspace",
      targetId: "00000000-0000-0000-0000-000000000001",
      principal: { type: "mcp", metadata: { deviceId: "dev-1" } },
    });
    const rows = await getDb()
      .select({ metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(eq(auditEvents.orgId, orgId), eq(auditEvents.actorUserId, userId)),
      );
    assert.strictEqual(rows.length, 1);
    const metadata = rows[0]!.metadata as { principal?: { type?: string } } | null;
    assert.ok(metadata && metadata.principal);
    assert.strictEqual(metadata.principal.type, "mcp");
  } finally {
    await ctx.teardown();
  }
});

test("AC4.6 — presence map: set, snapshot, drop", async (t) => {
  _resetPresenceForTests();
  const spaceId = "22222222-2222-2222-2222-222222222222";
  setPresence(spaceId, "u1", { displayName: "Alice", cursorOffset: 5 });
  setPresence(spaceId, "u2", { displayName: "Bob" });
  let snap = snapshotPresence(spaceId);
  assert.strictEqual(snap.length, 2);
  const alice = snap.find((s) => s.userId === "u1");
  assert.ok(alice);
  assert.strictEqual(alice!.state.displayName, "Alice");

  dropPresence(spaceId, "u1");
  snap = snapshotPresence(spaceId);
  assert.strictEqual(snap.length, 1);
  assert.strictEqual(snap[0]!.userId, "u2");

  dropPresence(spaceId, "u2");
  assert.strictEqual(snapshotPresence(spaceId).length, 0);
});

test("AC4.3 — notifyRealtime + listen-pool fanout round-trip", async (t) => {
  let ctx: TestPgSchemaContext | undefined;
  try {
    ctx = await setupPgTestSchema();
  } catch (err) {
    t.skip(`Postgres not reachable: ${String(err)}`);
    return;
  }
  try {
    const spaceId = "33333333-3333-3333-3333-333333333333";
    const channel = channelForSpace(spaceId);
    const received: string[] = [];
    const release = await acquireChannel(channel, (raw) => {
      received.push(raw);
    });
    await clientOpStore.run({ clientOpId: "op-abc" }, async () => {
      await notifyRealtime(spaceId, {
        type: "note.created",
        noteId: "44444444-4444-4444-4444-444444444444",
        projectId: "55555555-5555-5555-5555-555555555555",
        parentId: null,
        title: "Hello",
        noteType: "page",
        siblingIndex: 0,
        createdByUserId: "u1",
        emittedAt: new Date().toISOString(),
      });
    });
    // Give PG NOTIFY a tick to land on the LISTEN client.
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(received.length, 1);
    const evt = JSON.parse(received[0]!) as {
      type: string;
      clientOpId?: string;
      title: string;
    };
    assert.strictEqual(evt.type, "note.created");
    assert.strictEqual(evt.title, "Hello");
    assert.strictEqual(evt.clientOpId, "op-abc");
    await release();
    await _resetChannelsForTests();
  } finally {
    await ctx.teardown();
  }
});

// keep factories alive in tree-shaking-aware bundlers
void factorySpace;
void factoryWorkspace;
void factoryProject;
