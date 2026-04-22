import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chooseImportName,
  clearImageMetadataKeys,
  remapExportBundleIds,
  type WpnExportMetadata,
} from "./export-import-helpers.js";

// ────────────────────────────────────────────────────────────────────────────
// remapExportBundleIds
// ────────────────────────────────────────────────────────────────────────────

function makeBundle(): WpnExportMetadata {
  return {
    version: 2,
    exported_at_ms: 1_776_000_000_000,
    workspaces: [
      {
        id: "ws-A",
        name: "Testing",
        sort_index: 0,
        color_token: null,
        projects: [
          {
            id: "proj-A",
            name: "Image",
            sort_index: 0,
            color_token: null,
            notes: [
              {
                id: "note-root",
                parent_id: null,
                type: "markdown",
                title: "Root",
                sibling_index: 0,
                metadata: null,
              },
              {
                id: "note-child",
                parent_id: "note-root",
                type: "image",
                title: "jehu",
                sibling_index: 0,
                metadata: {
                  metadataVersion: 1,
                  r2Key: "exporter-org/exporter-space/ws-A/proj-A/note-child",
                  mimeType: "image/png",
                  sizeBytes: 35010,
                  altText: "a photo",
                },
                assets: [
                  { zipPath: "assets/note-child/jehu.png", mimeType: "image/png", sizeBytes: 35010 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("remapExportBundleIds", () => {
  it("assigns fresh ids to every workspace / project / note and records them", () => {
    let counter = 0;
    const factory = () => `new-id-${counter++}`;
    const { bundle, idRemap } = remapExportBundleIds(makeBundle(), factory);

    assert.equal(bundle.workspaces.length, 1);
    const ws = bundle.workspaces[0]!;
    assert.match(ws.id, /^new-id-/);
    assert.equal(idRemap.workspaces.get("ws-A"), ws.id);

    const proj = ws.projects[0]!;
    assert.match(proj.id, /^new-id-/);
    assert.notEqual(proj.id, ws.id);
    assert.equal(idRemap.projects.get("proj-A"), proj.id);

    const root = proj.notes[0]!;
    const child = proj.notes[1]!;
    assert.match(root.id, /^new-id-/);
    assert.match(child.id, /^new-id-/);
    assert.equal(idRemap.notes.get("note-root"), root.id);
    assert.equal(idRemap.notes.get("note-child"), child.id);
  });

  it("rewrites parent_id references using the remapped note ids", () => {
    let counter = 0;
    const factory = () => `x${counter++}`;
    const { bundle, idRemap } = remapExportBundleIds(makeBundle(), factory);
    const proj = bundle.workspaces[0]!.projects[0]!;
    const rootNew = idRemap.notes.get("note-root")!;
    const child = proj.notes[1]!;
    assert.equal(child.parent_id, rootNew);
    assert.equal(proj.notes[0]!.parent_id, null);
  });

  it("preserves non-id fields (titles, metadata, assets)", () => {
    const { bundle } = remapExportBundleIds(makeBundle());
    const child = bundle.workspaces[0]!.projects[0]!.notes[1]!;
    assert.equal(child.title, "jehu");
    assert.equal(child.type, "image");
    assert.equal(child.assets?.[0]?.zipPath, "assets/note-child/jehu.png");
    // Metadata is carried as-is; clearing r2Key is a separate concern.
    assert.equal((child.metadata as { altText?: string }).altText, "a photo");
    assert.equal(
      (child.metadata as { r2Key?: string }).r2Key,
      "exporter-org/exporter-space/ws-A/proj-A/note-child",
    );
  });

  it("uses randomUUID by default when no factory is injected", () => {
    const { bundle } = remapExportBundleIds(makeBundle());
    const wsId = bundle.workspaces[0]!.id;
    assert.match(wsId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// clearImageMetadataKeys
// ────────────────────────────────────────────────────────────────────────────

describe("clearImageMetadataKeys", () => {
  it("strips r2Key / thumbKey / thumbMime / thumbSizeBytes", () => {
    const m = {
      metadataVersion: 1,
      r2Key: "a/b/c",
      mimeType: "image/png",
      sizeBytes: 10,
      thumbKey: "a/b/c/thumb",
      thumbMime: "image/webp",
      thumbSizeBytes: 5,
      altText: "x",
    };
    const out = clearImageMetadataKeys(m);
    assert.ok(out);
    assert.equal(out.metadataVersion, 1);
    assert.equal(out.mimeType, "image/png");
    assert.equal(out.sizeBytes, 10);
    assert.equal(out.altText, "x");
    assert.equal("r2Key" in out, false);
    assert.equal("thumbKey" in out, false);
    assert.equal("thumbMime" in out, false);
    assert.equal("thumbSizeBytes" in out, false);
  });

  it("leaves unrelated metadata untouched", () => {
    const m = { foo: "bar", nested: { r2Key: "should-stay" } };
    const out = clearImageMetadataKeys(m);
    assert.deepEqual(out, { foo: "bar", nested: { r2Key: "should-stay" } });
  });

  it("returns null for null / undefined input", () => {
    assert.equal(clearImageMetadataKeys(null), null);
    assert.equal(clearImageMetadataKeys(undefined), null);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// chooseImportName
// ────────────────────────────────────────────────────────────────────────────

describe("chooseImportName", () => {
  const now = Date.UTC(2026, 3, 22); // 2026-04-22

  it("creates under the original name when there's no collision", () => {
    const d = chooseImportName({
      name: "Testing",
      existing: new Set(),
      policy: "rename",
      nowMs: now,
    });
    assert.deepEqual(d, { action: "create", name: "Testing" });
  });

  it("skips on collision when policy is 'skip'", () => {
    const d = chooseImportName({
      name: "Testing",
      existing: new Set(["Testing"]),
      policy: "skip",
      nowMs: now,
    });
    assert.deepEqual(d, { action: "skip" });
  });

  it("reuses the existing name on collision when policy is 'overwrite'", () => {
    const d = chooseImportName({
      name: "Testing",
      existing: new Set(["Testing"]),
      policy: "overwrite",
      nowMs: now,
    });
    assert.deepEqual(d, { action: "reuse", name: "Testing" });
  });

  it("appends '(imported YYYY-MM-DD)' on collision when policy is 'rename'", () => {
    const d = chooseImportName({
      name: "Testing",
      existing: new Set(["Testing"]),
      policy: "rename",
      nowMs: now,
    });
    assert.deepEqual(d, {
      action: "create",
      name: "Testing (imported 2026-04-22)",
    });
  });

  it("disambiguates repeat-collision renames with a numeric suffix", () => {
    const d = chooseImportName({
      name: "Testing",
      existing: new Set(["Testing", "Testing (imported 2026-04-22)"]),
      policy: "rename",
      nowMs: now,
    });
    assert.deepEqual(d, {
      action: "create",
      name: "Testing (imported 2026-04-22) 2",
    });

    const d2 = chooseImportName({
      name: "Testing",
      existing: new Set([
        "Testing",
        "Testing (imported 2026-04-22)",
        "Testing (imported 2026-04-22) 2",
      ]),
      policy: "rename",
      nowMs: now,
    });
    assert.equal((d2 as { name: string }).name, "Testing (imported 2026-04-22) 3");
  });

  it("trims whitespace and falls back to 'Workspace' when the name is empty", () => {
    const d = chooseImportName({
      name: "   ",
      existing: new Set(),
      policy: "rename",
      nowMs: now,
    });
    assert.deepEqual(d, { action: "create", name: "Workspace" });
  });

  it("default injection uses current time but format is stable", () => {
    const d = chooseImportName({
      name: "Testing",
      existing: new Set(["Testing"]),
      policy: "rename",
    });
    assert.equal((d as { action: string }).action, "create");
    assert.match((d as { name: string }).name, /^Testing \(imported \d{4}-\d{2}-\d{2}\)$/);
  });
});
