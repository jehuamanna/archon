import test from "node:test";
import assert from "node:assert/strict";

test("isLocalRxdbWpnMirrorEnabled respects ARCHON_LOCAL_RXDB_WPN", async () => {
  const { isLocalRxdbWpnMirrorEnabled } = await import("./flags.ts");
  const prev = process.env.ARCHON_LOCAL_RXDB_WPN;
  try {
    delete process.env.ARCHON_LOCAL_RXDB_WPN;
    assert.equal(isLocalRxdbWpnMirrorEnabled(), false);
    process.env.ARCHON_LOCAL_RXDB_WPN = "1";
    assert.equal(isLocalRxdbWpnMirrorEnabled(), true);
  } finally {
    if (prev === undefined) {
      delete process.env.ARCHON_LOCAL_RXDB_WPN;
    } else {
      process.env.ARCHON_LOCAL_RXDB_WPN = prev;
    }
  }
});

test("importWorkspaceJsonSnapshot round-trip when IndexedDB exists", async (t) => {
  if (typeof indexedDB === "undefined") {
    t.skip();
    return;
  }
  const prev = process.env.ARCHON_LOCAL_RXDB_WPN;
  process.env.ARCHON_LOCAL_RXDB_WPN = "1";
  const {
    closeWorkspaceWpnRxDb,
    importWorkspaceJsonSnapshot,
    readLatestWorkspaceJsonSnapshot,
  } = await import("./workspace-wpn-rxdb.ts");
  const vk = "test_vault_roundtrip";
  const json = JSON.stringify({ workspaces: [], version: 1, test: true });
  try {
    const r = await importWorkspaceJsonSnapshot(vk, json);
    assert.equal(r.ok, true);
    const round = await readLatestWorkspaceJsonSnapshot(vk);
    assert.equal(round, json);
  } finally {
    await closeWorkspaceWpnRxDb();
    if (prev === undefined) {
      delete process.env.ARCHON_LOCAL_RXDB_WPN;
    } else {
      process.env.ARCHON_LOCAL_RXDB_WPN = prev;
    }
  }
});

test("importWorkspaceMirrorFromMainPayload hydrates local WPN mirror collections", async (t) => {
  if (typeof indexedDB === "undefined") {
    t.skip();
    return;
  }
  const prev = process.env.ARCHON_LOCAL_RXDB_WPN;
  process.env.ARCHON_LOCAL_RXDB_WPN = "1";
  const {
    closeWorkspaceWpnRxDb,
    getOpenWorkspaceWpnRxDb,
    importWorkspaceMirrorFromMainPayload,
  } = await import("./workspace-wpn-rxdb.ts");
  const slotJson = JSON.stringify({
    fileVersion: 1,
    workspaces: [
      {
        id: "w1",
        owner_id: "o1",
        name: "W",
        sort_index: 0,
        color_token: null,
        created_at_ms: 0,
        updated_at_ms: 0,
      },
    ],
    projects: [],
    notes: [],
    explorer: [],
  });
  const payload = {
    v: 1 as const,
    vaultKey: "test_vault_hydrate_cols",
    slots: [{ root: "/tmp/r1", path: "/tmp/r1/data/archon-workspace.json", json: slotJson }],
  };
  try {
    await importWorkspaceMirrorFromMainPayload(payload);
    const db = getOpenWorkspaceWpnRxDb();
    assert.ok(db);
    const docs = await db.local_wpn_workspaces.find().exec();
    assert.ok(docs.length >= 1);
    const j = docs[0]!.toMutableJSON(false) as { owner_id: string; name: string };
    assert.equal(j.owner_id, "o1");
    assert.equal(j.name, "W");
  } finally {
    await closeWorkspaceWpnRxDb();
    if (prev === undefined) {
      delete process.env.ARCHON_LOCAL_RXDB_WPN;
    } else {
      process.env.ARCHON_LOCAL_RXDB_WPN = prev;
    }
  }
});
