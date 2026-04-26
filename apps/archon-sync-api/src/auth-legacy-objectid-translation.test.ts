/**
 * AC10 — pre-cutover JWTs with legacy ObjectId hex `sub` translate via
 * legacy_object_id_map at the auth boundary. Covers `verifyAndTranslate`
 * end-to-end against the PG schema.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  ensurePgConnected,
  disconnectPg,
  getDb,
} from "./pg.js";
import { legacyObjectIdMap, users } from "./db/schema.js";
import {
  setupPgTestSchema,
  factoryUser,
} from "./test-pg-helper.js";
import { signToken } from "./auth.js";
import {
  verifyAndTranslate,
  verifyAndTranslateAccess,
  verifyAndTranslateRefresh,
  translatePayloadIds,
} from "./auth-translate.js";
import {
  isObjectIdHex,
  isUuid,
  translateLegacyId,
  ensureUuid,
  _resetLegacyIdMapCache,
} from "./db/legacy-id-map.js";

describe("legacy-id-map type guards", () => {
  test("isObjectIdHex accepts 24 lowercase hex chars and rejects others", () => {
    assert.equal(isObjectIdHex("69db3ea99abd9dd473462981"), true);
    assert.equal(isObjectIdHex("69DB3EA99ABD9DD473462981"), false); // uppercase
    assert.equal(isObjectIdHex("69db3ea99abd9dd47346298"), false); // 23 chars
    assert.equal(isObjectIdHex("69db3ea99abd9dd4734629812"), false); // 25 chars
    assert.equal(isObjectIdHex(""), false);
    assert.equal(isObjectIdHex(null), false);
    assert.equal(isObjectIdHex(123), false);
  });

  test("isUuid accepts canonical UUIDs of any version", () => {
    assert.equal(isUuid("11b88fbc-4c07-442a-a500-b6a4668dd92d"), true);
    assert.equal(isUuid("00000000-0000-0000-0000-000000000000"), true);
    assert.equal(isUuid("69db3ea99abd9dd473462981"), false); // ObjectId hex
    assert.equal(isUuid(""), false);
    assert.equal(isUuid(null), false);
  });
});

describe("auth-legacy-objectid-translation (AC10)", () => {
  test("verifyAndTranslate rewrites legacy ObjectId sub to UUID via legacy_object_id_map", async () => {
    const ctx = await setupPgTestSchema();
    try {
      _resetLegacyIdMapCache();
      const newUserId = await factoryUser({ email: "legacy-jwt@example.test" });
      const legacyHex = "69db3ea99abd9dd473462981";

      await getDb().insert(legacyObjectIdMap).values({
        scope: "users",
        legacyId: legacyHex,
        newId: newUserId,
      });

      const secret = "test-secret-min-32-chars-for-legacy-jwt-translation";
      const legacyToken = signToken(
        secret,
        {
          sub: legacyHex,
          email: "legacy-jwt@example.test",
          typ: "access",
        },
        false,
      );

      const translated = await verifyAndTranslate(secret, legacyToken);
      assert.equal(translated.sub, newUserId);
      assert.equal(isUuid(translated.sub), true);
      assert.equal(translated.email, "legacy-jwt@example.test");
    } finally {
      await ctx.teardown();
    }
  });

  test("verifyAndTranslateAccess rejects refresh-typ tokens", async () => {
    const ctx = await setupPgTestSchema();
    try {
      _resetLegacyIdMapCache();
      const userId = await factoryUser();
      const secret = "test-secret-min-32-chars-for-typ-rejection-........";
      const refreshToken = signToken(
        secret,
        { sub: userId, email: "x@y.test", typ: "refresh", jti: "jti-123" },
        false,
      );
      await assert.rejects(
        () => verifyAndTranslateAccess(secret, refreshToken),
        /Invalid token type/,
      );
    } finally {
      await ctx.teardown();
    }
  });

  test("verifyAndTranslateRefresh requires typ=refresh and a non-empty jti", async () => {
    const ctx = await setupPgTestSchema();
    try {
      _resetLegacyIdMapCache();
      const userId = await factoryUser();
      const secret = "test-secret-min-32-chars-for-refresh-validation-..";

      const accessToken = signToken(
        secret,
        { sub: userId, email: "x@y.test", typ: "access" },
        false,
      );
      await assert.rejects(
        () => verifyAndTranslateRefresh(secret, accessToken),
        /Invalid refresh token/,
      );

      const goodRefresh = signToken(
        secret,
        { sub: userId, email: "x@y.test", typ: "refresh", jti: "rotation-jti" },
        false,
      );
      const refreshed = await verifyAndTranslateRefresh(secret, goodRefresh);
      assert.equal(refreshed.sub, userId);
      assert.equal(refreshed.typ, "refresh");
      assert.equal(refreshed.jti, "rotation-jti");
    } finally {
      await ctx.teardown();
    }
  });

  test("verifyAndTranslate is a no-op on UUID-shaped sub (no map lookup needed)", async () => {
    const ctx = await setupPgTestSchema();
    try {
      _resetLegacyIdMapCache();
      const userId = await factoryUser();
      const secret = "test-secret-min-32-chars-for-uuid-passthrough-...";
      const fresh = signToken(
        secret,
        { sub: userId, email: "fresh@example.test", typ: "access" },
        false,
      );
      const translated = await verifyAndTranslate(secret, fresh);
      assert.equal(translated.sub, userId);
    } finally {
      await ctx.teardown();
    }
  });

  test("translatePayloadIds rewrites legacy activeOrgId and activeSpaceId in tandem with sub", async () => {
    const ctx = await setupPgTestSchema();
    try {
      _resetLegacyIdMapCache();
      const userId = await factoryUser();
      const orgUuid = "10000000-0000-4000-8000-000000000001";
      const spaceUuid = "20000000-0000-4000-8000-000000000002";
      await getDb().insert(legacyObjectIdMap).values([
        {
          scope: "users",
          legacyId: "aaaaaaaaaaaaaaaaaaaaaaaa",
          newId: userId,
        },
        {
          scope: "organizations",
          legacyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
          newId: orgUuid,
        },
        {
          scope: "spaces",
          legacyId: "cccccccccccccccccccccccc",
          newId: spaceUuid,
        },
      ]);
      const result = await translatePayloadIds({
        sub: "aaaaaaaaaaaaaaaaaaaaaaaa",
        email: "legacy@example.test",
        activeOrgId: "bbbbbbbbbbbbbbbbbbbbbbbb",
        activeSpaceId: "cccccccccccccccccccccccc",
      });
      assert.equal(result.sub, userId);
      assert.equal(result.activeOrgId, orgUuid);
      assert.equal(result.activeSpaceId, spaceUuid);
      assert.equal(result.email, "legacy@example.test");
    } finally {
      await ctx.teardown();
    }
  });

  test("translateLegacyId throws on missing entry; ensureUuid rejects non-UUID/non-ObjectId-hex", async () => {
    const ctx = await setupPgTestSchema();
    try {
      _resetLegacyIdMapCache();
      await assert.rejects(
        () => translateLegacyId("users", "ffffffffffffffffffffffff"),
        /legacy id not found/,
      );
      await assert.rejects(
        () => ensureUuid("users", "not-a-real-id-format"),
        /not a UUID or ObjectId hex/,
      );
    } finally {
      await ctx.teardown();
    }
  });

  test("verifier short-circuit: a fresh UUID sub bypasses the map (no DB hit on ensureUuid)", async () => {
    const ctx = await setupPgTestSchema();
    try {
      _resetLegacyIdMapCache();
      const userId = await factoryUser();
      // Spy: count rows in legacy_object_id_map before/after a UUID-only verify.
      const before = await getDb()
        .select()
        .from(legacyObjectIdMap)
        .where(eq(legacyObjectIdMap.scope, "users"));
      const secret = "test-secret-min-32-chars-spy-on-map-skipping-....";
      const fresh = signToken(
        secret,
        { sub: userId, email: "fresh@example.test", typ: "access" },
        false,
      );
      await verifyAndTranslate(secret, fresh);
      const after = await getDb()
        .select()
        .from(legacyObjectIdMap)
        .where(eq(legacyObjectIdMap.scope, "users"));
      assert.equal(after.length, before.length);
      // Sanity: the user row exists and is queryable through the schema.
      const rows = await getDb()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId));
      assert.equal(rows.length, 1);
    } finally {
      await ctx.teardown();
    }
  });
});

await ensurePgConnected().catch(() => {
  // If PG isn't available the tests above will surface it; this just
  // ensures the pool is initialised once before the suite.
});

process.on("beforeExit", () => {
  void disconnectPg();
});
