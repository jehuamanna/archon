import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WpnNoteWithContextRow } from "./wpn-client.js";
import { findNotesByQuery, isLikelyUuid } from "./find-wpn.js";

describe("isLikelyUuid", () => {
  it("accepts lowercase uuid", () => {
    assert.equal(
      isLikelyUuid("550e8400-e29b-41d4-a716-446655440000"),
      true,
    );
  });
  it("rejects plain title", () => {
    assert.equal(isLikelyUuid("My Note"), false);
  });
});

describe("findNotesByQuery", () => {
  const idA = "550e8400-e29b-41d4-a716-446655440001";
  const idB = "550e8400-e29b-41d4-a716-446655440002";
  const rows: WpnNoteWithContextRow[] = [
    {
      id: idA,
      title: "Todo",
      type: "markdown",
      project_id: "p1",
      project_name: "Core",
      workspace_id: "w1",
      workspace_name: "Main",
    },
    {
      id: idB,
      title: "Todo",
      type: "markdown",
      project_id: "p2",
      project_name: "App",
      workspace_id: "w1",
      workspace_name: "Main",
    },
  ];

  it("returns unique by title", () => {
    const r = findNotesByQuery(rows, "todo", "main", "core");
    assert.equal(r.status, "unique");
    if (r.status === "unique") {
      assert.equal(r.matches.length, 1);
      assert.equal(r.matches[0]!.noteId, idA);
      assert.equal(r.matches[0]!.path, "Main / Core / Todo");
    }
  });

  it("returns ambiguous when same title in scope", () => {
    const r = findNotesByQuery(rows, "todo");
    assert.equal(r.status, "ambiguous");
    if (r.status === "ambiguous") {
      assert.equal(r.matches.length, 2);
    }
  });

  it("returns unique by note id", () => {
    const r = findNotesByQuery(rows, idB);
    assert.equal(r.status, "unique");
    if (r.status === "unique") {
      assert.equal(r.matches[0]!.noteId, idB);
    }
  });
});
