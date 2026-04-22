/**
 * R2 key + mime helpers for image notes (Plans 01, 04).
 *
 * Key shapes:
 *   original (Plan 01): {orgId}/{spaceId}/{workspaceId}/{projectId}/{noteId}
 *   thumb    (Plan 04): {orgId}/{spaceId}/{workspaceId}/{projectId}/{noteId}/thumb
 *
 * Original filename + extension are kept in `WpnImageNoteMetadata`,
 * not in the R2 key, so renames/extensions don't reshuffle storage.
 * The thumb variant uses an extra segment rather than a suffix so the
 * parser can distinguish without regex hacks and ACL scoping stays
 * identical (workspace + project are segments 3 + 4 either way).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG_OR_SPACE_RE = /^[a-zA-Z0-9_-]+$/;

export const IMAGE_MIME_ALLOWLIST: ReadonlyArray<string> = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/heic",
];

export function isAllowedImageMime(mime: string): boolean {
  return IMAGE_MIME_ALLOWLIST.includes(mime);
}

export type ImageAssetVariant = "original" | "thumb";

export type ImageAssetKeyParts = {
  orgId: string;
  spaceId: string;
  workspaceId: string;
  projectId: string;
  noteId: string;
  /** Defaults to `"original"` when building and is inferred from key shape when parsing. */
  variant?: ImageAssetVariant;
};

export function buildImageAssetKey(parts: ImageAssetKeyParts): string {
  const { orgId, spaceId, workspaceId, projectId, noteId } = parts;
  const variant: ImageAssetVariant = parts.variant ?? "original";
  if (!ORG_OR_SPACE_RE.test(orgId)) {
    throw new Error("Invalid orgId for asset key");
  }
  if (!ORG_OR_SPACE_RE.test(spaceId)) {
    throw new Error("Invalid spaceId for asset key");
  }
  if (!UUID_RE.test(workspaceId)) {
    throw new Error("Invalid workspaceId for asset key");
  }
  if (!UUID_RE.test(projectId)) {
    throw new Error("Invalid projectId for asset key");
  }
  if (!UUID_RE.test(noteId)) {
    throw new Error("Invalid noteId for asset key");
  }
  const base = `${orgId}/${spaceId}/${workspaceId}/${projectId}/${noteId}`;
  return variant === "thumb" ? `${base}/thumb` : base;
}

export function parseImageAssetKey(key: string): ImageAssetKeyParts | null {
  const segments = key.split("/");
  let variant: ImageAssetVariant = "original";
  let head = segments;
  if (segments.length === 6 && segments[5] === "thumb") {
    variant = "thumb";
    head = segments.slice(0, 5);
  } else if (segments.length !== 5) {
    return null;
  }
  const [orgId, spaceId, workspaceId, projectId, noteId] = head;
  if (!ORG_OR_SPACE_RE.test(orgId)) return null;
  if (!ORG_OR_SPACE_RE.test(spaceId)) return null;
  if (!UUID_RE.test(workspaceId)) return null;
  if (!UUID_RE.test(projectId)) return null;
  if (!UUID_RE.test(noteId)) return null;
  return { orgId, spaceId, workspaceId, projectId, noteId, variant };
}
