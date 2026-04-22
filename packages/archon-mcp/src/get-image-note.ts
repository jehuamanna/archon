import type { WpnNoteDetail } from "./wpn-client.js";
import {
  errorResult,
  imageAndJsonResult,
  jsonResult,
  type ToolReturn,
} from "./text-result.js";
import { stripImageMetadata } from "./strip-image-metadata.js";

export type GetImageNoteMode =
  | "auto"
  | "inline"
  | "base64"
  | "url"
  | "thumbnail";

export type GetImageNoteInput = {
  noteId: string;
  mode?: GetImageNoteMode;
  maxBytes?: number;
};

export type FetchedImage = { bytes: Uint8Array; mimeType: string };

export type GetImageNoteDeps = {
  getNote: (id: string) => Promise<WpnNoteDetail>;
  /** Best-effort `Workspace / Project / Title` label; returns null when not resolvable. */
  resolvePath: (note: WpnNoteDetail) => Promise<string | null>;
  signAssetKey: (
    key: string,
  ) => Promise<{ url: string; expiresAt: number }>;
  fetchBytes: (url: string) => Promise<FetchedImage>;
};

export const DEFAULT_MAX_BYTES = 512 * 1024;

type ImageMeta = {
  r2Key: string | null;
  thumbKey: string | null;
  mimeType: string;
  sizeBytes: number | null;
  thumbMime: string;
  thumbSizeBytes: number | null;
  width: number | null;
  height: number | null;
};

function readImageMeta(note: WpnNoteDetail): ImageMeta {
  const m = (note.metadata as Record<string, unknown> | undefined) ?? {};
  const str = (k: string, fallback = ""): string =>
    typeof m[k] === "string" ? (m[k] as string) : fallback;
  const num = (k: string): number | null =>
    typeof m[k] === "number" && Number.isFinite(m[k]) ? (m[k] as number) : null;
  return {
    r2Key: str("r2Key") || null,
    thumbKey: str("thumbKey") || null,
    mimeType: str("mimeType", "application/octet-stream"),
    sizeBytes: num("sizeBytes"),
    thumbMime: str("thumbMime", "image/webp"),
    thumbSizeBytes: num("thumbSizeBytes"),
    width: num("width"),
    height: num("height"),
  };
}

export async function handleGetImageNote(
  args: GetImageNoteInput,
  deps: GetImageNoteDeps,
): Promise<ToolReturn> {
  const note = await deps.getNote(args.noteId);
  if (note.type !== "image") {
    return errorResult(
      `note ${args.noteId} is type "${note.type}", expected "image" — use archon_get_note for non-image notes`,
    );
  }
  const meta = readImageMeta(note);
  if (!meta.r2Key) {
    return errorResult(
      `image note ${args.noteId} has no r2Key in metadata (upload incomplete?)`,
    );
  }

  const path = await deps.resolvePath(note);
  const baseMeta = {
    noteId: note.id,
    title: note.title,
    path,
    mimeType: meta.mimeType,
    sizeBytes: meta.sizeBytes,
    width: meta.width,
    height: meta.height,
  };

  const mode: GetImageNoteMode = args.mode ?? "auto";
  const maxBytes =
    args.maxBytes && args.maxBytes > 0 ? args.maxBytes : DEFAULT_MAX_BYTES;

  if (mode === "thumbnail") {
    if (!meta.thumbKey) {
      return errorResult(
        `image note ${args.noteId} has no thumbKey — upload happened before PLAN 04 or thumb generation failed`,
      );
    }
    const { url } = await deps.signAssetKey(meta.thumbKey);
    const fetched = await deps.fetchBytes(url);
    const imageMime = fetched.mimeType || meta.thumbMime;
    const sanitized = stripImageMetadata(fetched.bytes, imageMime);
    return imageAndJsonResult(
      {
        ...baseMeta,
        delivery: "thumbnail",
        thumbnail: {
          mimeType: imageMime,
          sizeBytes: meta.thumbSizeBytes ?? sanitized.byteLength,
        },
      },
      {
        data: bytesToBase64(sanitized),
        mimeType: imageMime,
      },
    );
  }

  if (mode === "url") {
    const signed = await deps.signAssetKey(meta.r2Key);
    return jsonResult({
      ...baseMeta,
      delivery: "url",
      fullUrl: signed.url,
      expiresAt: signed.expiresAt,
    });
  }

  // auto | inline | base64 — fetch bytes, fall back to url on size cap
  const signed = await deps.signAssetKey(meta.r2Key);
  if (meta.sizeBytes !== null && meta.sizeBytes > maxBytes) {
    return jsonResult({
      ...baseMeta,
      delivery: "url",
      fullUrl: signed.url,
      expiresAt: signed.expiresAt,
      reason: `size ${meta.sizeBytes} bytes exceeds maxBytes ${maxBytes} — delivered as signed URL`,
    });
  }

  const fetched = await deps.fetchBytes(signed.url);
  if (fetched.bytes.byteLength > maxBytes) {
    return jsonResult({
      ...baseMeta,
      delivery: "url",
      fullUrl: signed.url,
      expiresAt: signed.expiresAt,
      reason: `fetched ${fetched.bytes.byteLength} bytes exceeds maxBytes ${maxBytes} — delivered as signed URL`,
    });
  }
  const imageMime = fetched.mimeType || meta.mimeType;
  const sanitized = stripImageMetadata(fetched.bytes, imageMime);
  const dataBase64 = bytesToBase64(sanitized);

  const resolvedMode = mode === "auto" ? "inline" : mode;
  if (resolvedMode === "inline") {
    return imageAndJsonResult(
      { ...baseMeta, delivery: "inline" },
      { data: dataBase64, mimeType: imageMime },
    );
  }
  return jsonResult({
    ...baseMeta,
    delivery: "base64",
    dataBase64,
    mimeType: imageMime,
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
