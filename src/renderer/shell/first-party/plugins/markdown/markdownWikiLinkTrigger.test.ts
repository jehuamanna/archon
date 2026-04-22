import assert from "node:assert/strict";
import test from "node:test";
import { findActiveWikiLinkTrigger } from "./markdownWikiLinkTrigger.ts";

test("findActiveWikiLinkTrigger returns filter after [[", () => {
  const v = "hello [[foo";
  const t = findActiveWikiLinkTrigger(v, v.length);
  assert.deepEqual(t, { start: 6, filter: "foo" });
});

test("findActiveWikiLinkTrigger null when ] appears before cursor", () => {
  const v = "[[x]]";
  const t = findActiveWikiLinkTrigger(v, v.length);
  assert.equal(t, null);
});

test("findActiveWikiLinkTrigger uses last [[ before cursor", () => {
  const v = "[[a [[b";
  const t = findActiveWikiLinkTrigger(v, v.length);
  assert.deepEqual(t, { start: 4, filter: "b" });
});
