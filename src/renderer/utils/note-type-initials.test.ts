import assert from "node:assert/strict";
import test from "node:test";
import { noteTypeInitials } from "./note-type-initials.ts";

test("noteTypeInitials distinguishes markdown from mdx", () => {
  assert.equal(noteTypeInitials("markdown"), "MD");
  assert.equal(noteTypeInitials("mdx"), "MX");
});
