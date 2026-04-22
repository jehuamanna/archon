import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractReferencedLinksFromMarkdown,
  extractReferencedNoteIdsFromMarkdown,
} from "./note-link-extract.js";

test("extracts noteId from #/n/<id> link", () => {
  const md = "see [target](#/n/abc-123) for details";
  assert.deepEqual(extractReferencedNoteIdsFromMarkdown(md), ["abc-123"]);
});

test("extracts noteId with slug suffix", () => {
  const md = "[anchor](#/n/abc-123/some-heading)";
  assert.deepEqual(extractReferencedNoteIdsFromMarkdown(md), ["abc-123"]);
});

test("dedups repeated ids preserving first-seen order", () => {
  const md =
    "[a](#/n/id-A) and [b](#/n/id-B) and again [a2](#/n/id-A) and [c](#/n/id-C)";
  assert.deepEqual(extractReferencedNoteIdsFromMarkdown(md), [
    "id-A",
    "id-B",
    "id-C",
  ]);
});

test("ignores VFS links and external URLs", () => {
  const md =
    "see [vfs](#/w/Workspace/Project/Note) and [ext](https://example.com)";
  assert.deepEqual(extractReferencedNoteIdsFromMarkdown(md), []);
});

test("handles leading-slash and bare forms", () => {
  const md = "[x](/n/zzz) and [y](n/yyy)";
  assert.deepEqual(extractReferencedNoteIdsFromMarkdown(md), ["zzz", "yyy"]);
});

test("returns empty for empty / non-link content", () => {
  assert.deepEqual(extractReferencedNoteIdsFromMarkdown(""), []);
  assert.deepEqual(extractReferencedNoteIdsFromMarkdown("plain text only"), []);
});

test("ignores malformed link with no href body", () => {
  assert.deepEqual(extractReferencedNoteIdsFromMarkdown("[label]()"), []);
});

test("multiple links on one line", () => {
  const md = "[a](#/n/1) [b](#/n/2) [c](#/n/3)";
  assert.deepEqual(extractReferencedNoteIdsFromMarkdown(md), ["1", "2", "3"]);
});

test("extractReferencedLinksFromMarkdown collects both forms deduped", () => {
  const md =
    "[id](#/n/abc) and [vfs](#/w/./A) and again [id2](#/n/abc) and [vfs2](#/w/./A) and [other](#/w/Archon/Studio/B)";
  const r = extractReferencedLinksFromMarkdown(md);
  assert.deepEqual(r.noteIds, ["abc"]);
  assert.deepEqual(r.vfsHrefPaths, ["./A", "Archon/Studio/B"]);
});

test("extractReferencedLinksFromMarkdown: vfs-only", () => {
  const md = "[x](#/w/./polling%20for%20WPN%20updatee)";
  const r = extractReferencedLinksFromMarkdown(md);
  assert.deepEqual(r.noteIds, []);
  assert.deepEqual(r.vfsHrefPaths, ["./polling%20for%20WPN%20updatee"]);
});

test("extractReferencedLinksFromMarkdown: ignores external URLs", () => {
  const md = "[ext](https://example.com) [rel](/home) [x](#/w/./ok)";
  const r = extractReferencedLinksFromMarkdown(md);
  assert.deepEqual(r.noteIds, []);
  assert.deepEqual(r.vfsHrefPaths, ["./ok"]);
});
