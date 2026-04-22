import assert from "node:assert/strict";
import test from "node:test";
import {
  computeNextScratchNoteTitle,
  SCRATCH_NOTE_BASE_TITLE,
  type ScratchTitleSibling,
} from "./scratch-buffer-titles.ts";

const md = (title: string, parent: string | null = null): ScratchTitleSibling => ({
  title,
  type: "markdown",
  parentId: parent,
});

test("empty siblings → scratch", () => {
  assert.equal(computeNextScratchNoteTitle("markdown", null, []), SCRATCH_NOTE_BASE_TITLE);
});

test("case-insensitive scratch blocks base", () => {
  const sibs = [md("Scratch"), md("notes")];
  const rng = (): number => 0;
  const t = computeNextScratchNoteTitle("markdown", null, sibs, rng);
  assert.match(t, /^scratch-[a-z]+-[a-z]+$/);
});

test("other type may still use scratch", () => {
  const sibs = [{ title: "scratch", type: "code", parentId: null as string | null }];
  assert.equal(computeNextScratchNoteTitle("markdown", null, sibs), SCRATCH_NOTE_BASE_TITLE);
});

test("different parent does not block", () => {
  const sibs = [md("scratch", "p1")];
  assert.equal(computeNextScratchNoteTitle("markdown", null, sibs), SCRATCH_NOTE_BASE_TITLE);
});

test("deterministic RNG yields stable suffix when base taken", () => {
  const sibs = [md("scratch")];
  let i = 0;
  const seq = [0, 0, 0, 0, 0, 0];
  const rng = (): number => {
    const v = (seq[i] ?? 0) / 100;
    i += 1;
    return v;
  };
  const t = computeNextScratchNoteTitle("markdown", null, sibs, rng);
  assert.match(t, /^scratch-[a-z]+-[a-z]+$/);
});

test("re-rolls when random pair collides", () => {
  const sibs = [md("scratch"), md("scratch-mango-banana")];
  let n = 0;
  const rng = (): number => {
    n += 1;
    if (n <= 2) return 0;
    return 0.5;
  };
  const t = computeNextScratchNoteTitle("markdown", null, sibs, rng);
  assert.notEqual(t.toLowerCase(), "scratch-mango-banana");
  assert.match(t, /^scratch-/);
});
