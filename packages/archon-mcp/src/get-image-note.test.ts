import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  handleGetImageNote,
  DEFAULT_MAX_BYTES,
  type GetImageNoteDeps,
} from "./get-image-note.js";
import type { WpnNoteDetail } from "./wpn-client.js";

function makeImageNote(overrides: Partial<WpnNoteDetail> = {}): WpnNoteDetail {
  return {
    id: "note-1",
    project_id: "proj-1",
    parent_id: null,
    type: "image",
    title: "My Image",
    content: "",
    metadata: {
      r2Key: "org/space/ws/proj/note-1",
      thumbKey: "org/space/ws/proj/note-1/thumb",
      mimeType: "image/png",
      sizeBytes: 2048,
      thumbMime: "image/webp",
      thumbSizeBytes: 512,
      width: 100,
      height: 80,
    },
    sibling_index: 0,
    created_at_ms: 0,
    updated_at_ms: 0,
    ...overrides,
  } as WpnNoteDetail;
}

function makeDeps(
  note: WpnNoteDetail,
  opts: Partial<GetImageNoteDeps> & {
    bytes?: Uint8Array;
    fetchedMime?: string;
  } = {},
): { deps: GetImageNoteDeps; signed: string[]; fetched: string[] } {
  const signed: string[] = [];
  const fetched: string[] = [];
  const deps: GetImageNoteDeps = {
    getNote: opts.getNote ?? (async () => note),
    resolvePath:
      opts.resolvePath ?? (async () => "WS / Proj / My Image"),
    signAssetKey:
      opts.signAssetKey ??
      (async (key) => {
        signed.push(key);
        return {
          url: `https://r2.example/${encodeURIComponent(key)}?sig=x`,
          expiresAt: 1_000_000,
        };
      }),
    fetchBytes:
      opts.fetchBytes ??
      (async (url) => {
        fetched.push(url);
        return {
          bytes: opts.bytes ?? new Uint8Array([1, 2, 3, 4]),
          mimeType: opts.fetchedMime ?? "image/png",
        };
      }),
  };
  return { deps, signed, fetched };
}

function parseFirstTextBlock<T>(result: {
  content: Array<{ type: string; text?: string }>;
}): T {
  const block = result.content.find((c) => c.type === "text");
  if (!block || typeof block.text !== "string") {
    throw new Error("no text block in result");
  }
  return JSON.parse(block.text) as T;
}

describe("handleGetImageNote", () => {
  it("returns inline image block + metadata for a small image in auto mode", async () => {
    const note = makeImageNote();
    const { deps, signed, fetched } = makeDeps(note);
    const result = await handleGetImageNote({ noteId: "note-1" }, deps);

    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0]!.type, "text");
    assert.equal(result.content[1]!.type, "image");

    const meta = parseFirstTextBlock<{
      noteId: string;
      delivery: string;
      path: string | null;
    }>(result);
    assert.equal(meta.noteId, "note-1");
    assert.equal(meta.delivery, "inline");
    assert.equal(meta.path, "WS / Proj / My Image");
    assert.deepEqual(signed, [note.metadata!.r2Key]);
    assert.equal(fetched.length, 1);

    const imageBlock = result.content[1] as {
      type: "image";
      data: string;
      mimeType: string;
    };
    assert.equal(imageBlock.mimeType, "image/png");
    // 4 raw bytes → base64 "AQIDBA=="
    assert.equal(imageBlock.data, Buffer.from([1, 2, 3, 4]).toString("base64"));
  });

  it("falls back to url delivery when sizeBytes exceeds maxBytes", async () => {
    const note = makeImageNote({
      metadata: {
        ...makeImageNote().metadata,
        sizeBytes: DEFAULT_MAX_BYTES + 1,
      },
    });
    const { deps, fetched } = makeDeps(note);
    const result = await handleGetImageNote({ noteId: "note-1" }, deps);

    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]!.type, "text");
    const meta = parseFirstTextBlock<{
      delivery: string;
      fullUrl: string;
      reason: string;
    }>(result);
    assert.equal(meta.delivery, "url");
    assert.match(meta.fullUrl, /^https:\/\/r2\.example\//);
    assert.match(meta.reason, /exceeds maxBytes/);
    // bytes should NOT have been fetched — size cap short-circuits
    assert.equal(fetched.length, 0);
  });

  it("returns thumb WebP on mode=thumbnail", async () => {
    const note = makeImageNote();
    const { deps, signed } = makeDeps(note, { fetchedMime: "image/webp" });
    const result = await handleGetImageNote(
      { noteId: "note-1", mode: "thumbnail" },
      deps,
    );

    assert.equal(result.content.length, 2);
    const imageBlock = result.content[1] as { mimeType: string };
    assert.equal(imageBlock.mimeType, "image/webp");
    assert.deepEqual(signed, [note.metadata!.thumbKey]);
  });

  it("errors on mode=thumbnail when note has no thumbKey", async () => {
    const note = makeImageNote({
      metadata: { ...makeImageNote().metadata, thumbKey: undefined },
    });
    const { deps } = makeDeps(note);
    const result = await handleGetImageNote(
      { noteId: "note-1", mode: "thumbnail" },
      deps,
    );

    assert.equal(result.isError, true);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /no thumbKey/);
  });

  it("errors on a non-image note", async () => {
    const md: WpnNoteDetail = {
      ...makeImageNote(),
      type: "markdown",
    };
    const { deps } = makeDeps(md);
    const result = await handleGetImageNote({ noteId: "note-1" }, deps);

    assert.equal(result.isError, true);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /expected "image"/);
  });

  it("returns url-only delivery on mode=url (no byte fetch)", async () => {
    const note = makeImageNote();
    const { deps, fetched } = makeDeps(note);
    const result = await handleGetImageNote(
      { noteId: "note-1", mode: "url" },
      deps,
    );

    assert.equal(result.content.length, 1);
    const meta = parseFirstTextBlock<{
      delivery: string;
      fullUrl: string;
      expiresAt: number;
    }>(result);
    assert.equal(meta.delivery, "url");
    assert.equal(meta.expiresAt, 1_000_000);
    assert.equal(fetched.length, 0);
  });

  it("returns base64 JSON (no image block) on mode=base64", async () => {
    const note = makeImageNote();
    const { deps } = makeDeps(note);
    const result = await handleGetImageNote(
      { noteId: "note-1", mode: "base64" },
      deps,
    );

    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]!.type, "text");
    const meta = parseFirstTextBlock<{
      delivery: string;
      dataBase64: string;
      mimeType: string;
    }>(result);
    assert.equal(meta.delivery, "base64");
    assert.equal(meta.mimeType, "image/png");
    assert.equal(meta.dataBase64, Buffer.from([1, 2, 3, 4]).toString("base64"));
  });
});
