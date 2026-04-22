import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpTokenHolder } from "./mcp-token-holder.js";
import { WpnHttpClient } from "./wpn-client.js";

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function headersToObject(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = String(v);
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k] = String(v);
  return out;
}

describe("WpnHttpClient.switchActiveOrg", () => {
  let origFetch: typeof fetch;
  let calls: FetchCall[];

  beforeEach(() => {
    calls = [];
    origFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = headersToObject(init);
      const body =
        typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : null;
      calls.push({ url, method, headers, body });
      if (url.endsWith("/orgs/active") && method === "POST") {
        return new Response(
          JSON.stringify({
            token: "new-access",
            activeOrgId: "org-B",
            activeSpaceId: "space-B",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/wpn/workspaces") && method === "GET") {
        return new Response(JSON.stringify({ workspaces: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("posts to /orgs/active with orgId and applies token + org + space", async () => {
    const holder = new McpTokenHolder();
    holder.setTokens("old-access", "rt-1");
    holder.setActiveOrg("org-A");
    holder.setActiveSpace("space-A");

    let persisted: { access: string; refresh: string | null } | null = null;
    const client = new WpnHttpClient("http://127.0.0.1:9", holder, {
      onTokensUpdated: (access, refresh) => {
        persisted = { access, refresh };
      },
    });

    const res = await client.switchActiveOrg("org-B");

    const postCall = calls.find((c) => c.url.endsWith("/orgs/active"));
    assert.ok(postCall, "expected POST /orgs/active call");
    assert.equal(postCall!.method, "POST");
    assert.equal(JSON.parse(postCall!.body ?? "{}").orgId, "org-B");
    assert.equal(postCall!.headers["Authorization"], "Bearer old-access");
    assert.equal(postCall!.headers["X-Archon-Org"], "org-A");

    assert.deepEqual(res, { activeOrgId: "org-B", activeSpaceId: "space-B" });
    assert.equal(holder.accessToken, "new-access");
    assert.equal(holder.refreshToken, "rt-1");
    assert.equal(holder.activeOrgId, "org-B");
    assert.equal(holder.activeSpaceId, "space-B");
    assert.deepEqual(persisted, { access: "new-access", refresh: "rt-1" });
  });

  it("subsequent WPN calls use the new org context headers", async () => {
    const holder = new McpTokenHolder();
    holder.setTokens("old-access", "rt-1");
    holder.setActiveOrg("org-A");
    holder.setActiveSpace("space-A");

    const client = new WpnHttpClient("http://127.0.0.1:9", holder);
    await client.switchActiveOrg("org-B");
    await client.getWorkspaces();

    const wsCall = calls.find((c) => c.url.endsWith("/wpn/workspaces"));
    assert.ok(wsCall, "expected GET /wpn/workspaces call");
    assert.equal(wsCall!.headers["Authorization"], "Bearer new-access");
    assert.equal(wsCall!.headers["X-Archon-Org"], "org-B");
    assert.equal(wsCall!.headers["X-Archon-Space"], "space-B");
  });

  it("throws when response is missing token", async () => {
    const holder = new McpTokenHolder();
    holder.setTokens("old-access", "rt-1");
    const origFetch2 = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ activeOrgId: "org-B" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const client = new WpnHttpClient("http://127.0.0.1:9", holder);
    await assert.rejects(() => client.switchActiveOrg("org-B"), /missing token/);
    globalThis.fetch = origFetch2;
  });

  it("surfaces backend error message on non-2xx", async () => {
    const holder = new McpTokenHolder();
    holder.setTokens("old-access", "rt-1");
    const origFetch2 = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "not a member" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    const client = new WpnHttpClient("http://127.0.0.1:9", holder);
    await assert.rejects(() => client.switchActiveOrg("org-B"), /not a member/);
    globalThis.fetch = origFetch2;
  });
});

describe("McpTokenHolder one-shot org override (list_wpn pattern)", () => {
  let origFetch: typeof fetch;
  let calls: FetchCall[];

  beforeEach(() => {
    calls = [];
    origFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = headersToObject(init);
      calls.push({ url, method, headers, body: null });
      if (url.endsWith("/wpn/workspaces")) {
        return new Response(JSON.stringify({ workspaces: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("temporarily flipping holder.activeOrgId affects only requests made during the override window", async () => {
    const holder = new McpTokenHolder();
    holder.setTokens("tok", null);
    holder.setActiveOrg("org-A");
    const client = new WpnHttpClient("http://127.0.0.1:9", holder);

    await client.getWorkspaces();

    const prev = holder.activeOrgId;
    holder.setActiveOrg("org-B");
    try {
      await client.getWorkspaces();
    } finally {
      holder.setActiveOrg(prev);
    }

    await client.getWorkspaces();

    assert.equal(calls.length, 3);
    assert.equal(calls[0]!.headers["X-Archon-Org"], "org-A");
    assert.equal(calls[1]!.headers["X-Archon-Org"], "org-B");
    assert.equal(calls[2]!.headers["X-Archon-Org"], "org-A");
  });
});
