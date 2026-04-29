/**
 * Parity coverage for `note-vfs-mirror.ts` — the sync-api-local
 * duplicate of the renderer's shared `note-vfs-path.ts` +
 * `note-vfs-link-rewrite.ts`. The duplicate exists so the sync-api can
 * compute VFS rewrites without a cross-workspace dependency on the
 * root `src/shared/` path; this test pins behavior so the two stay in
 * lockstep through subsequent edits. Pure: no DB.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalVfsPathFromLinkRow,
  isSameProjectRelativeVfsPath,
  isTreeRelativeVfsPath,
  markdownVfsNoteHref,
  normalizeVfsSegment,
  parseInternalMarkdownNoteLink,
  parseVfsNoteHashPath,
  rewriteMarkdownForWpnNoteTitleChange,
  rewriteRelativeSameProjectTitleLinksInMarkdown,
  rewriteVfsCanonicalLinksInMarkdown,
  vfsCanonicalPathsForTitleChange,
} from "./note-vfs-mirror.js";

describe("note-vfs-mirror canonical path helpers", () => {
  it("normalizeVfsSegment replaces `/` with U+2215 and falls back when blank", () => {
    assert.equal(normalizeVfsSegment("Sign/up", "x"), "Sign∕up");
    assert.equal(normalizeVfsSegment("   ", "fallback"), "fallback");
    assert.equal(normalizeVfsSegment("Plain", "fallback"), "Plain");
  });

  it("canonicalVfsPathFromLinkRow builds 2-segment Project/Title (post-flatten)", () => {
    assert.equal(
      canonicalVfsPathFromLinkRow({ projectName: "Backend", title: "Spec" }),
      "Backend/Spec",
    );
  });

  it("markdownVfsNoteHref encodes segments and optionally appends a heading slug", () => {
    assert.equal(
      markdownVfsNoteHref("Backend/Spec"),
      "#/w/Backend/Spec",
    );
    assert.equal(
      markdownVfsNoteHref("Backend/Spec", "section-one"),
      "#/w/Backend/Spec/section-one",
    );
    // Slug must match `/^[a-z0-9-]+$/i`; non-conforming slugs are dropped.
    assert.equal(
      markdownVfsNoteHref("Backend/Spec", "Bad Slug"),
      "#/w/Backend/Spec",
    );
    // URL-encodes spaces in segments.
    assert.equal(
      markdownVfsNoteHref("Backend/API Spec"),
      "#/w/Backend/API%20Spec",
    );
  });

  it("isSameProjectRelativeVfsPath / isTreeRelativeVfsPath classify prefixes", () => {
    assert.equal(isSameProjectRelativeVfsPath("./Sibling"), true);
    assert.equal(isSameProjectRelativeVfsPath("."), true);
    assert.equal(isSameProjectRelativeVfsPath("../Sibling"), false);
    assert.equal(isSameProjectRelativeVfsPath("Project/Title"), false);
    assert.equal(isTreeRelativeVfsPath("../Sibling"), true);
    assert.equal(isTreeRelativeVfsPath(".."), true);
    assert.equal(isTreeRelativeVfsPath("./X"), false);
  });
});

describe("parseVfsNoteHashPath (post-migration 2-segment shapes)", () => {
  it("absolute Project/Title", () => {
    const p = parseVfsNoteHashPath("Backend/Spec");
    assert.deepEqual(p, { vfsPath: "Backend/Spec" });
  });

  it("absolute Project/Title/heading-slug — heading split off", () => {
    const p = parseVfsNoteHashPath("Backend/Spec/section-one");
    assert.deepEqual(p, {
      vfsPath: "Backend/Spec",
      markdownHeadingSlug: "section-one",
    });
  });

  it("same-project-relative ./Title", () => {
    const p = parseVfsNoteHashPath("./Sibling");
    assert.deepEqual(p, { vfsPath: "./Sibling" });
  });

  it("same-project-relative ./Title/heading-slug", () => {
    const p = parseVfsNoteHashPath("./Sibling/intro");
    assert.deepEqual(p, {
      vfsPath: "./Sibling",
      markdownHeadingSlug: "intro",
    });
  });

  it("tree-relative ../sibling", () => {
    const p = parseVfsNoteHashPath("../Uncle");
    assert.deepEqual(p, { vfsPath: "../Uncle" });
  });

  it("decodes URI-encoded segments", () => {
    const p = parseVfsNoteHashPath("Backend/API%20Spec");
    assert.deepEqual(p, { vfsPath: "Backend/API Spec" });
  });
});

describe("parseInternalMarkdownNoteLink", () => {
  it("recognises #/n/<id>", () => {
    const r = parseInternalMarkdownNoteLink(
      "#/n/00000000-0000-4000-8000-000000000abc",
    );
    assert.deepEqual(r, {
      kind: "noteId",
      noteId: "00000000-0000-4000-8000-000000000abc",
    });
  });

  it("recognises #/n/<id>/heading-slug", () => {
    const r = parseInternalMarkdownNoteLink("#/n/abc/intro");
    assert.deepEqual(r, {
      kind: "noteId",
      noteId: "abc",
      markdownHeadingSlug: "intro",
    });
  });

  it("recognises #/w/<vfsPath>", () => {
    const r = parseInternalMarkdownNoteLink("#/w/Backend/Spec");
    // The mirror's parser returns `markdownHeadingSlug: undefined`
    // (rather than omitting the key) — pin both shapes here.
    assert.deepEqual(r, {
      kind: "vfs",
      vfsPath: "Backend/Spec",
      markdownHeadingSlug: undefined,
    });
  });

  it("returns null for non-internal hrefs", () => {
    assert.equal(parseInternalMarkdownNoteLink("https://example.com"), null);
    assert.equal(parseInternalMarkdownNoteLink(""), null);
    assert.equal(parseInternalMarkdownNoteLink("#some-anchor"), null);
  });
});

describe("vfsCanonicalPathsForTitleChange", () => {
  it("returns null when the title doesn't change", () => {
    const r = vfsCanonicalPathsForTitleChange(
      { project_name: "Backend" },
      "Same",
      "Same",
    );
    assert.equal(r, null);
  });

  it("returns old/new canonical paths when the title changes", () => {
    const r = vfsCanonicalPathsForTitleChange(
      { project_name: "Backend" },
      "Old",
      "New",
    );
    assert.deepEqual(r, {
      oldCanonical: "Backend/Old",
      newCanonical: "Backend/New",
    });
  });
});

describe("rewriteVfsCanonicalLinksInMarkdown", () => {
  it("rewrites a single canonical href", () => {
    const out = rewriteVfsCanonicalLinksInMarkdown(
      "[link](#/w/Backend/Old)",
      "Backend/Old",
      "Backend/New",
    );
    assert.equal(out, "[link](#/w/Backend/New)");
  });

  it("preserves heading slug across rewrites", () => {
    const out = rewriteVfsCanonicalLinksInMarkdown(
      "[h](#/w/Backend/Old/section-one)",
      "Backend/Old",
      "Backend/New",
    );
    assert.equal(out, "[h](#/w/Backend/New/section-one)");
  });

  it("leaves unrelated links alone", () => {
    const before = "[link](#/w/Frontend/Other)";
    const out = rewriteVfsCanonicalLinksInMarkdown(
      before,
      "Backend/Old",
      "Backend/New",
    );
    assert.equal(out, before);
  });

  it("does not touch fenced code blocks", () => {
    const before =
      "[a](#/w/Backend/Old) and\n```md\n[b](#/w/Backend/Old)\n```\n";
    const out = rewriteVfsCanonicalLinksInMarkdown(
      before,
      "Backend/Old",
      "Backend/New",
    );
    assert.match(out, /\[a\]\(#\/w\/Backend\/New\)/);
    // Fenced block link stays at "Old".
    assert.match(out, /```md\n\[b\]\(#\/w\/Backend\/Old\)\n```/);
  });
});

describe("rewriteRelativeSameProjectTitleLinksInMarkdown", () => {
  it("rewrites ./Old → ./New (same project)", () => {
    const out = rewriteRelativeSameProjectTitleLinksInMarkdown(
      "[s](#/w/./Old)",
      "Old",
      "New",
    );
    assert.equal(out, "[s](#/w/./New)");
  });

  it("preserves heading slug on relative rewrites", () => {
    const out = rewriteRelativeSameProjectTitleLinksInMarkdown(
      "[s](#/w/./Old/section)",
      "Old",
      "New",
    );
    assert.equal(out, "[s](#/w/./New/section)");
  });

  it("ignores ./<other-title> (not the renamed one)", () => {
    const before = "[s](#/w/./Other)";
    const out = rewriteRelativeSameProjectTitleLinksInMarkdown(
      before,
      "Old",
      "New",
    );
    assert.equal(out, before);
  });
});

describe("rewriteMarkdownForWpnNoteTitleChange (end-to-end title rename)", () => {
  it("rewrites canonical + same-project relative links when the project matches", () => {
    const before =
      "Cross: [c](#/w/Backend/Old)\nSame: [s](#/w/./Old)\nFenced:\n```md\n[doc](#/w/Backend/Old)\n```";
    const out = rewriteMarkdownForWpnNoteTitleChange(
      before,
      "p1", // rowProjectId
      "p1", // renamedProjectId — same project, both rewrites apply
      "Backend/Old",
      "Backend/New",
      "Old",
      "New",
    );
    assert.match(out, /\[c\]\(#\/w\/Backend\/New\)/);
    assert.match(out, /\[s\]\(#\/w\/\.\/New\)/);
    assert.match(out, /```md\n\[doc\]\(#\/w\/Backend\/Old\)\n```/);
  });

  it("rewrites canonical only when the link's project differs from the renamed project", () => {
    const before = "Cross: [c](#/w/Backend/Old)\nSame: [s](#/w/./Old)";
    const out = rewriteMarkdownForWpnNoteTitleChange(
      before,
      "p1", // rowProjectId — different project
      "p2", // renamedProjectId — only canonical rewrites should fire
      "Backend/Old",
      "Backend/New",
      "Old",
      "New",
    );
    assert.match(out, /\[c\]\(#\/w\/Backend\/New\)/);
    // Same-project relative link stays at ./Old because rowProjectId !== renamedProjectId.
    assert.match(out, /\[s\]\(#\/w\/\.\/Old\)/);
  });
});
