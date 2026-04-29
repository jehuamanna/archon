import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalVfsPathFromRow,
  normalizeVfsSegment,
  parseVfsHashSegments,
  resolveVfsHrefToNoteId,
} from "./note-vfs-resolve.js";
import type { WpnNoteListItem, WpnNoteWithContextRow } from "./wpn-client.js";

function makeCatalog(rows: WpnNoteWithContextRow[]) {
  const byCanonical = new Map<string, string>();
  for (const r of rows) byCanonical.set(canonicalVfsPathFromRow(r), r.id);
  return byCanonical;
}

const rowP = "Archon";

const row = (id: string, title: string): WpnNoteWithContextRow => ({
  id,
  title,
  type: "markdown",
  project_id: "p1",
  project_name: rowP,
});

const treeItem = (
  id: string,
  title: string,
  parent_id: string | null,
): WpnNoteListItem => ({
  id,
  project_id: "p1",
  parent_id,
  type: "markdown",
  title,
  depth: 0,
  sibling_index: 0,
});

test("normalizeVfsSegment replaces forward slash with U+2215", () => {
  assert.equal(normalizeVfsSegment("Sign/signup", "x"), "Sign∕signup");
  assert.equal(normalizeVfsSegment("   ", "fallback"), "fallback");
});

test("canonicalVfsPathFromRow builds Project/Title", () => {
  assert.equal(
    canonicalVfsPathFromRow(row("id1", "Feature")),
    "Archon/Feature",
  );
});

test("parseVfsHashSegments decodes segments", () => {
  const p = parseVfsHashSegments("./polling%20for%20WPN%20updatee");
  assert.ok(p);
  assert.equal(p.kind, "rel-same-project");
  assert.deepEqual(p.segments, [".", "polling for WPN updatee"]);
});

test("parseVfsHashSegments strips heading slug on absolute path", () => {
  const p = parseVfsHashSegments("Archon/Feature/section-one");
  assert.ok(p);
  assert.equal(p.kind, "absolute");
  assert.deepEqual(p.segments, ["Archon", "Feature"]);
  assert.equal(p.headingSlug, "section-one");
});

test("resolve same-project-relative via catalog", async () => {
  const parent = row("pid", "Feature");
  const child = row("cid", "polling for WPN updatee");
  const byCanonical = makeCatalog([parent, child]);
  const res = await resolveVfsHrefToNoteId(
    "./polling%20for%20WPN%20updatee",
    parent,
    { catalogByCanonical: byCanonical, getProjectTree: async () => [] },
  );
  assert.deepEqual(res, { ok: true, noteId: "cid" });
});

test("resolve absolute canonical via catalog (2-segment Project/Title)", async () => {
  const parent = row("pid", "Feature");
  const other = row("oid", "Target");
  const byCanonical = makeCatalog([parent, other]);
  const res = await resolveVfsHrefToNoteId(
    "Archon/Target",
    parent,
    { catalogByCanonical: byCanonical, getProjectTree: async () => [] },
  );
  assert.deepEqual(res, { ok: true, noteId: "oid" });
});

test("resolve same-project-relative handles normalized slash-in-title", async () => {
  const parent = row("pid", "Feature");
  const slashed = row("sid", "Sign∕signup here");
  const byCanonical = makeCatalog([parent, slashed]);
  const res = await resolveVfsHrefToNoteId(
    "./Sign%E2%88%95signup%20here",
    parent,
    { catalogByCanonical: byCanonical, getProjectTree: async () => [] },
  );
  assert.deepEqual(res, { ok: true, noteId: "sid" });
});

test("resolve tree-relative sibling via project tree", async () => {
  const parent = row("root", "Feature");
  const tree: WpnNoteListItem[] = [
    treeItem("root", "Feature", null),
    treeItem("sib1", "polling for WPN updatee", "root"),
    treeItem("sib2", "other thing", "root"),
  ];
  const byCanonical = makeCatalog([parent]);
  const res = await resolveVfsHrefToNoteId(
    "../polling%20for%20WPN%20updatee",
    { ...parent, id: "sib2" },
    { catalogByCanonical: byCanonical, getProjectTree: async () => tree },
  );
  assert.deepEqual(res, { ok: true, noteId: "sib1" });
});

test("resolve tree-relative ../../grandparent-child", async () => {
  const tree: WpnNoteListItem[] = [
    treeItem("root", "Root", null),
    treeItem("p", "Parent", "root"),
    treeItem("c", "Child", "p"),
    treeItem("uncle", "Uncle", "root"),
  ];
  const base = row("c", "Child");
  const res = await resolveVfsHrefToNoteId(
    "../../Uncle",
    base,
    { catalogByCanonical: new Map(), getProjectTree: async () => tree },
  );
  assert.deepEqual(res, { ok: true, noteId: "uncle" });
});

test("unresolved returns reason", async () => {
  const parent = row("pid", "Feature");
  const byCanonical = makeCatalog([parent]);
  const res = await resolveVfsHrefToNoteId("./Nope", parent, {
    catalogByCanonical: byCanonical,
    getProjectTree: async () => [],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /no note matched/);
});
