/**
 * Versioned metadata shape for `type: "image"` notes (Plan 01 / Risk 1.3).
 *
 * Stored inside the existing `WpnNoteDoc.metadata` JSON field — no schema
 * migration. `metadataVersion` bumps on any breaking shape change so older
 * clients can detect-and-degrade rather than silently misread.
 */

export const IMAGE_NOTE_METADATA_VERSION = 1 as const;

export type WpnImageNoteMetadataV1 = {
  metadataVersion: 1;
  r2Key: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  originalFilename?: string;
  /**
   * Plan 04: R2 key of a small (typically 512 px wide WebP) thumbnail,
   * generated client-side on upload via `createImageBitmap` +
   * `OffscreenCanvas`. Inline markdown renders fetch this instead of
   * `r2Key` to keep preview bandwidth low. Absent on pre-Plan-04 notes;
   * renderers MUST fall back to `r2Key` when missing.
   */
  thumbKey?: string;
  thumbMime?: string;
  thumbSizeBytes?: number;
  /**
   * Plan 06 slice 1: short, semantic image description. Surfaces in the
   * inline-preview alt attribute, the MCP get_image_note metadata block,
   * and (slice 2) the explorer search filter. Absent on pre-Plan-06 notes.
   */
  altText?: string;
  /** Plan 06 slice 1: longer display caption. Siblings altText. */
  caption?: string;
};

export type WpnImageNoteMetadata = WpnImageNoteMetadataV1;

export function isImageNoteMetadata(
  m: Record<string, unknown> | null | undefined,
): m is WpnImageNoteMetadata {
  return (
    !!m &&
    (m as { metadataVersion?: unknown }).metadataVersion === 1 &&
    typeof (m as { r2Key?: unknown }).r2Key === "string" &&
    typeof (m as { mimeType?: unknown }).mimeType === "string" &&
    typeof (m as { sizeBytes?: unknown }).sizeBytes === "number"
  );
}
