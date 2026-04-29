import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WpnNoteListItem } from "./wpn-client.js";
import {
  noteTitlePath,
  parseParentWpnPath,
  resolveParentInTree,
} from "./resolve-parent-in-tree.js";

function item(p: Partial<WpnNoteListItem> & Pick<WpnNoteListItem, "id" | "title" | "parent_id">): WpnNoteListItem {
  return {
    project_id: p.project_id ?? "p1",
    type: p.type ?? "markdown",
    depth: p.depth ?? 0,
    sibling_index: p.sibling_index ?? 0,
    ...p,
  };
}

describe("parseParentWpnPath", () => {
  it("parses project + title chain (post-migration 2-segment minimum)", () => {
    const r = parseParentWpnPath("Core / Alpha / Beta");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.projectName, "Core");
      assert.deepEqual(r.parentPathTitles, ["Alpha", "Beta"]);
    }
  });

  it("rejects single segment (needs project + at least one title)", () => {
    const r = parseParentWpnPath("OnlyOne");
    assert.equal(r.ok, false);
  });
});

describe("resolveParentInTree", () => {
  it("resolves a unique chain under one root", () => {
    const notes: WpnNoteListItem[] = [
      item({ id: "r1", title: "Root", parent_id: null, sibling_index: 0, depth: 0 }),
      item({ id: "c1", title: "Child", parent_id: "r1", sibling_index: 0, depth: 1 }),
    ];
    const r = resolveParentInTree(notes, ["Root", "Child"]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.parentId, "c1");
      assert.equal(r.projectId, "p1");
    }
  });

  it("returns none when a segment is missing", () => {
    const notes: WpnNoteListItem[] = [
      item({ id: "r1", title: "Root", parent_id: null, sibling_index: 0 }),
    ];
    const r = resolveParentInTree(notes, ["Root", "Nope"]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "none");
    }
  });

  it("returns ambiguous when duplicate sibling titles match", () => {
    const notes: WpnNoteListItem[] = [
      item({ id: "r1", title: "Root", parent_id: null, sibling_index: 0 }),
      item({ id: "a", title: "Dup", parent_id: "r1", sibling_index: 0 }),
      item({ id: "b", title: "Dup", parent_id: "r1", sibling_index: 1 }),
    ];
    const r = resolveParentInTree(notes, ["Root", "Dup"]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "ambiguous");
      assert.equal(r.candidates.length, 2);
    }
  });

  it("returns ambiguous when multiple roots share a title", () => {
    const notes: WpnNoteListItem[] = [
      item({ id: "r1", title: "Same", parent_id: null, sibling_index: 0 }),
      item({ id: "r2", title: "Same", parent_id: null, sibling_index: 1 }),
    ];
    const r = resolveParentInTree(notes, ["Same"]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "ambiguous");
    }
  });

  it("matches titles with norm (case / whitespace)", () => {
    const notes: WpnNoteListItem[] = [
      item({ id: "r1", title: "  Hello ", parent_id: null, sibling_index: 0 }),
    ];
    const r = resolveParentInTree(notes, ["hello"]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.parentId, "r1");
    }
  });
});

describe("noteTitlePath", () => {
  it("builds path from root to note", () => {
    const notes: WpnNoteListItem[] = [
      item({ id: "r1", title: "A", parent_id: null, sibling_index: 0 }),
      item({ id: "c1", title: "B", parent_id: "r1", sibling_index: 0 }),
    ];
    const byId = new Map(notes.map((n) => [n.id, n] as const));
    const p = noteTitlePath("c1", byId);
    assert.equal(p, "A / B");
  });
});
