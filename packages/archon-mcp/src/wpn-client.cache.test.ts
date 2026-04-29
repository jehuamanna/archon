import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpTokenHolder } from "./mcp-token-holder.js";
import { WpnHttpClient } from "./wpn-client.js";

const sampleRows = [
  {
    id: "n1",
    title: "Hello",
    type: "markdown",
    project_id: "p1",
    project_name: "Prj",
  },
];

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

describe("WpnHttpClient getNotesWithContext cache", () => {
  let origFetch: typeof fetch;
  let catalogGets: number;

  beforeEach(() => {
    catalogGets = 0;
    origFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("/wpn/notes-with-context")) {
        catalogGets++;
        return new Response(JSON.stringify({ notes: sampleRows }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/wpn/notes/") && init?.method === "PATCH") {
        return new Response(
          JSON.stringify({
            note: {
              id: "n1",
              project_id: "p1",
              parent_id: null,
              type: "markdown",
              title: "Hello",
              content: "x",
              sibling_index: 0,
              created_at_ms: 0,
              updated_at_ms: 0,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/wpn/projects/") && url.includes("/notes") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "new" }), {
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

  it("reuses notes-with-context within TTL", async () => {
    const holder = new McpTokenHolder();
    holder.setTokens("t", null);
    const client = new WpnHttpClient("http://127.0.0.1:9", holder, {
      notesWithContextTtlMs: 60_000,
    });
    await client.getNotesWithContext();
    await client.getNotesWithContext();
    assert.equal(catalogGets, 1);
  });

  it("refetches after patchNote invalidates cache", async () => {
    const holder = new McpTokenHolder();
    holder.setTokens("t", null);
    const client = new WpnHttpClient("http://127.0.0.1:9", holder, {
      notesWithContextTtlMs: 60_000,
    });
    await client.getNotesWithContext();
    assert.equal(catalogGets, 1);
    await client.patchNote("n1", { title: "y" });
    await client.getNotesWithContext();
    assert.equal(catalogGets, 2);
  });

  it("refetches after createNote invalidates cache", async () => {
    const holder = new McpTokenHolder();
    holder.setTokens("t", null);
    const client = new WpnHttpClient("http://127.0.0.1:9", holder, {
      notesWithContextTtlMs: 60_000,
    });
    await client.getNotesWithContext();
    assert.equal(catalogGets, 1);
    await client.createNote("p1", { type: "markdown", relation: "root" });
    await client.getNotesWithContext();
    assert.equal(catalogGets, 2);
  });

  it("does not cache when notesWithContextTtlMs is 0", async () => {
    const holder = new McpTokenHolder();
    holder.setTokens("t", null);
    const client = new WpnHttpClient("http://127.0.0.1:9", holder, {
      notesWithContextTtlMs: 0,
    });
    await client.getNotesWithContext();
    await client.getNotesWithContext();
    assert.equal(catalogGets, 2);
  });
});
