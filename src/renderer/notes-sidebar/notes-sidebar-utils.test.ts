import assert from "node:assert/strict";
import test from "node:test";
import { minimalSelectedRoots, parentMapFromNotes } from "./notes-sidebar-utils.ts";

test("minimalSelectedRoots drops nodes under another selection", () => {
  const notes = [
    { id: "a", type: "t", title: "", parentId: null, depth: 0 },
    { id: "b", type: "t", title: "", parentId: "a", depth: 1 },
  ];
  const parents = parentMapFromNotes(notes);
  const roots = minimalSelectedRoots(new Set(["a", "b"]), parents);
  assert.deepEqual(roots.sort(), ["a"]);
});
