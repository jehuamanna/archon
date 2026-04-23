import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

type StorageShape = Record<string, string>;

function makeFakeLocalStorage(seed: StorageShape = {}): Storage {
  const store: StorageShape = { ...seed };
  return {
    get length(): number {
      return Object.keys(store).length;
    },
    clear(): void {
      for (const k of Object.keys(store)) delete store[k];
    },
    getItem(key: string): string | null {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    key(i: number): string | null {
      return Object.keys(store)[i] ?? null;
    },
    removeItem(key: string): void {
      delete store[key];
    },
    setItem(key: string, value: string): void {
      store[key] = value;
    },
  } as Storage;
}

// The module reads localStorage / window at import time. We must set these up
// BEFORE importing refresh-session. Each test resets the harness.

function installBrowserGlobals(seed: StorageShape = {}): void {
  (globalThis as unknown as { window: object }).window = {
    location: { hostname: "127.0.0.1", origin: "http://127.0.0.1:3000" },
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = makeFakeLocalStorage(seed);
  (globalThis as unknown as { document: object }).document = {};
  (globalThis as unknown as { BroadcastChannel: unknown }).BroadcastChannel = class {
    postMessage(): void {}
    addEventListener(): void {}
    close(): void {}
  };
  // fetch replaced per-test
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    throw new Error("fetch not stubbed");
  };
}

function uninstallBrowserGlobals(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  delete (globalThis as unknown as { document?: unknown }).document;
  delete (globalThis as unknown as { BroadcastChannel?: unknown }).BroadcastChannel;
  delete (globalThis as unknown as { fetch?: unknown }).fetch;
}

async function importFresh(): Promise<typeof import("./refresh-session.ts")> {
  // Bust the module cache by appending a query string — Node's ESM loader honours it.
  return import(`./refresh-session.ts?t=${Date.now()}${Math.random()}`) as unknown as Promise<
    typeof import("./refresh-session.ts")
  >;
}

beforeEach(() => {
  installBrowserGlobals();
});

afterEach(() => {
  uninstallBrowserGlobals();
});

test("refreshSessionOnce returns no_refresh_token when none is stored", async () => {
  const mod = await importFresh();
  const r = await mod.refreshSessionOnce();
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "no_refresh_token");
});

test("refreshSessionOnce returns refresh_failed_server on 401 from /auth/refresh", async () => {
  installBrowserGlobals({ "archon-sync-refresh-token": "existing-refresh" });
  // Point the resolver at a concrete sync base via the window override.
  (globalThis as unknown as { window: Record<string, string> }).window.__ARCHON_SYNC_API_BASE__ =
    "http://127.0.0.1:4010/api/v1";
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response("{\"error\":\"Invalid or expired refresh token\"}", { status: 401 });
  const mod = await importFresh();
  const r = await mod.refreshSessionOnce();
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "refresh_failed_server");
});

test("refreshSessionOnce returns refresh_failed_network when fetch throws", async () => {
  installBrowserGlobals({ "archon-sync-refresh-token": "existing-refresh" });
  (globalThis as unknown as { window: Record<string, string> }).window.__ARCHON_SYNC_API_BASE__ =
    "http://127.0.0.1:4010/api/v1";
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    throw new TypeError("NetworkError");
  };
  const mod = await importFresh();
  const r = await mod.refreshSessionOnce();
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "refresh_failed_network");
});

test("refreshSessionOnce returns malformed_server_response on bad payload", async () => {
  installBrowserGlobals({ "archon-sync-refresh-token": "existing-refresh" });
  (globalThis as unknown as { window: Record<string, string> }).window.__ARCHON_SYNC_API_BASE__ =
    "http://127.0.0.1:4010/api/v1";
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response("{\"token\":42}", { status: 200 });
  const mod = await importFresh();
  const r = await mod.refreshSessionOnce();
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "malformed_server_response");
});

test("refreshSessionOnce writes both rotated tokens and returns ok on 200", async () => {
  installBrowserGlobals({ "archon-sync-refresh-token": "existing-refresh" });
  (globalThis as unknown as { window: Record<string, string> }).window.__ARCHON_SYNC_API_BASE__ =
    "http://127.0.0.1:4010/api/v1";
  let seenBody: unknown = null;
  (globalThis as unknown as { fetch: unknown }).fetch = async (_url: string, init: RequestInit) => {
    seenBody = init.body;
    return new Response(
      JSON.stringify({ token: "new-access", refreshToken: "new-refresh" }),
      { status: 200 },
    );
  };
  const mod = await importFresh();
  const r = await mod.refreshSessionOnce();
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.accessToken, "new-access");
    assert.equal(r.refreshToken, "new-refresh");
  }
  assert.equal(
    (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(
      "archon-sync-auth-token",
    ),
    "new-access",
  );
  assert.equal(
    (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(
      "archon-sync-refresh-token",
    ),
    "new-refresh",
  );
  assert.deepEqual(JSON.parse(String(seenBody)), { refreshToken: "existing-refresh" });
});
