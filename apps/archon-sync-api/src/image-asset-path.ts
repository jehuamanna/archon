/**
 * R2 key + mime helpers for image notes.
 *
 * Key shapes (post-org/team migration):
 *   original: {orgId}/{projectId}/{noteId}
 *   thumb:    {orgId}/{projectId}/{noteId}/thumb
 *
 * The pre-migration shape interleaved `{spaceId}/{workspaceId}` between
 * org and project; both segments are gone with the schema flatten. The
 * key now mirrors the post-migration access tree
 * (org → project → note); per-team scoping is enforced at the route
 * layer via `assertCanRead/WriteProject`, not in the storage path.
 *
 * Original filename + extension are kept in `WpnImageNoteMetadata`,
 * not in the R2 key, so renames/extensions don't reshuffle storage.
 * The thumb variant uses an extra segment rather than a suffix so the
 * parser can distinguish without regex hacks.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG_ID_RE = /^[a-zA-Z0-9_-]+$/;

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
  projectId: string;
  noteId: string;
  /** Defaults to `"original"` when building and is inferred from key shape when parsing. */
  variant?: ImageAssetVariant;
};

export function buildImageAssetKey(parts: ImageAssetKeyParts): string {
  const { orgId, projectId, noteId } = parts;
  const variant: ImageAssetVariant = parts.variant ?? "original";
  if (!ORG_ID_RE.test(orgId)) {
    throw new Error("Invalid orgId for asset key");
  }
  if (!UUID_RE.test(projectId)) {
    throw new Error("Invalid projectId for asset key");
  }
  if (!UUID_RE.test(noteId)) {
    throw new Error("Invalid noteId for asset key");
  }
  const base = `${orgId}/${projectId}/${noteId}`;
  return variant === "thumb" ? `${base}/thumb` : base;
}

export function parseImageAssetKey(key: string): ImageAssetKeyParts | null {
  const segments = key.split("/");
  let variant: ImageAssetVariant = "original";
  let head = segments;
  if (segments.length === 4 && segments[3] === "thumb") {
    variant = "thumb";
    head = segments.slice(0, 3);
  } else if (segments.length !== 3) {
    return null;
  }
  const [orgId, projectId, noteId] = head;
  if (!ORG_ID_RE.test(orgId)) return null;
  if (!UUID_RE.test(projectId)) return null;
  if (!UUID_RE.test(noteId)) return null;
  return { orgId, projectId, noteId, variant };
}
