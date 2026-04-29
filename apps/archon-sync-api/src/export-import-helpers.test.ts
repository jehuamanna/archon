import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildExportManifest,
  chooseImportName,
  clearImageMetadataKeys,
  deriveAssetFilename,
  ExportBytesCapExceededError,
  planImportProjects,
  remapExportBundleIds,
  type ExportProjectInput,
  type WpnExportMetadata,
} from "./export-import-helpers.js";

// ────────────────────────────────────────────────────────────────────────────
// remapExportBundleIds (v3 — project-rooted bundle)
// ────────────────────────────────────────────────────────────────────────────

function makeBundle(): WpnExportMetadata {
  return {
    version: 3,
    exported_at_ms: 1_776_000_000_000,
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
              r2Key: "exporter-org/proj-A/note-child",
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
  };
}

describe("remapExportBundleIds", () => {
  it("assigns fresh ids to every project / note and records them", () => {
    let counter = 0;
    const factory = () => `new-id-${counter++}`;
    const { bundle, idRemap } = remapExportBundleIds(makeBundle(), factory);

    assert.equal(bundle.projects.length, 1);
    const proj = bundle.projects[0]!;
    assert.match(proj.id, /^new-id-/);
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
    const proj = bundle.projects[0]!;
    const rootNew = idRemap.notes.get("note-root")!;
    const child = proj.notes[1]!;
    assert.equal(child.parent_id, rootNew);
    assert.equal(proj.notes[0]!.parent_id, null);
  });

  it("preserves non-id fields (titles, metadata, assets)", () => {
    const { bundle } = remapExportBundleIds(makeBundle());
    const child = bundle.projects[0]!.notes[1]!;
    assert.equal(child.title, "jehu");
    assert.equal(child.type, "image");
    assert.equal(child.assets?.[0]?.zipPath, "assets/note-child/jehu.png");
    // Metadata is carried as-is; clearing r2Key is a separate concern.
    assert.equal((child.metadata as { altText?: string }).altText, "a photo");
    assert.equal(
      (child.metadata as { r2Key?: string }).r2Key,
      "exporter-org/proj-A/note-child",
    );
  });

  it("uses randomUUID by default when no factory is injected", () => {
    const { bundle } = remapExportBundleIds(makeBundle());
    const projId = bundle.projects[0]!.id;
    assert.match(projId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
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
  it("creates under the original name when there's no collision", () => {
    const d = chooseImportName({
      name: "Testing",
      existing: new Set(),
      policy: "rename",
    });
    assert.deepEqual(d, { action: "create", name: "Testing" });
  });

  it("skips on collision when policy is 'skip'", () => {
    const d = chooseImportName({
      name: "Testing",
      existing: new Set(["Testing"]),
      policy: "skip",
    });
    assert.deepEqual(d, { action: "skip" });
  });

  it("reuses the existing name on collision when policy is 'overwrite'", () => {
    const d = chooseImportName({
      name: "Testing",
      existing: new Set(["Testing"]),
      policy: "overwrite",
    });
    assert.deepEqual(d, { action: "reuse", name: "Testing" });
  });

  it("appends ' 2' on collision when policy is 'rename' (no date suffix)", () => {
    const d = chooseImportName({
      name: "Testing",
      existing: new Set(["Testing"]),
      policy: "rename",
    });
    assert.deepEqual(d, { action: "create", name: "Testing 2" });
  });

  it("advances the numeric suffix on repeat collisions", () => {
    const d = chooseImportName({
      name: "Testing",
      existing: new Set(["Testing", "Testing 2"]),
      policy: "rename",
    });
    assert.deepEqual(d, { action: "create", name: "Testing 3" });

    const d2 = chooseImportName({
      name: "Testing",
      existing: new Set(["Testing", "Testing 2", "Testing 3"]),
      policy: "rename",
    });
    assert.equal((d2 as { name: string }).name, "Testing 4");
  });

  it("trims whitespace and falls back to a generic name when empty", () => {
    const d = chooseImportName({
      name: "   ",
      existing: new Set(),
      policy: "rename",
    });
    assert.equal(d.action, "create");
    if (d.action === "create") {
      assert.ok(d.name.length > 0, "fallback name must be non-empty");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// deriveAssetFilename
// ────────────────────────────────────────────────────────────────────────────

describe("deriveAssetFilename", () => {
  const noteId = "00000000-0000-0000-0000-00000000aaaa";

  it("prefers the sanitized originalFilename when it already has an extension", () => {
    const name = deriveAssetFilename({
      noteId,
      mimeType: "image/png",
      originalFilename: "my photo.PNG",
    });
    assert.equal(name, "my_photo.PNG");
  });

  it("appends an extension derived from the mime type when original lacks one", () => {
    const name = deriveAssetFilename({
      noteId,
      mimeType: "image/webp",
      originalFilename: "capture",
    });
    assert.equal(name, "capture.webp");
  });

  it("synthesizes <noteId>.<ext> when originalFilename is absent", () => {
    const name = deriveAssetFilename({
      noteId,
      mimeType: "image/jpeg",
    });
    assert.equal(name, `${noteId}.jpg`);
  });

  it("falls back to .bin for unknown mime types", () => {
    const name = deriveAssetFilename({
      noteId,
      mimeType: "application/octet-stream",
    });
    assert.equal(name, `${noteId}.bin`);
  });

  it("strips path separators that would escape the asset directory", () => {
    const name = deriveAssetFilename({
      noteId,
      mimeType: "image/png",
      originalFilename: "../evil/../../etc/passwd.png",
    });
    // Separators become underscores; extension preserved.
    assert.ok(!name.includes("/"));
    assert.ok(!name.includes("\\"));
    assert.ok(name.endsWith(".png"));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildExportManifest
// ────────────────────────────────────────────────────────────────────────────

function projectsWithImage(opts?: {
  extraImages?: Array<{ id: string; sizeBytes: number }>;
  missingR2?: boolean;
}): ExportProjectInput[] {
  const base: ExportProjectInput[] = [
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
          id: "note-jehu",
          parent_id: "note-root",
          type: "image",
          title: "jehu",
          sibling_index: 0,
          metadata: opts?.missingR2
            ? { metadataVersion: 1 }
            : {
                metadataVersion: 1,
                r2Key: "org/proj-A/note-jehu",
                mimeType: "image/png",
                sizeBytes: 35010,
                originalFilename: "jehu.png",
              },
        },
        ...(opts?.extraImages ?? []).map((x) => ({
          id: x.id,
          parent_id: "note-root" as string | null,
          type: "image",
          title: x.id,
          sibling_index: 1,
          metadata: {
            metadataVersion: 1,
            r2Key: `org/proj-A/${x.id}`,
            mimeType: "image/png",
            sizeBytes: x.sizeBytes,
          } as Record<string, unknown> | null,
        })),
      ],
    },
  ];
  return base;
}

describe("buildExportManifest", () => {
  it("emits version 3 and an asset plan for each image note with r2Key", () => {
    const result = buildExportManifest({
      projects: projectsWithImage(),
      exportedAtMs: 1_776_000_000_000,
      maxAssetBytes: 1_000_000,
    });
    assert.equal(result.metadata.version, 3);
    assert.equal(result.metadata.exported_at_ms, 1_776_000_000_000);
    assert.equal(result.assets.length, 1);
    const plan = result.assets[0]!;
    assert.equal(plan.noteId, "note-jehu");
    assert.equal(plan.mimeType, "image/png");
    assert.equal(plan.sizeBytes, 35010);
    assert.equal(plan.zipPath, "assets/note-jehu/jehu.png");
    assert.equal(plan.r2Key, "org/proj-A/note-jehu");
    assert.equal(result.totalAssetBytes, 35010);
  });

  it("copies the assets[] entry onto the note's manifest entry", () => {
    const result = buildExportManifest({
      projects: projectsWithImage(),
      exportedAtMs: 0,
      maxAssetBytes: 1_000_000,
    });
    const notes = result.metadata.projects[0]!.notes;
    const root = notes.find((n) => n.id === "note-root")!;
    const jehu = notes.find((n) => n.id === "note-jehu")!;
    assert.equal(root.assets, undefined, "non-image notes must not carry assets");
    assert.ok(jehu.assets && jehu.assets.length === 1);
    assert.equal(jehu.assets![0]!.zipPath, "assets/note-jehu/jehu.png");
    assert.equal(jehu.assets![0]!.mimeType, "image/png");
    assert.equal(jehu.assets![0]!.originalFilename, "jehu.png");
  });

  it("skips image notes without r2Key (broken notes pass through)", () => {
    const result = buildExportManifest({
      projects: projectsWithImage({ missingR2: true }),
      exportedAtMs: 0,
      maxAssetBytes: 1_000_000,
    });
    assert.equal(result.assets.length, 0);
    const jehu = result.metadata.projects[0]!.notes.find(
      (n) => n.id === "note-jehu",
    )!;
    assert.equal(jehu.assets, undefined);
    assert.equal(result.totalAssetBytes, 0);
  });

  it("throws ExportBytesCapExceededError once the running total exceeds the cap", () => {
    assert.throws(
      () =>
        buildExportManifest({
          projects: projectsWithImage({
            extraImages: [
              { id: "note-big1", sizeBytes: 600_000 },
              { id: "note-big2", sizeBytes: 600_000 },
            ],
          }),
          exportedAtMs: 0,
          maxAssetBytes: 1_000_000,
        }),
      (err: unknown) => err instanceof ExportBytesCapExceededError,
    );
  });

  it("counts bytes cumulatively across multiple image notes", () => {
    const result = buildExportManifest({
      projects: projectsWithImage({
        extraImages: [
          { id: "note-extra1", sizeBytes: 1_000 },
          { id: "note-extra2", sizeBytes: 2_000 },
        ],
      }),
      exportedAtMs: 0,
      maxAssetBytes: 1_000_000,
    });
    assert.equal(result.assets.length, 3);
    assert.equal(result.totalAssetBytes, 35010 + 1_000 + 2_000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// planImportProjects (v3 — project-rooted)
// ────────────────────────────────────────────────────────────────────────────

function bundleWithProjects(names: string[]): WpnExportMetadata {
  return {
    version: 3,
    exported_at_ms: 0,
    projects: names.map((name, i) => ({
      id: `proj-${i}`,
      name,
      sort_index: i,
      color_token: null,
      notes: [
        {
          id: `note-${i}-a`,
          parent_id: null,
          type: "markdown",
          title: "Alpha",
          sibling_index: 0,
          metadata: null,
        },
      ],
    })),
  };
}

describe("planImportProjects", () => {
  it("creates projects unchanged when there's no collision", () => {
    const plan = planImportProjects({
      bundle: bundleWithProjects(["Fresh"]),
      existingProjects: [],
      policy: "rename",
    });
    assert.equal(plan.projects.length, 1);
    const action = plan.projects[0]!;
    assert.equal(action.kind, "create");
    if (action.kind === "create") {
      assert.equal(action.chosenName, "Fresh");
      assert.equal(action.renamed, false);
      assert.equal(action.sourceProjectId, "proj-0");
    }
  });

  it("renames the project on collision when policy is 'rename'", () => {
    const plan = planImportProjects({
      bundle: bundleWithProjects(["Testing"]),
      existingProjects: [{ id: "existing", name: "Testing" }],
      policy: "rename",
    });
    const action = plan.projects[0]!;
    assert.equal(action.kind, "create");
    if (action.kind === "create") {
      assert.equal(action.chosenName, "Testing 2");
      assert.equal(action.renamed, true);
    }
  });

  it("skips the project when policy is 'skip' and a collision exists", () => {
    const plan = planImportProjects({
      bundle: bundleWithProjects(["Testing", "Fresh"]),
      existingProjects: [{ id: "existing", name: "Testing" }],
      policy: "skip",
    });
    assert.equal(plan.projects[0]!.kind, "skip");
    assert.equal(plan.projects[1]!.kind, "create");
  });

  it("reuses the existing project id when policy is 'overwrite'", () => {
    const plan = planImportProjects({
      bundle: bundleWithProjects(["Testing"]),
      existingProjects: [{ id: "existing-123", name: "Testing" }],
      policy: "overwrite",
    });
    const action = plan.projects[0]!;
    assert.equal(action.kind, "reuse");
    if (action.kind === "reuse") {
      assert.equal(action.existingProjectId, "existing-123");
    }
  });

  it("disambiguates two bundled projects that collide with each other on rename", () => {
    const plan = planImportProjects({
      bundle: bundleWithProjects(["Testing", "Testing"]),
      existingProjects: [{ id: "existing", name: "Testing" }],
      policy: "rename",
    });
    const names = plan.projects.map((a) =>
      a.kind === "create" ? a.chosenName : a.kind,
    );
    assert.deepEqual(names, ["Testing 2", "Testing 3"]);
  });
});
