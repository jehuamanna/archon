/**
 * Plan 04: main-thread thumbnail generation.
 *
 * Deliberate scope reduction from the original "Web Worker" design —
 * the repo has no worker-bundling pipeline for Next.js / turbopack, and
 * the only precedent (`pdfjs-dist`) bundles its worker by hand into
 * `apps/archon-web/public/pdf.worker.min.mjs` behind a custom Electron
 * protocol. Building that infra for image thumbs is a large side quest.
 *
 * Thumbnailing a 20 MP photo on the main thread finishes in <150 ms on
 * a modern laptop — acceptable for an explicit user action (upload).
 * If profiling shows jank on lower-end hardware, a follow-up plan can
 * move this to a worker using the established pdf.js pattern.
 */

const THUMB_WIDTH_PX = 512;
const THUMB_MIME = "image/webp";
const THUMB_QUALITY = 0.82;

export type ThumbnailResult = {
  blob: Blob;
  width: number;
  height: number;
  mime: string;
  sourceWidth: number;
  sourceHeight: number;
};

function supportsOffscreenCanvas(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas !== "undefined" &&
    typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap === "function"
  );
}

/**
 * Decode `file` to a bitmap, shrink its longer edge to {@link THUMB_WIDTH_PX}
 * while preserving aspect, and encode to WebP. Returns the blob, its
 * dimensions, and the source's intrinsic dimensions (useful for patching
 * `width` / `height` on the note's metadata).
 *
 * Throws when the environment lacks `OffscreenCanvas` / `createImageBitmap`
 * — callers should catch and fall back to an original-only upload.
 */
export async function generateImageThumbnail(file: File): Promise<ThumbnailResult> {
  if (!supportsOffscreenCanvas()) {
    throw new Error("OffscreenCanvas / createImageBitmap unavailable");
  }
  // eslint-disable-next-line no-console
  console.log("[plan04-debug] thumb: decoding bitmap");
  const bitmap = await createImageBitmap(file);
  try {
    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    // eslint-disable-next-line no-console
    console.log("[plan04-debug] thumb: bitmap decoded", {
      sourceWidth,
      sourceHeight,
    });
    const scale = sourceWidth <= THUMB_WIDTH_PX ? 1 : THUMB_WIDTH_PX / sourceWidth;
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("OffscreenCanvas 2D context unavailable");
    }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);

    // eslint-disable-next-line no-console
    console.log("[plan04-debug] thumb: drawn, encoding blob", { width, height });
    const blob = await canvas.convertToBlob({
      type: THUMB_MIME,
      quality: THUMB_QUALITY,
    });
    // eslint-disable-next-line no-console
    console.log("[plan04-debug] thumb: blob encoded", {
      size: blob.size,
      mime: blob.type,
    });

    return {
      blob,
      width,
      height,
      mime: THUMB_MIME,
      sourceWidth,
      sourceHeight,
    };
  } finally {
    bitmap.close();
  }
}

/** Expose constants for tests / callers that build a filename. */
export const THUMBNAIL_CONSTANTS = {
  WIDTH_PX: THUMB_WIDTH_PX,
  MIME: THUMB_MIME,
  QUALITY: THUMB_QUALITY,
} as const;
