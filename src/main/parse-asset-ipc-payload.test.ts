import assert from "node:assert/strict";
import test from "node:test";
import { parseAssetIpcPayload } from "./parse-asset-ipc-payload.ts";

test("string payload returns rel only", () => {
  assert.deepEqual(parseAssetIpcPayload("a/b"), { rel: "a/b" });
});

test("object with relativePath", () => {
  assert.deepEqual(parseAssetIpcPayload({ relativePath: "x", projectRoot: "/p" }), {
    rel: "x",
    projectRoot: "/p",
  });
});

test("object with rel alias", () => {
  assert.deepEqual(parseAssetIpcPayload({ rel: "y" }), {
    rel: "y",
    projectRoot: undefined,
  });
});

test("invalid yields empty rel", () => {
  assert.deepEqual(parseAssetIpcPayload(null), { rel: "" });
  assert.deepEqual(parseAssetIpcPayload(1), { rel: "" });
});
