/**
 * Shared types for the WPN bundle import/export ZIP format.
 *
 * Bundle layout inside the ZIP:
 *   metadata.json          — `WpnExportMetadata`, project-rooted (cloud)
 *                            or workspace-rooted (Electron file vault).
 *   notes/<noteId>.md      — markdown content per note.
 *   assets/<noteId>/<file> — image-asset bytes (v3 cloud only).
 *
 * Two formats co-exist:
 *
 *   • **Cloud (v3)** — project-rooted. Post-org/team migration the
 *     `Org → Space → Workspace → Project → Note` hierarchy collapsed to a
 *     single `team_projects` ↔ `notes` model, so workspaces aren't an
 *     entity. The cloud importer attaches each project to a caller-
 *     supplied `teamId` via `team_projects`. Sync-api accepts v3 only.
 *
 *   • **Electron file vault (v1)** — workspace-rooted. The local JSON
 *     vault still tracks workspaces as a top-level container; its
 *     bundle exports embed `workspaces[]` each carrying `projects[]`.
 *     Older v2 bundles (PLAN-06 image bytes, workspace-rooted) read the
 *     same workspace-rooted shape.
 *
 * The two formats are intentionally not interchangeable on the wire —
 * sync-api rejects v1/v2 with a version mismatch, and the file-vault
 * importer rejects v3 the same way.
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
 * File-vault workspace entry (v1/v2 bundles only). Wraps `WpnExportProjectEntry`
 * with a workspace identity so the workspace-rooted bundle round-trips
 * the local JSON vault's container layer. The cloud (v3) bundle has no
 * workspace level.
 */
export type WpnExportWorkspaceEntry = {
  id: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  projects: WpnExportProjectEntry[];
};

/**
 * Bundle format version.
 * - `1`: pre-PLAN-06. No `assets`. Workspace-rooted (file vault).
 * - `2`: PLAN-06 slice 4. Image-asset bytes alongside the manifest.
 *   Workspace-rooted (`metadata.workspaces[]`).
 * - `3`: post-org/team migration. Project-rooted (`metadata.projects[]`).
 *   Workspaces are gone from the cloud data model; the importer attaches
 *   each project to a caller-supplied `teamId` via `team_projects`.
 *
 * Sync-api accepts v3 only. The Electron file vault writes v1; legacy
 * v2 vault bundles read with the same workspace-rooted shape.
 */
export type WpnExportBundleVersion = 1 | 2 | 3;

export type WpnExportMetadata = {
  version: WpnExportBundleVersion;
  exported_at_ms: number;
  /** Cloud (v3) — project-rooted. */
  projects?: WpnExportProjectEntry[];
  /** File vault (v1/v2) — workspace-rooted. */
  workspaces?: WpnExportWorkspaceEntry[];
};

export type WpnImportResult = {
  /** v3 cloud import — only projects+notes are reported. */
  projects: number;
  notes: number;
  /** v1/v2 file-vault import — workspaces level is reported. */
  workspaces?: number;
};

/** Conflict policy when an imported project name collides with one already on the target team. */
export type WpnImportConflictPolicy = "skip" | "overwrite" | "rename";
