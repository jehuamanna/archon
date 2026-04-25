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

const SCOPE_RES = {
  "note-A": {
    noteId: "note-A",
    projectId: "p-A",
    workspaceId: "w-A",
    spaceId: "space-A",
    orgId: "org-A",
  },
  "note-B": {
    noteId: "note-B",
    projectId: "p-B",
    workspaceId: "w-B",
    spaceId: "space-B",
    orgId: "org-A",
  },
  "note-C": {
    noteId: "note-C",
    projectId: "p-C",
    workspaceId: "w-C",
    spaceId: "space-C",
    orgId: "org-C",
  },
} as const;

describe("WpnHttpClient.ensureScopeForNote", () => {
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

      const scopeMatch = url.match(/\/wpn\/notes\/([^/]+)\/scope$/);
      if (scopeMatch && method === "GET") {
        const id = decodeURIComponent(scopeMatch[1]!);
        const hit = (SCOPE_RES as Record<string, (typeof SCOPE_RES)[keyof typeof SCOPE_RES]>)[id];
        if (!hit) {
          return new Response(JSON.stringify({ error: "Note not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(hit), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/orgs/active") && method === "POST") {
        const parsed = JSON.parse(body ?? "{}") as { orgId?: string };
        const targetOrg = parsed.orgId ?? "org-X";
        const targetSpace = targetOrg === "org-C" ? "space-C-default" : "space-A";
        return new Response(
          JSON.stringify({
            token: `token-after-${targetOrg}`,
            activeOrgId: targetOrg,
            activeSpaceId: targetSpace,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("no-op when note already in active scope", async () => {
    const holder = new McpTokenHolder();
    holder.setTokens("tok", null);
    holder.setActiveOrg("org-A");
    holder.setActiveSpace("space-A");
    const client = new WpnHttpClient("http://127.0.0.1:9", holder);

    const r = await client.ensureScopeForNote("note-A");

    assert.equal(r.switched, false);
    assert.equal(r.found, true);
    assert.equal(holder.activeOrgId, "org-A");
    assert.equal(holder.activeSpaceId, "space-A");
    const orgActive = calls.find((c) => c.url.endsWith("/orgs/active"));
    assert.equal(orgActive, undefined, "should not have called /orgs/active");
  });

  it("same-org space switch updates only the space header (no JWT swap)", async () => {
    const holder = new McpTokenHolder();
    holder.setTokens("tok", null);
    holder.setActiveOrg("org-A");
    holder.setActiveSpace("space-A");
    const client = new WpnHttpClient("http://127.0.0.1:9", holder);

    const r = await client.ensureScopeForNote("note-B");

    assert.equal(r.switched, true);
    assert.equal(r.found, true);
    assert.equal(r.fromOrgId, "org-A");
    assert.equal(r.toOrgId, "org-A");
    assert.equal(r.fromSpaceId, "space-A");
    assert.equal(r.toSpaceId, "space-B");
    assert.equal(holder.activeSpaceId, "space-B");
    assert.equal(holder.accessToken, "tok", "JWT should not have been swapped");
    const orgActive = calls.find((c) => c.url.endsWith("/orgs/active"));
    assert.equal(orgActive, undefined, "no JWT swap for same-org space change");
  });

  it("cross-org switch swaps JWT and forces target space", async () => {
    const holder = new McpTokenHolder();
    holder.setTokens("tok", null);
    holder.setActiveOrg("org-A");
    holder.setActiveSpace("space-A");
    const client = new WpnHttpClient("http://127.0.0.1:9", holder);

    const r = await client.ensureScopeForNote("note-C");

    assert.equal(r.switched, true);
    assert.equal(r.found, true);
    assert.equal(r.fromOrgId, "org-A");
    assert.equal(r.toOrgId, "org-C");
    assert.equal(r.fromSpaceId, "space-A");
    assert.equal(r.toSpaceId, "space-C");
    assert.equal(holder.activeOrgId, "org-C");
    assert.equal(holder.activeSpaceId, "space-C");
    assert.equal(holder.accessToken, "token-after-org-C");
    const orgActive = calls.find((c) => c.url.endsWith("/orgs/active"));
    assert.ok(orgActive, "expected POST /orgs/active for cross-org switch");
    assert.equal(orgActive!.method, "POST");
    assert.equal(JSON.parse(orgActive!.body ?? "{}").orgId, "org-C");
  });

  it("returns found=false on 404 without mutating session state", async () => {
    const holder = new McpTokenHolder();
    holder.setTokens("tok", null);
    holder.setActiveOrg("org-A");
    holder.setActiveSpace("space-A");
    const client = new WpnHttpClient("http://127.0.0.1:9", holder);

    const r = await client.ensureScopeForNote("note-missing");

    assert.equal(r.switched, false);
    assert.equal(r.found, false);
    assert.equal(holder.activeOrgId, "org-A");
    assert.equal(holder.activeSpaceId, "space-A");
  });

  it("returns found=false (no throw) on network/server error", async () => {
    const holder = new McpTokenHolder();
    holder.setTokens("tok", null);
    holder.setActiveOrg("org-A");
    holder.setActiveSpace("space-A");
    const broken = new WpnHttpClient("http://127.0.0.1:9", holder);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });

    const r = await broken.ensureScopeForNote("note-A");
    assert.equal(r.switched, false);
    assert.equal(r.found, false);
    assert.equal(holder.activeOrgId, "org-A");
  });

  it("invalidates notes-with-context cache when space changes", async () => {
    let notesContextHits = 0;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/wpn/notes-with-context")) {
        notesContextHits++;
        return new Response(JSON.stringify({ notes: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const scopeMatch = url.match(/\/wpn\/notes\/([^/]+)\/scope$/);
      if (scopeMatch && method === "GET") {
        return new Response(JSON.stringify(SCOPE_RES["note-B"]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };
    const holder = new McpTokenHolder();
    holder.setTokens("tok", null);
    holder.setActiveOrg("org-A");
    holder.setActiveSpace("space-A");
    const client = new WpnHttpClient("http://127.0.0.1:9", holder, {
      notesWithContextTtlMs: 60_000,
    });

    await client.getNotesWithContext();
    assert.equal(notesContextHits, 1);
    await client.ensureScopeForNote("note-B");
    await client.getNotesWithContext();
    assert.equal(notesContextHits, 2, "scope switch should invalidate the catalog cache");
  });
});
