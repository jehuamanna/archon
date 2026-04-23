import assert from "node:assert/strict";
import test from "node:test";
import { decodeAccessTokenExpiry, decodeJwtPayload } from "./jwt-exp.ts";

function makeToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

// node: `atob` is globally available, but renderer code uses it too — this confirms
// decodeJwtPayload works in a node environment when Node's atob does the base64 decode.

test("decodeJwtPayload returns the payload object", () => {
  const tok = makeToken({ sub: "u1", exp: 1234 });
  const p = decodeJwtPayload(tok);
  assert.ok(p);
  assert.equal(p.sub, "u1");
  assert.equal(p.exp, 1234);
});

test("decodeJwtPayload returns null for structurally invalid tokens", () => {
  for (const bad of ["", "notajwt", "a.b", "a.b.c.d", null, undefined]) {
    assert.equal(decodeJwtPayload(bad as string | null | undefined), null, `input=${String(bad)}`);
  }
});

test("decodeJwtPayload returns null when the middle segment is not valid base64url-of-JSON", () => {
  assert.equal(decodeJwtPayload("a.!!!not-base64!!!.c"), null);
});

test("decodeAccessTokenExpiry extracts expMs and iatMs", () => {
  const expSec = Math.trunc(Date.now() / 1000) + 900;
  const iatSec = Math.trunc(Date.now() / 1000);
  const tok = makeToken({ exp: expSec, iat: iatSec });
  const out = decodeAccessTokenExpiry(tok);
  assert.ok(out);
  assert.equal(out.expMs, expSec * 1000);
  assert.equal(out.iatMs, iatSec * 1000);
});

test("decodeAccessTokenExpiry returns null when exp is missing or non-numeric", () => {
  assert.equal(decodeAccessTokenExpiry(makeToken({})), null);
  assert.equal(decodeAccessTokenExpiry(makeToken({ exp: "soon" })), null);
});

test("decodeAccessTokenExpiry returns iatMs=null when iat missing", () => {
  const tok = makeToken({ exp: 1234 });
  const out = decodeAccessTokenExpiry(tok);
  assert.ok(out);
  assert.equal(out.iatMs, null);
});
