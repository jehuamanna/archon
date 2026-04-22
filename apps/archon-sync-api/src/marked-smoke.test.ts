import assert from "node:assert/strict";
import { test } from "node:test";
import { marked } from "marked";

test("marked produces HTML for markdown", () => {
  const html = marked.parse("# Hello", { async: false }) as string;
  assert.match(html, /Hello/);
});
