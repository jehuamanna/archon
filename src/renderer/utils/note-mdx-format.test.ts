import assert from "node:assert/strict";
import test from "node:test";
import type { Note } from "@archon/ui-types";
import { isMdxBundledTrust, shouldRenderMdx } from "./note-mdx-format.ts";

function n(partial: Partial<Note> & Pick<Note, "id" | "type" | "title" | "content">): Note {
  return {
    id: partial.id,
    type: partial.type,
    title: partial.title,
    content: partial.content,
    metadata: partial.metadata,
  };
}

test("shouldRenderMdx is true for mdx type", () => {
  assert.equal(
    shouldRenderMdx(n({ id: "1", type: "mdx", title: "x", content: "" })),
    true,
  );
});

test("shouldRenderMdx is true for contentFormat mdx metadata", () => {
  assert.equal(
    shouldRenderMdx(
      n({
        id: "1",
        type: "markdown",
        title: "x",
        content: "",
        metadata: { contentFormat: "mdx" },
      }),
    ),
    true,
  );
});

test("shouldRenderMdx is true for bundled doc with .mdx sourceFile", () => {
  assert.equal(
    shouldRenderMdx(
      n({
        id: "1",
        type: "markdown",
        title: "x",
        content: "",
        metadata: { bundledDoc: true, sourceFile: "guide.mdx" },
      }),
    ),
    true,
  );
});

test("shouldRenderMdx is false for bundled .md", () => {
  assert.equal(
    shouldRenderMdx(
      n({
        id: "1",
        type: "markdown",
        title: "x",
        content: "",
        metadata: { bundledDoc: true, sourceFile: "guide.md" },
      }),
    ),
    false,
  );
});

test("isMdxBundledTrust reads bundledDoc", () => {
  assert.equal(
    isMdxBundledTrust(
      n({
        id: "1",
        type: "mdx",
        title: "x",
        content: "",
        metadata: { bundledDoc: true },
      }),
    ),
    true,
  );
  assert.equal(
    isMdxBundledTrust(n({ id: "1", type: "mdx", title: "x", content: "" })),
    false,
  );
});
