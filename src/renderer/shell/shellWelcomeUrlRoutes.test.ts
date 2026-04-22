import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdownWelcomeShellHref, tryParseWelcomeShellHash } from "./shellWelcomeUrlRoutes.ts";

test("parseMarkdownWelcomeShellHref reads fragment only", () => {
  assert.deepEqual(parseMarkdownWelcomeShellHref("#/welcome/scratch-markdown"), {
    kind: "welcome",
    segment: "scratch-markdown",
  });
  assert.deepEqual(parseMarkdownWelcomeShellHref("https://x.test/app#/welcome/documentation"), {
    kind: "welcome",
    segment: "documentation",
  });
  assert.equal(parseMarkdownWelcomeShellHref("/no-hash/welcome"), undefined);
});

test("tryParseWelcomeShellHash base and segments", () => {
  assert.deepEqual(tryParseWelcomeShellHash("welcome"), { kind: "welcome", segment: "" });
  assert.deepEqual(tryParseWelcomeShellHash("/welcome"), { kind: "welcome", segment: "" });
  assert.deepEqual(tryParseWelcomeShellHash("/welcome/"), { kind: "welcome", segment: "" });
  assert.deepEqual(tryParseWelcomeShellHash("/welcome/documentation"), {
    kind: "welcome",
    segment: "documentation",
  });
  assert.deepEqual(tryParseWelcomeShellHash("/welcome/js-notebook"), {
    kind: "welcome",
    segment: "js-notebook",
  });
  assert.deepEqual(tryParseWelcomeShellHash("welcome/documentation"), {
    kind: "welcome",
    segment: "documentation",
  });
  assert.equal(tryParseWelcomeShellHash("/welcome/unknown-segment"), null);
  assert.equal(tryParseWelcomeShellHash("t/foo"), undefined);
});
