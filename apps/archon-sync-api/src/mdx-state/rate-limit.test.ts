import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  __resetBucketsForTests,
  consumeWriteToken,
} from "./rate-limit.js";
import { WRITE_RATE_BURST } from "./schema.js";

describe("mdx-state rate limit", () => {
  test("allows up to the burst", () => {
    __resetBucketsForTests();
    for (let i = 0; i < WRITE_RATE_BURST; i++) {
      assert.equal(consumeWriteToken("p1", "u1"), true, `burst slot ${i}`);
    }
    assert.equal(
      consumeWriteToken("p1", "u1"),
      false,
      "the (burst+1)th call is rejected",
    );
  });

  test("buckets are independent per (project, user)", () => {
    __resetBucketsForTests();
    for (let i = 0; i < WRITE_RATE_BURST; i++) {
      consumeWriteToken("p1", "u1");
    }
    assert.equal(consumeWriteToken("p1", "u1"), false);
    assert.equal(consumeWriteToken("p1", "u2"), true);
    assert.equal(consumeWriteToken("p2", "u1"), true);
  });

  test("bucket refills over time", async () => {
    __resetBucketsForTests();
    for (let i = 0; i < WRITE_RATE_BURST; i++) consumeWriteToken("p1", "u1");
    assert.equal(consumeWriteToken("p1", "u1"), false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    // ~2 tokens should have refilled at 20/sec.
    assert.equal(consumeWriteToken("p1", "u1"), true);
  });
});
