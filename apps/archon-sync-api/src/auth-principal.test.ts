/**
 * Round-trip test for `JwtPayload.principal` — sign a token carrying a
 * `principal` block and ensure verifyToken preserves shape + values.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { signToken, verifyToken, type JwtPayload } from "./auth.js";

describe("JwtPayload.principal", () => {
  const secret = "test-secret-principal-roundtrip";

  test("user-principal round-trips through sign + verify", () => {
    const payload: JwtPayload = {
      sub: "11111111-1111-1111-1111-111111111111",
      email: "alice@example.test",
      typ: "access",
      principal: { type: "user" },
    };
    const token = signToken(secret, payload);
    const back = verifyToken(secret, token);
    assert.equal(back.sub, payload.sub);
    assert.equal(back.email, payload.email);
    assert.deepEqual(back.principal, { type: "user" });
  });

  test("mcp-principal with metadata round-trips", () => {
    const payload: JwtPayload = {
      sub: "22222222-2222-2222-2222-222222222222",
      email: "mcp@example.test",
      typ: "access",
      mcp: true,
      principal: {
        type: "mcp",
        metadata: { deviceId: "dev-1", clientName: "claude-code" },
      },
    };
    const token = signToken(secret, payload);
    const back = verifyToken(secret, token);
    assert.equal(back.principal?.type, "mcp");
    assert.deepEqual(back.principal?.metadata, {
      deviceId: "dev-1",
      clientName: "claude-code",
    });
    assert.equal(back.mcp, true);
  });

  test("absent principal is undefined (legacy token compatibility)", () => {
    const payload: JwtPayload = {
      sub: "33333333-3333-3333-3333-333333333333",
      email: "legacy@example.test",
      typ: "access",
    };
    const token = signToken(secret, payload);
    const back = verifyToken(secret, token);
    assert.equal(back.principal, undefined);
  });
});
