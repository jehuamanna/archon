/**
 * Shared types for the WPN bundle import/export ZIP format.
 *
 * Bundle layout inside the ZIP:
 *   metadata.json          — `WpnExportMetadata`, project-rooted manifest.
 *   notes/<noteId>.md      — markdown content per note.
 *   assets/<noteId>/<file> — image-asset bytes (v3+, when bundled).
 *
 * Post-migration the manifest is project-rooted: the legacy
 * `Org → Space → Workspace → Project → Note` hierarchy collapsed to a
 * single `team_projects` ↔ `notes` model, so workspaces are no longer
 * an entity. Older bundles (v1 = pre-PLAN-06, v2 = PLAN-06 image-bytes,
 * both workspace-rooted) are rejected on import with a versioned error.
 */

/**
 * PLAN-06 slice 4: image-asset payload recorded alongside each image note.
 * The `zipPath` points inside the ZIP at a binary file (typically
 * `assets/<noteId>/<filename>`) whose bytes are the original-resolution
 * image that originally lived in R2. Thumbnails are NOT exported —
 * the import pipeline re-generates them client-side on first open.
 * Absent from every v1 bundle and from every v2 / v3 non-image note.
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

/**
 * Bundle format version.
 * - `1`: pre-PLAN-06. No `assets`. Workspace-rooted.
 * - `2`: PLAN-06 slice 4. Image-asset bytes alongside the manifest.
 *   Workspace-rooted (`metadata.workspaces[]`).
 * - `3`: post-org/team migration. Project-rooted (`metadata.projects[]`).
 *   Workspaces are gone from the data model; the importer attaches
 *   each project to a caller-supplied `teamId` via `team_projects`.
 *
 * The shape on the wire is `3` only — `1` and `2` bundles are rejected on
 * import with a clear version mismatch.
 */
export type WpnExportBundleVersion = 3;

export type WpnExportMetadata = {
  version: WpnExportBundleVersion;
  exported_at_ms: number;
  projects: WpnExportProjectEntry[];
};

export type WpnImportResult = {
  projects: number;
  notes: number;
};

/** Conflict policy when an imported project name collides with one already on the target team. */
export type WpnImportConflictPolicy = "skip" | "overwrite" | "rename";
