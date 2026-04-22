import assert from "node:assert/strict";
import test from "node:test";
import { observableEmbedSrc } from "./observable-embed-url.ts";

test("observableEmbedSrc builds Observable embed URL", () => {
  assert.equal(
    observableEmbedSrc("@observablehq/hello-world"),
    "https://observablehq.com/embed/@observablehq/hello-world",
  );
  assert.equal(
    observableEmbedSrc("observablehq/hello-world"),
    "https://observablehq.com/embed/@observablehq/hello-world",
  );
  assert.equal(
    observableEmbedSrc("@user/my-note", "chart"),
    "https://observablehq.com/embed/@user/my-note?cell=chart",
  );
});

test("observableEmbedSrc rejects invalid notebook paths", () => {
  assert.equal(observableEmbedSrc("../../../etc/passwd"), null);
  assert.equal(observableEmbedSrc("https://evil.test/x"), null);
  assert.equal(observableEmbedSrc("user"), null);
});

test("observableEmbedSrc rejects invalid cell names", () => {
  assert.equal(observableEmbedSrc("@user/note", "a;b"), null);
});
