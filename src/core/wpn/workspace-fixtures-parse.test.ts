import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseWorkspaceSlotWpnArrays } from "./wpn-slot-json-parse.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("golden fixture: WPN-only slot parses arrays", () => {
  const raw = fs.readFileSync(
    path.join(__dirname, "__fixtures__", "workspace-wpn-only-slot.json"),
    "utf8",
  );
  const p = parseWorkspaceSlotWpnArrays(raw);
  assert.equal(p.workspaces.length, 1);
  assert.equal(p.notes[0]!.title, "Hello");
});

test("golden fixture: mixed legacy + empty WPN parses", () => {
  const raw = fs.readFileSync(
    path.join(__dirname, "__fixtures__", "workspace-mixed-legacy-wpn.json"),
    "utf8",
  );
  const p = parseWorkspaceSlotWpnArrays(raw);
  assert.equal(p.workspaces.length, 0);
  assert.equal(p.notes.length, 0);
  const j = JSON.parse(raw) as { legacy: { records: unknown[] } };
  assert.equal(j.legacy.records.length, 1);
});
