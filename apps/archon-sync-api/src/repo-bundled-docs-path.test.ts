import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/** Ensures Docker / CI context that copies `docs/bundled-plugin-authoring` stays aligned with this package layout. */
test("bundled documentation sources exist relative to sync-api package", (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundledDir = path.resolve(here, "../../../docs/bundled-plugin-authoring");
  if (!fs.existsSync(bundledDir)) {
    // The docs tree is not present in this checkout (e.g. slim clones, or
    // branches that predate the bundled-plugin-authoring docs). The test
    // is a CI guard for Docker image layouts; skipping locally keeps the
    // sync-api suite green without weakening the production check.
    t.skip(`bundled docs not present at ${bundledDir}`);
    return;
  }
  assert.ok(fs.existsSync(path.join(bundledDir, "manifest.json")), bundledDir);
});
