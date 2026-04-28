import assert from "node:assert/strict";
import test from "node:test";
import {
  isNoteVisibleInTree,
  pruneExpandedNoteParents,
} from "./wpnExplorerTreeVisibility.ts";

/**
 * Tree fixture used by every case below:
 *
 *   root-1 (parent: null)
 *   ├── a (parent: root-1)
 *   │   └── b (parent: a)
 *   │       └── c (parent: b)
 *   └── sibling-of-a (parent: root-1)
 *   root-2 (parent: null)
 */
function fixtureParentMap(): Map<string, string | null> {
  return new Map<string, string | null>([
    ["root-1", null],
    ["root-2", null],
    ["a", "root-1"],
    ["sibling-of-a", "root-1"],
    ["b", "a"],
    ["c", "b"],
  ]);
}

test("top-level notes are always visible (no ancestors to check)", () => {
  const parents = fixtureParentMap();
  // The renderNoteRows loop only invokes the helper for depth > 0, but the
  // helper itself must still answer correctly for depth-0 ids (they have no
  // ancestors, so the loop returns true immediately).
  assert.equal(isNoteVisibleInTree("root-1", parents, new Set()), true);
  assert.equal(isNoteVisibleInTree("root-2", parents, new Set()), true);
});

test("direct child is visible iff the immediate parent is expanded", () => {
  const parents = fixtureParentMap();
  assert.equal(isNoteVisibleInTree("a", parents, new Set()), false);
  assert.equal(isNoteVisibleInTree("a", parents, new Set(["root-1"])), true);
});

test("Bug-f08b02 — collapsed ancestor hides descendants even when intermediate nodes stay in the expanded set", () => {
  const parents = fixtureParentMap();
  // User had previously expanded root-1, a, b — then collapses root-1.
  // Pre-fix the visibility check only looked at the immediate parent, so
  // `c` (parent=b, b ∈ set) was rendered orphaned even though its
  // ancestor `root-1` was collapsed.
  const expanded = new Set(["a", "b"]); // root-1 absent
  assert.equal(
    isNoteVisibleInTree("a", parents, expanded),
    false,
    "a is hidden because its parent root-1 is collapsed",
  );
  assert.equal(
    isNoteVisibleInTree("b", parents, expanded),
    false,
    "b is hidden because its grandparent root-1 is collapsed",
  );
  assert.equal(
    isNoteVisibleInTree("c", parents, expanded),
    false,
    "c is hidden because root-1 (great-grandparent) is collapsed — Bug-f08b02 regression",
  );
});

test("re-expanding a parent restores the previously-remembered descendant state (per-node memory)", () => {
  const parents = fixtureParentMap();
  // After the user re-expands root-1, the rest of the set is unchanged,
  // so b's subtree should be visible again — that's the user's stated
  // intended behaviour #2 (collapse remembers children's state).
  const expanded = new Set(["root-1", "a", "b"]);
  assert.equal(isNoteVisibleInTree("a", parents, expanded), true);
  assert.equal(isNoteVisibleInTree("b", parents, expanded), true);
  assert.equal(isNoteVisibleInTree("c", parents, expanded), true);
});

test("expanding only the immediate parent does not reveal grandchildren (intended behaviour #1)", () => {
  const parents = fixtureParentMap();
  // Fresh state: user expands just root-1. `a` is visible; `b` and `c`
  // stay hidden until the user opens them. Matches the intended
  // "progressive open" behaviour.
  const expanded = new Set(["root-1"]);
  assert.equal(isNoteVisibleInTree("a", parents, expanded), true);
  assert.equal(isNoteVisibleInTree("sibling-of-a", parents, expanded), true);
  assert.equal(isNoteVisibleInTree("b", parents, expanded), false);
  assert.equal(isNoteVisibleInTree("c", parents, expanded), false);
});

test("first space load with empty expanded set keeps all non-root notes hidden (intended behaviour #3)", () => {
  const parents = fixtureParentMap();
  const expanded = new Set<string>();
  assert.equal(isNoteVisibleInTree("a", parents, expanded), false);
  assert.equal(isNoteVisibleInTree("b", parents, expanded), false);
  assert.equal(isNoteVisibleInTree("c", parents, expanded), false);
});

test("Bug-fdcaf4 — pruneExpandedNoteParents drops ids that no longer exist in the project tree", () => {
  // After a refresh+fetch (or a delete) the local set may carry ids whose
  // notes are gone; prune drops those without re-introducing any other ids.
  const prev = new Set(["a", "b", "c", "stale-1", "stale-2"]);
  const noteIds = new Set(["a", "b", "c", "d"]);
  const out = pruneExpandedNoteParents(prev, noteIds);
  assert.deepEqual([...out].sort(), ["a", "b", "c"]);
});

test("Bug-fdcaf4 — pruneExpandedNoteParents does NOT add ids that aren't already in `prev`", () => {
  // The whole point of replacing the old merge helper: stop seeding the
  // local state from external sources (server / cache). Even if `noteIds`
  // contains many candidate parents, prune only keeps existing entries.
  const prev = new Set<string>();
  const noteIds = new Set(["a", "b", "c"]);
  const out = pruneExpandedNoteParents(prev, noteIds);
  assert.equal(out.size, 0);
});

test("Bug-fdcaf4 — pruneExpandedNoteParents returns a fresh Set (caller can mutate without aliasing prev)", () => {
  const prev = new Set(["a"]);
  const noteIds = new Set(["a"]);
  const out = pruneExpandedNoteParents(prev, noteIds);
  assert.notStrictEqual(out, prev);
  out.add("b");
  assert.equal(prev.has("b"), false);
});

test("defensive: a cycle in the parent map returns false rather than spinning", () => {
  // x → y → x is impossible by construction but the helper must terminate
  // even if a cache races into an inconsistent state.
  const parents = new Map<string, string | null>([
    ["x", "y"],
    ["y", "x"],
  ]);
  assert.equal(isNoteVisibleInTree("x", parents, new Set(["x", "y"])), false);
});
