/** Categories for filtering project assets in media note plugins. */
export type AssetMediaCategory = "pdf" | "image" | "video" | "audio";

export const MEDIA_EXTENSIONS: Record<AssetMediaCategory, readonly string[]> = {
  pdf: ["pdf"],
  image: [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "bmp",
    "ico",
    "avif",
    "heic",
    "heif",
    "tif",
    "tiff",
  ],
  video: [
    "mp4",
    "webm",
    "ogg",
    "ogv",
    "mov",
    "m4v",
    "mkv",
    "avi",
    "wmv",
  ],
  audio: ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba"],
};

const extSet = (cat: AssetMediaCategory): Set<string> =>
  new Set(MEDIA_EXTENSIONS[cat].map((x) => x.toLowerCase()));

export function extMatchesCategory(
  ext: string,
  category: AssetMediaCategory,
): boolean {
  const e = ext.replace(/^\./, "").toLowerCase();
  return extSet(category).has(e);
}

export function isAssetMediaCategory(s: unknown): s is AssetMediaCategory {
  return s === "pdf" || s === "image" || s === "video" || s === "audio";
}

/** Map `assets/` file name to note type, or null if not a known media asset. */
export function noteTypeFromAssetFilename(
  fileName: string,
): "pdf" | "image" | "video" | "audio" | null {
  const i = fileName.lastIndexOf(".");
  const ext = i >= 0 ? fileName.slice(i + 1).toLowerCase() : "";
  if (!ext) {
    return null;
  }
  if (extMatchesCategory(ext, "pdf")) {
    return "pdf";
  }
  if (extMatchesCategory(ext, "image")) {
    return "image";
  }
  if (extMatchesCategory(ext, "video")) {
    return "video";
  }
  if (extMatchesCategory(ext, "audio")) {
    return "audio";
  }
  return null;
}
