import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMAGE_MIME_ALLOWLIST,
  buildImageAssetKey,
  isAllowedImageMime,
  parseImageAssetKey,
} from "./image-asset-path.js";

const VALID_PARTS = {
  orgId: "org_abc-123",
  spaceId: "space_def-456",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  noteId: "33333333-3333-4333-8333-333333333333",
};

test("buildImageAssetKey returns the documented 5-segment shape (no extension)", () => {
  const key = buildImageAssetKey(VALID_PARTS);
  assert.strictEqual(
    key,
    "org_abc-123/space_def-456/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333",
  );
  assert.strictEqual(key.split("/").length, 5);
});

test("buildImageAssetKey rejects path traversal in orgId / spaceId", () => {
  assert.throws(() => buildImageAssetKey({ ...VALID_PARTS, orgId: "../evil" }));
  assert.throws(() => buildImageAssetKey({ ...VALID_PARTS, spaceId: "a/b" }));
  assert.throws(() => buildImageAssetKey({ ...VALID_PARTS, orgId: "" }));
});

test("buildImageAssetKey rejects non-UUID workspace/project/note ids", () => {
  assert.throws(() =>
    buildImageAssetKey({ ...VALID_PARTS, workspaceId: "not-a-uuid" }),
  );
  assert.throws(() =>
    buildImageAssetKey({ ...VALID_PARTS, projectId: "11111111" }),
  );
  assert.throws(() =>
    buildImageAssetKey({ ...VALID_PARTS, noteId: "33333333-3333-4333-8333" }),
  );
});

test("parseImageAssetKey round-trips a built key", () => {
  const key = buildImageAssetKey(VALID_PARTS);
  assert.deepStrictEqual(parseImageAssetKey(key), {
    ...VALID_PARTS,
    variant: "original",
  });
});

test("parseImageAssetKey rejects malformed keys", () => {
  assert.strictEqual(parseImageAssetKey(""), null);
  assert.strictEqual(parseImageAssetKey("a/b/c/d"), null);
  assert.strictEqual(
    parseImageAssetKey("org/space/ws/proj/note/extra"),
    null,
  );
  assert.strictEqual(
    parseImageAssetKey("org/space/not-uuid/proj/note"),
    null,
  );
});

test("buildImageAssetKey with variant=thumb appends the /thumb segment", () => {
  const key = buildImageAssetKey({ ...VALID_PARTS, variant: "thumb" });
  assert.strictEqual(
    key,
    "org_abc-123/space_def-456/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/thumb",
  );
  assert.strictEqual(key.split("/").length, 6);
});

test("parseImageAssetKey round-trips a thumb key and distinguishes from an original", () => {
  const thumb = buildImageAssetKey({ ...VALID_PARTS, variant: "thumb" });
  const original = buildImageAssetKey({ ...VALID_PARTS, variant: "original" });
  assert.deepStrictEqual(parseImageAssetKey(thumb), {
    ...VALID_PARTS,
    variant: "thumb",
  });
  assert.deepStrictEqual(parseImageAssetKey(original), {
    ...VALID_PARTS,
    variant: "original",
  });
});

test("parseImageAssetKey rejects a 6-segment key whose final segment is not 'thumb'", () => {
  const base = buildImageAssetKey({ ...VALID_PARTS, variant: "original" });
  assert.strictEqual(parseImageAssetKey(`${base}/other`), null);
});

test("isAllowedImageMime allows the v1 mime list and rejects SVG", () => {
  for (const m of IMAGE_MIME_ALLOWLIST) {
    assert.ok(isAllowedImageMime(m), `${m} should be allowed`);
  }
  assert.strictEqual(isAllowedImageMime("image/svg+xml"), false);
  assert.strictEqual(isAllowedImageMime("image/png; charset=binary"), false);
  assert.strictEqual(isAllowedImageMime("application/octet-stream"), false);
  assert.strictEqual(isAllowedImageMime("text/plain"), false);
});
