import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rewriteThreeSegmentVfsLinks } from "./rewrite-vfs-3-to-2-segment.js";

describe("rewriteThreeSegmentVfsLinks", () => {
  it("rewrites a 3-segment canonical link", () => {
    const r = rewriteThreeSegmentVfsLinks(
      "See [the spec](#/w/Engineering/Backend/API%20Spec).",
    );
    assert.equal(r.rewrites, 1);
    assert.match(r.content, /\[the spec\]\(#\/w\/Backend\/API%20Spec\)/);
  });

  it("rewrites a 4-segment link with heading slug, keeping the slug", () => {
    const r = rewriteThreeSegmentVfsLinks(
      "[heading](#/w/Engineering/Backend/API%20Spec/section-one)",
    );
    assert.equal(r.rewrites, 1);
    assert.match(
      r.content,
      /\[heading\]\(#\/w\/Backend\/API%20Spec\/section-one\)/,
    );
  });

  it("leaves 2-segment links unchanged (already post-migration)", () => {
    const before = "[link](#/w/Backend/API%20Spec)";
    const r = rewriteThreeSegmentVfsLinks(before);
    assert.equal(r.rewrites, 0);
    assert.equal(r.content, before);
  });

  it("leaves 3-segment links with a trailing heading slug unchanged", () => {
    // Post-migration shape: Project/Title/heading-slug.
    const before = "[h](#/w/Backend/API%20Spec/section-one)";
    const r = rewriteThreeSegmentVfsLinks(before);
    assert.equal(r.rewrites, 0);
    assert.equal(r.content, before);
  });

  it("leaves same-project-relative links alone", () => {
    const before = "[same](#/w/./Sibling)";
    const r = rewriteThreeSegmentVfsLinks(before);
    assert.equal(r.rewrites, 0);
    assert.equal(r.content, before);
  });

  it("leaves tree-relative links alone", () => {
    const before = "[up](#/w/../Sibling)";
    const r = rewriteThreeSegmentVfsLinks(before);
    assert.equal(r.rewrites, 0);
    assert.equal(r.content, before);
  });

  it("rewrites multiple links in one note", () => {
    // "Title-A" and "Title-B" both have a capital T — they don't match the
    // lowercase-slug discriminator and are unambiguously titles, not heading
    // slugs. The trailing "sec" of the second link IS a slug — it's
    // preserved as a heading suffix.
    const before =
      "[a](#/w/WS/Proj/Title-A) and [b](#/w/Other/Proj2/Title-B/sec)";
    const r = rewriteThreeSegmentVfsLinks(before);
    assert.equal(r.rewrites, 2);
    assert.match(r.content, /\[a\]\(#\/w\/Proj\/Title-A\)/);
    assert.match(r.content, /\[b\]\(#\/w\/Proj2\/Title-B\/sec\)/);
  });

  it("preserves the link label, image flag, and title attribute", () => {
    // "Image-Title" has a capital, disambiguating it from a heading slug.
    const before =
      '![alt](#/w/WS/Proj/Image-Title "tooltip")';
    const r = rewriteThreeSegmentVfsLinks(before);
    assert.equal(r.rewrites, 1);
    assert.match(
      r.content,
      /^!\[alt\]\(#\/w\/Proj\/Image-Title "tooltip"\)$/,
    );
  });

  it("does NOT rewrite when the third segment looks like a heading slug (ambiguity with post-migration shape)", () => {
    // The runtime parser treats `#/w/A/B/c` as Project=A, Title=B,
    // heading=c when c matches the slug pattern. Pre-migration content
    // that happened to use a lowercase title (e.g. "home") is
    // indistinguishable post-migration; we leave it alone rather than
    // risk a wrong rewrite. Operators with such content disambiguate by
    // hand or rename the title to break the slug pattern.
    const before = "[h](#/w/WS/Proj/home)";
    const r = rewriteThreeSegmentVfsLinks(before);
    assert.equal(r.rewrites, 0);
    assert.equal(r.content, before);
  });

  it("does not touch fenced code blocks (preserves doc samples of old links)", () => {
    const before =
      "Inline [yes](#/w/WS/Proj/MyTitle) but not\n```md\n[doc](#/w/WS/Proj/MyTitle)\n```\n";
    const r = rewriteThreeSegmentVfsLinks(before);
    assert.equal(r.rewrites, 1);
    assert.match(r.content, /\[yes\]\(#\/w\/Proj\/MyTitle\)/);
    // The fenced-block link is intact.
    assert.match(r.content, /```md\n\[doc\]\(#\/w\/WS\/Proj\/MyTitle\)\n```/);
  });

  it("recognises bare /w/ and /#/w/ prefixes", () => {
    const r = rewriteThreeSegmentVfsLinks(
      "[a](/w/WS/Proj/Spec-Doc) [b](/#/w/WS/Proj/Spec-Doc)",
    );
    assert.equal(r.rewrites, 2);
    assert.match(r.content, /\[a\]\(\/w\/Proj\/Spec-Doc\)/);
    assert.match(r.content, /\[b\]\(\/#\/w\/Proj\/Spec-Doc\)/);
  });

  it("leaves note-id links untouched", () => {
    const before = "[id](#/n/00000000-0000-4000-8000-00000000abcd)";
    const r = rewriteThreeSegmentVfsLinks(before);
    assert.equal(r.rewrites, 0);
    assert.equal(r.content, before);
  });
});
