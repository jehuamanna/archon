/** Per-PDF saved places stored in host `localStorage` (keyed by workspace + asset path). */

export const PDF_BOOKMARKS_STORAGE_PREFIX = "archon.pdfBookmarks.v1:" as const;
export const MAX_PDF_BOOKMARKS_JSON_BYTES = 64_000;
export const MAX_PDF_BOOKMARKS_COUNT = 200;
export const MAX_PDF_BOOKMARK_LABEL_CHARS = 200;

export type PdfBookmarkRecord = {
  id: string;
  page: number;
  label: string;
  createdAt: number;
};

export function isSafePdfAssetRel(p: unknown): p is string {
  if (typeof p !== "string") {
    return false;
  }
  const t = p.trim();
  if (!t || t.length > 4096) {
    return false;
  }
  if (t.includes("..")) {
    return false;
  }
  if (t.startsWith("/") || t.startsWith("\\")) {
    return false;
  }
  return true;
}

export function pdfBookmarksStorageKey(
  projectRoot: string,
  assetRel: string,
): string {
  return `${PDF_BOOKMARKS_STORAGE_PREFIX}${encodeURIComponent(projectRoot)}:${encodeURIComponent(assetRel)}`;
}

function clampInt(n: unknown, min: number, max: number): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return null;
  }
  const x = Math.trunc(n);
  if (x < min || x > max) {
    return null;
  }
  return x;
}

function sanitizeLabel(s: unknown): string {
  if (typeof s !== "string") {
    return "";
  }
  const t = s.trim().slice(0, MAX_PDF_BOOKMARK_LABEL_CHARS);
  return t || "Page";
}

/** Parse and clamp bookmark list from JSON / unknown. */
export function normalizePdfBookmarksPayload(raw: unknown): PdfBookmarkRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: PdfBookmarkRecord[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const o = item as Record<string, unknown>;
    const id =
      typeof o.id === "string" && o.id.length > 0 && o.id.length < 120
        ? o.id
        : `b-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const page = clampInt(o.page, 1, 1_000_000);
    if (page == null) {
      continue;
    }
    const createdAt =
      typeof o.createdAt === "number" && Number.isFinite(o.createdAt)
        ? Math.trunc(o.createdAt)
        : Date.now();
    out.push({
      id,
      page,
      label: sanitizeLabel(o.label),
      createdAt,
    });
    if (out.length >= MAX_PDF_BOOKMARKS_COUNT) {
      break;
    }
  }
  return out;
}

export function serializePdfBookmarks(bookmarks: PdfBookmarkRecord[]): string {
  return JSON.stringify(bookmarks);
}

export function validatePdfBookmarksJsonSize(json: string): string | null {
  if (json.length > MAX_PDF_BOOKMARKS_JSON_BYTES) {
    return `Bookmarks data exceeds max size (${MAX_PDF_BOOKMARKS_JSON_BYTES} bytes)`;
  }
  return null;
}
