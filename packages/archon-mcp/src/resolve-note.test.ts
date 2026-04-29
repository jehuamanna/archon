import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WpnNoteWithContextRow } from "./wpn-client.js";
import { resolveNoteFromCatalog } from "./resolve-note.js";

const rows: WpnNoteWithContextRow[] = [
  {
    id: "a1",
    title: "Spec",
    type: "markdown",
    project_id: "p1",
    project_name: "Core",
  },
  {
    id: "a2",
    title: "Spec",
    type: "markdown",
    project_id: "p2",
    project_name: "Other",
  },
];

describe("resolveNoteFromCatalog", () => {
  it("returns single match with case-insensitive names", () => {
    const r = resolveNoteFromCatalog(rows, {
      projectName: "  core ",
      noteTitle: "SPEC",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.noteId, "a1");
    }
  });

  it("returns none when title missing", () => {
    const r = resolveNoteFromCatalog(rows, {
      projectName: "Core",
      noteTitle: "Missing",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "none");
    }
  });

  it("returns ambiguous when same pair exists twice", () => {
    const dup: WpnNoteWithContextRow[] = [
      ...rows,
      {
        id: "a3",
        title: "Spec",
        type: "markdown",
        project_id: "p9",
        project_name: "Core",
      },
    ];
    const r = resolveNoteFromCatalog(dup, {
      projectName: "Core",
      noteTitle: "Spec",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "ambiguous");
      assert.equal(r.candidates.length, 2);
    }
  });
});
