import assert from "node:assert/strict";
import test from "node:test";
import { markdownVfsNoteHref } from "./note-vfs-path.ts";
import { normalizeVfsSegment } from "./note-vfs-path.ts";
import {
  rewriteMarkdownForWpnNoteTitleChange,
  rewriteVfsCanonicalLinksInMarkdown,
  vfsCanonicalPathsForTitleChange,
} from "./note-vfs-link-rewrite.ts";

test("vfsCanonicalPathsForTitleChange returns null when path unchanged", () => {
  assert.equal(
    vfsCanonicalPathsForTitleChange(
      { workspace_name: "W", project_name: "P" },
      "Same",
      "Same",
    ),
    null,
  );
});

test("vfsCanonicalPathsForTitleChange detects title segment change", () => {
  /** Titles must avoid looking like a lone heading slug in `parseVfsNoteHashPath` (last segment). */
  const r = vfsCanonicalPathsForTitleChange(
    { workspace_name: "W", project_name: "P" },
    "Old.note",
    "New.note",
  );
  assert.ok(r);
  assert.equal(r.oldCanonical, "W/P/Old.note");
  assert.equal(r.newCanonical, "W/P/New.note");
});

test("rewriteVfsCanonicalLinksInMarkdown updates markdown link href", () => {
  const oldC = "W/P/Old.note";
  const newC = "W/P/New.note";
  const href = markdownVfsNoteHref(oldC);
  const md = `Link [here](${href}) please.`;
  const out = rewriteVfsCanonicalLinksInMarkdown(md, oldC, newC);
  assert.ok(!out.includes(href));
  assert.ok(out.includes(markdownVfsNoteHref(newC)));
});

test("rewriteVfsCanonicalLinksInMarkdown preserves heading slug", () => {
  const oldC = "W/P/Old.note";
  const newC = "W/P/New.note";
  const href = markdownVfsNoteHref(oldC, "my-h2");
  const md = `[t](${href})`;
  const out = rewriteVfsCanonicalLinksInMarkdown(md, oldC, newC);
  assert.equal(out, `[t](${markdownVfsNoteHref(newC, "my-h2")})`);
});

test("rewriteVfsCanonicalLinksInMarkdown leaves fenced code alone", () => {
  const oldC = "W/P/Old.note";
  const newC = "W/P/New.note";
  const href = markdownVfsNoteHref(oldC);
  const md = "```md\n" + `[x](${href})` + "\n```\n\n" + `[y](${href})`;
  const out = rewriteVfsCanonicalLinksInMarkdown(md, oldC, newC);
  assert.ok(out.includes(`[x](${href})`));
  assert.ok(out.includes(`[y](${markdownVfsNoteHref(newC)})`));
});

test("rewriteVfsCanonicalLinksInMarkdown updates DocLink to= string", () => {
  const oldC = "W/P/Old.note";
  const newC = "W/P/New.note";
  const md = `<DocLink to="w/W/P/Old.note">X</DocLink>`;
  const out = rewriteVfsCanonicalLinksInMarkdown(md, oldC, newC);
  assert.ok(out.includes(`to="${markdownVfsNoteHref(newC)}"`));
});

test("rewriteVfsCanonicalLinksInMarkdown does not change note-id links", () => {
  const md = `[n](#/n/abc-123-def)`;
  const out = rewriteVfsCanonicalLinksInMarkdown(md, "W/P/Old.note", "W/P/New.note");
  assert.equal(out, md);
});

test("rewriteMarkdownForWpnNoteTitleChange updates same-project ./Title links", () => {
  const oldC = "W/P/Old.note";
  const newC = "W/P/New.note";
  const href = markdownVfsNoteHref("./Old.note");
  const md = `[x](${href})`;
  const out = rewriteMarkdownForWpnNoteTitleChange(
    md,
    "proj1",
    "proj1",
    oldC,
    newC,
    normalizeVfsSegment("Old.note", "Untitled"),
    normalizeVfsSegment("New.note", "Untitled"),
  );
  assert.ok(out.includes(markdownVfsNoteHref("./New.note")));
});

test("rewriteMarkdownForWpnNoteTitleChange skips ./ links in other projects", () => {
  const oldC = "W/P/Old.note";
  const newC = "W/P/New.note";
  const href = markdownVfsNoteHref("./Old.note");
  const md = `[x](${href})`;
  const out = rewriteMarkdownForWpnNoteTitleChange(
    md,
    "other",
    "proj1",
    oldC,
    newC,
    normalizeVfsSegment("Old.note", "Untitled"),
    normalizeVfsSegment("New.note", "Untitled"),
  );
  assert.equal(out, md);
});
