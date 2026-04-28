import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  CHUNK_SIZE_BYTES,
  INLINE_THRESHOLD_BYTES,
  KEY_MAX_BYTES,
  MAX_KEYS_PER_PROJECT,
  serializedSize,
} from "./schema.js";

describe("mdx-state schema constants", () => {
  test("inline threshold is 4MB", () => {
    assert.equal(INLINE_THRESHOLD_BYTES, 4 * 1024 * 1024);
  });

  test("chunk size is 8MB and under the 16MB hard cap", () => {
    assert.equal(CHUNK_SIZE_BYTES, 8 * 1024 * 1024);
    assert.ok(CHUNK_SIZE_BYTES < 16 * 1024 * 1024);
  });

  test("per-key soft cap is 256MB", () => {
    assert.equal(KEY_MAX_BYTES, 256 * 1024 * 1024);
  });

  test("per-project key limit", () => {
    assert.equal(MAX_KEYS_PER_PROJECT, 1000);
  });
});

describe("serializedSize", () => {
  test("returns 4 for a boolean", () => {
    // JSON.stringify(true) === "true", 4 UTF-8 bytes.
    assert.equal(serializedSize(true), 4);
  });

  test("returns null for undefined", () => {
    // JSON.stringify(undefined) is undefined; our helper normalizes to "null".
    assert.equal(serializedSize(undefined), 4);
  });

  test("handles unicode", () => {
    const val = "α"; // 2 UTF-8 bytes
    // JSON encodes as `"α"` → 1 + 2 + 1 = 4 bytes.
    assert.equal(serializedSize(val), 4);
  });

  test("handles arrays", () => {
    assert.equal(serializedSize([1, 2, 3]), JSON.stringify([1, 2, 3]).length);
  });
});
