import { createSyncBaseUrlResolver } from "@archon/platform";
import { getArchon } from "../../../../../shared/archon-host-access";
import { readCloudSyncToken } from "../../../../cloud-sync/cloud-sync-storage";
import { generateImageThumbnail, THUMBNAIL_CONSTANTS } from "./generate-thumbnail";

/**
 * Renderer-side client for the PLAN 01 image-asset endpoints mounted at
 * `/me/assets/*`. Kept local to the image-notes plugin so the web shim stays
 * thin — only this plugin posts multipart bodies today.
 */

const resolveSyncBase = createSyncBaseUrlResolver();

export type ImageAssetUploadResult = {
  r2Key: string;
  sizeBytes: number;
  mimeType: string;
  originalFilename?: string;
};

export type ImageAssetSignResult = {
  url: string;
  expiresAt: number;
};

export type NoteScope = {
  workspaceId: string;
  projectId: string;
};

function baseUrl(): string {
  const b = resolveSyncBase().trim().replace(/\/$/, "");
  if (!b) {
    throw new Error("Sync API base URL is not configured.");
  }
  return b;
}

function authHeaders(): Record<string, string> {
  const token = readCloudSyncToken();
  if (!token) {
    throw new Error("Not signed in to cloud sync.");
  }
  return { Authorization: `Bearer ${token}` };
}

/**
 * Resolve a note's workspace + project via `GET /wpn/notes-with-context`, which
 * is the only endpoint that returns both ids in a single round-trip. `Note` in
 * the renderer doesn't carry them, and there's no per-project GET that surfaces
 * `workspace_id`. Response is typically small (current space only); cache at
 * call-site if upload latency matters later.
 */
export async function resolveNoteScope(noteId: string): Promise<NoteScope> {
  const res = await fetch(`${baseUrl()}/wpn/notes-with-context`, {
    method: "GET",
    headers: authHeaders(),
    credentials: "omit",
  });
  if (!res.ok) {
    throw new Error(`notes-with-context lookup failed: ${res.status}`);
  }
  const json = (await res.json()) as {
    notes?: { id: string; workspace_id: string; project_id: string }[];
  };
  const hit = (json.notes ?? []).find((n) => n.id === noteId);
  if (!hit) {
    throw new Error(`Note ${noteId} not found in current scope`);
  }
  return { workspaceId: hit.workspace_id, projectId: hit.project_id };
}

/**
 * Upload an image file for a given note. Caller is responsible for calling
 * `patchNoteMetadata` with the returned `{ r2Key, mimeType, sizeBytes, … }`
 * so the metadata version bump + validator live in the slice / store layer.
 */
export type ImageAssetVariant = "original" | "thumb";

export async function uploadImageAsset(args: {
  noteId: string;
  file: File;
  scope?: NoteScope;
  /** Plan 04: `"thumb"` stores the blob under `<key>/thumb`. Default `"original"`. */
  variant?: ImageAssetVariant;
}): Promise<ImageAssetUploadResult> {
  const scope = args.scope ?? (await resolveNoteScope(args.noteId));

  const body = new FormData();
  body.set("workspaceId", scope.workspaceId);
  body.set("projectId", scope.projectId);
  body.set("noteId", args.noteId);
  if (args.variant && args.variant !== "original") {
    body.set("variant", args.variant);
  }
  body.set("file", args.file, args.file.name);

  const res = await fetch(`${baseUrl()}/me/assets/upload`, {
    method: "POST",
    headers: authHeaders(),
    body,
    credentials: "omit",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upload failed: ${res.status} ${text}`);
  }
  return (await res.json()) as ImageAssetUploadResult;
}

export type ImageNoteMetadataV1 = {
  metadataVersion: 1;
  r2Key: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  originalFilename?: string;
  /** Plan 04: optional thumb key stored at `<original-key>/thumb`. */
  thumbKey?: string;
  thumbMime?: string;
  thumbSizeBytes?: number;
};

/**
 * Derive a sensible default title for a pasted or dropped image. Uses the
 * provided filename (stripped of its extension) when available; otherwise
 * falls back to a user-local timestamp string so the explorer row is
 * scannable.
 */
export function deriveImageNoteTitle(filename: string | undefined | null): string {
  const trimmed = (filename ?? "").trim();
  if (trimmed) {
    const stem = trimmed.replace(/\.[^./\\]+$/, "");
    return stem.length > 0 ? stem : trimmed;
  }
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Pasted ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * End-to-end: create a child image note under `parentNoteId`, upload the
 * file, return the new note id plus the metadata patch the caller must
 * dispatch (`patchNoteMetadata`). Keeping the dispatch out of this helper
 * lets callers use Redux or their own optimistic state pattern.
 *
 * If any step fails after note creation, the caller is responsible for
 * deciding whether to delete the orphaned note. PLAN 03 leaves the
 * half-created note in place so the user can retry; a background GC
 * (orphan-asset follow-up plan) will eventually reclaim truly dead ones.
 */
export async function createChildImageNote(args: {
  parentNoteId: string;
  file: File;
  /**
   * Optional — callers that already resolved scope (explorer knows
   * `projectId` from the tree context) can short-circuit the extra
   * `/wpn/notes-with-context` round-trip.
   */
  projectId?: string;
}): Promise<{ noteId: string; metadata: ImageNoteMetadataV1 }> {
  // eslint-disable-next-line no-console
  console.log("[plan04-debug] createChildImageNote called", {
    parentNoteId: args.parentNoteId,
    projectId: args.projectId,
    fileName: args.file.name,
    fileType: args.file.type,
    fileSize: args.file.size,
  });
  const projectId =
    args.projectId ?? (await resolveNoteScope(args.parentNoteId)).projectId;
  const title = deriveImageNoteTitle(args.file.name);
  // eslint-disable-next-line no-console
  console.log("[plan04-debug] creating child note", { projectId, title });
  const created = await getArchon().wpnCreateNoteInProject(projectId, {
    relation: "child",
    anchorId: args.parentNoteId,
    type: "image",
    title,
  });
  const noteId = created.id;
  // eslint-disable-next-line no-console
  console.log("[plan04-debug] child note created; uploading original", { noteId });
  const upload = await uploadImageAsset({ noteId, file: args.file });
  // eslint-disable-next-line no-console
  console.log("[plan04-debug] original uploaded", upload);
  const metadata: ImageNoteMetadataV1 = {
    metadataVersion: 1,
    r2Key: upload.r2Key,
    mimeType: upload.mimeType,
    sizeBytes: upload.sizeBytes,
    originalFilename: upload.originalFilename,
  };

  // Plan 04: generate + upload thumbnail. Log-and-continue on any failure
  // — the original upload is already committed, and callers can render
  // the full-resolution image inline as a fallback.
  try {
    // eslint-disable-next-line no-console
    console.log("[plan04-debug] about to call generateImageThumbnail");
    const thumb = await generateImageThumbnail(args.file);
    // eslint-disable-next-line no-console
    console.log("[plan04-debug] generateImageThumbnail returned", {
      width: thumb.width,
      height: thumb.height,
      blobSize: thumb.blob.size,
    });
    const thumbFile = new File([thumb.blob], `${title}.thumb.webp`, {
      type: thumb.mime,
    });
    const thumbUpload = await uploadImageAsset({
      noteId,
      file: thumbFile,
      variant: "thumb",
    });
    metadata.thumbKey = thumbUpload.r2Key;
    metadata.thumbMime = thumbUpload.mimeType;
    metadata.thumbSizeBytes = thumbUpload.sizeBytes;
    metadata.width = thumb.sourceWidth;
    metadata.height = thumb.sourceHeight;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[image-notes] thumbnail generation failed; continuing without thumb",
      err,
    );
    void THUMBNAIL_CONSTANTS; // keep import alive for tree-shaker guidance
  }

  return { noteId, metadata };
}

/**
 * Request a short-TTL presigned GET URL for an R2 object. TTL is bounded by
 * the server to `[60, 900]` seconds.
 */
export async function signImageAsset(args: {
  key: string;
  ttlSec?: number;
}): Promise<ImageAssetSignResult> {
  const res = await fetch(`${baseUrl()}/me/assets/sign`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ key: args.key, ttlSec: args.ttlSec ?? 900 }),
    credentials: "omit",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Sign failed: ${res.status} ${text}`);
  }
  return (await res.json()) as ImageAssetSignResult;
}
