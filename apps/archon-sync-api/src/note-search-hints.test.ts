import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildNoteSearchHints } from "./note-search-hints.js";

describe("buildNoteSearchHints", () => {
  it("returns undefined for non-image notes even when altText-like fields exist", () => {
    const got = buildNoteSearchHints({
      type: "markdown",
      metadata: { altText: "ignored", caption: "ignored too" },
    });
    assert.equal(got, undefined);
  });

  it("returns undefined when an image note carries no altText or caption", () => {
    const got = buildNoteSearchHints({
      type: "image",
      metadata: { r2Key: "x", mimeType: "image/png", sizeBytes: 10 },
    });
    assert.equal(got, undefined);
  });

  it("returns undefined for a null / missing metadata blob", () => {
    assert.equal(
      buildNoteSearchHints({ type: "image", metadata: null }),
      undefined,
    );
    assert.equal(
      buildNoteSearchHints({ type: "image", metadata: undefined }),
      undefined,
    );
  });

  it("emits altText only when only altText is set", () => {
    const got = buildNoteSearchHints({
      type: "image",
      metadata: { altText: "Sunset over the lake" },
    });
    assert.deepEqual(got, { altText: "Sunset over the lake" });
  });

  it("emits caption only when only caption is set", () => {
    const got = buildNoteSearchHints({
      type: "image",
      metadata: { caption: "Annotated diagram" },
    });
    assert.deepEqual(got, { caption: "Annotated diagram" });
  });

  it("emits both when both are set", () => {
    const got = buildNoteSearchHints({
      type: "image",
      metadata: { altText: "alt", caption: "cap" },
    });
    assert.deepEqual(got, { altText: "alt", caption: "cap" });
  });

  it("trims whitespace and drops empty-after-trim strings", () => {
    const got = buildNoteSearchHints({
      type: "image",
      metadata: { altText: "  real  ", caption: "   " },
    });
    assert.deepEqual(got, { altText: "real" });
  });

  it("ignores non-string fields (number, null, nested)", () => {
    const got = buildNoteSearchHints({
      type: "image",
      metadata: { altText: 42 as unknown as string, caption: null as unknown as string },
    });
    assert.equal(got, undefined);
  });

  it("caps very long hints at 512 chars so list payloads stay small", () => {
    const long = "x".repeat(2000);
    const got = buildNoteSearchHints({
      type: "image",
      metadata: { altText: long },
    });
    assert.ok(got?.altText);
    assert.equal(got.altText.length, 512);
  });
});
