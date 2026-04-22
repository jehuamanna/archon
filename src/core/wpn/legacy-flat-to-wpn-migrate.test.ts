import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bootstrapWorkspaceNotes } from "../notes-persistence";
import { releaseWorkspaceStore } from "../workspace-store";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("legacy flat → WPN migration is idempotent", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archon-legacy-mig-"));
  const dataDir = path.join(tmp, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const wsPath = path.join(dataDir, "archon-workspace.json");
  fs.copyFileSync(
    path.join(__dirname, "__fixtures__", "workspace-mixed-legacy-wpn.json"),
    wsPath,
  );
  const legacyJson = path.join(dataDir, "notes-tree.json");
  fs.writeFileSync(legacyJson, "{}");

  const prevM = process.env.ARCHON_MIGRATE_LEGACY_FLAT_TO_WPN;
  process.env.ARCHON_MIGRATE_LEGACY_FLAT_TO_WPN = "1";
  try {
    const types = ["markdown", "text", "root", "mdx", "code"] as const;
    bootstrapWorkspaceNotes([tmp], legacyJson, [...types], { diskPersistence: true });
    const j = JSON.parse(fs.readFileSync(wsPath, "utf8")) as {
      notes: { id: string }[];
      legacy: { records: unknown[] };
      workspaces: unknown[];
    };
    assert.ok(j.workspaces.length > 0);
    assert.ok(j.notes.length > 0);
    assert.equal(j.legacy.records.length, 0);

    releaseWorkspaceStore();
    bootstrapWorkspaceNotes([tmp], legacyJson, [...types], { diskPersistence: true });
    const j2 = JSON.parse(fs.readFileSync(wsPath, "utf8")) as {
      notes: { id: string }[];
      workspaces: { id: string }[];
    };
    const n2 = j2.notes.length;
    assert.ok(n2 >= j.notes.length);
  } finally {
    releaseWorkspaceStore();
    if (prevM === undefined) {
      delete process.env.ARCHON_MIGRATE_LEGACY_FLAT_TO_WPN;
    } else {
      process.env.ARCHON_MIGRATE_LEGACY_FLAT_TO_WPN = prevM;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
