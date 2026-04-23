import assert from "node:assert/strict";
import test from "node:test";
import {
  RetriableAfterLoginError,
  SessionExpiredError,
  withAuthRetry,
  type AuthRequestDescriptor,
  type WithAuthRetryDeps,
} from "@archon/platform";

function makeDeps(overrides: Partial<WithAuthRetryDeps>): WithAuthRetryDeps {
  return {
    getAccessToken: () => "T0",
    refreshSessionOnce: async () => ({ ok: true, accessToken: "T1" }),
    ...overrides,
  };
}

function req(url = "http://x/test"): AuthRequestDescriptor {
  return { method: "GET", url, headersWithoutAuth: { "X-A": "1" } };
}

test("non-401 response passes through unchanged", async () => {
  const deps = makeDeps({
    fetch: async () => new Response("ok", { status: 200 }),
  });
  const r = await withAuthRetry(req(), {}, deps);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "ok");
});

test("401 triggers refresh and a single replay with the new token", async () => {
  const calls: Array<{ headers: Record<string, string> }> = [];
  const deps = makeDeps({
    fetch: async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({ headers });
      if (calls.length === 1) return new Response("", { status: 401 });
      return new Response("after", { status: 200 });
    },
  });
  const r = await withAuthRetry(req(), {}, deps);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "after");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Authorization, "Bearer T0");
  assert.equal(calls[1].headers.Authorization, "Bearer T1");
});

test("streamingBody=true throws RetriableAfterLoginError instead of replay", async () => {
  const deps = makeDeps({
    fetch: async () => new Response("", { status: 401 }),
  });
  await assert.rejects(
    () => withAuthRetry({ ...req(), streamingBody: true }, {}, deps),
    (err) => err instanceof RetriableAfterLoginError,
  );
});

test("replay=false throws RetriableAfterLoginError on 401", async () => {
  const deps = makeDeps({
    fetch: async () => new Response("", { status: 401 }),
  });
  await assert.rejects(
    () => withAuthRetry(req(), { replay: false }, deps),
    (err) => err instanceof RetriableAfterLoginError,
  );
});

test("refresh returning no_refresh_token yields SessionExpiredError(no_refresh_token)", async () => {
  const deps = makeDeps({
    fetch: async () => new Response("", { status: 401 }),
    refreshSessionOnce: async () => ({ ok: false, reason: "no_refresh_token" }),
  });
  await assert.rejects(
    () => withAuthRetry(req(), {}, deps),
    (err) =>
      err instanceof SessionExpiredError && err.reason === "no_refresh_token",
  );
});

test("refresh returning refresh_failed_network yields SessionExpiredError(refresh_failed_network)", async () => {
  const deps = makeDeps({
    fetch: async () => new Response("", { status: 401 }),
    refreshSessionOnce: async () => ({ ok: false, reason: "refresh_failed_network" }),
  });
  await assert.rejects(
    () => withAuthRetry(req(), {}, deps),
    (err) =>
      err instanceof SessionExpiredError && err.reason === "refresh_failed_network",
  );
});

test("replay also returning 401 yields SessionExpiredError(retry_still_401) without looping", async () => {
  let calls = 0;
  const deps = makeDeps({
    fetch: async () => {
      calls += 1;
      return new Response("", { status: 401 });
    },
  });
  await assert.rejects(
    () => withAuthRetry(req(), {}, deps),
    (err) => err instanceof SessionExpiredError && err.reason === "retry_still_401",
  );
  assert.equal(calls, 2, "expected exactly one retry");
});

test("refreshSessionOnce synchronously throwing is mapped to refresh_internal_error", async () => {
  const deps = makeDeps({
    fetch: async () => new Response("", { status: 401 }),
    refreshSessionOnce: async () => {
      throw new Error("boom");
    },
  });
  await assert.rejects(
    () => withAuthRetry(req(), {}, deps),
    (err) => err instanceof SessionExpiredError && err.reason === "refresh_internal_error",
  );
});
