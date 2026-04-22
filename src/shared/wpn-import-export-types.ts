/** Shared types for WPN workspace import/export ZIP format. */

/**
 * PLAN-06 slice 4: image-asset payload recorded alongside each image note.
 * The `zipPath` points inside the ZIP at a binary file (typically
 * `assets/<noteId>/<filename>`) whose bytes are the original-resolution
 * image that originally lived in R2. Thumbnails are NOT exported —
 * the import pipeline re-generates them client-side on first open.
 * Absent from every v1 bundle and from every v2 non-image note.
 */
export type WpnExportAssetEntry = {
  /** Path inside the ZIP archive. Forward slashes, no leading slash. */
  zipPath: string;
  /** MIME type of the byte payload (e.g. `image/png`). */
  mimeType: string;
  /** Byte length as stored in the ZIP. */
  sizeBytes: number;
  /** Original filename (for restoring the `originalFilename` metadata field). */
  originalFilename?: string;
};

export type WpnExportNoteEntry = {
  id: string;
  parent_id: string | null;
  type: string;
  title: string;
  sibling_index: number;
  metadata: Record<string, unknown> | null;
  /** PLAN-06 slice 4 (v2+). Present only on image notes whose bytes are bundled. */
  assets?: WpnExportAssetEntry[];
};

export type WpnExportProjectEntry = {
  id: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  notes: WpnExportNoteEntry[];
};

export type WpnExportWorkspaceEntry = {
  id: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  projects: WpnExportProjectEntry[];
};

/**
 * Bundle format version.
 * - `1`: pre-PLAN-06. No `assets`. Image notes referenced R2 keys that
 *   only the exporter could read. Importing a v1 bundle silently produces
 *   broken image notes for cross-workspace moves.
 * - `2`: PLAN-06 slice 4. Image notes ship their bytes alongside the manifest.
 */
export type WpnExportBundleVersion = 1 | 2;

export type WpnExportMetadata = {
  version: WpnExportBundleVersion;
  exported_at_ms: number;
  workspaces: WpnExportWorkspaceEntry[];
};

export type WpnImportResult = {
  workspaces: number;
  projects: number;
  notes: number;
};

/** Conflict policy when an imported workspace name collides with an existing one. */
export type WpnImportConflictPolicy = "skip" | "overwrite" | "rename";
