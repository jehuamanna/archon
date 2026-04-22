/** Workspace → project → note (v2) — DTOs for JSON workspace, Postgres, HTTP, and IPC. */

/** Phase 4/8 visibility applied to both workspaces and projects. */
export type WpnVisibility = "public" | "private" | "shared";

export type WpnWorkspaceRow = {
  id: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  /** Phase 4: visibility within the space. Undefined on legacy rows — treat as "public". */
  visibility?: WpnVisibility;
  /** Phase 4: original creator (for `private` and `shared` access checks). */
  creatorUserId?: string;
};

export type WpnProjectRow = {
  id: string;
  workspace_id: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  /** Phase 8: visibility within the parent workspace. */
  visibility?: WpnVisibility;
  /** Phase 8: original creator. */
  creatorUserId?: string;
};

export type WpnNoteRow = {
  id: string;
  project_id: string;
  parent_id: string | null;
  type: string;
  title: string;
  content: string;
  metadata_json: string | null;
  sibling_index: number;
  created_at_ms: number;
  updated_at_ms: number;
};

/**
 * PLAN-06 slice 2: compact metadata slice for client-side search, present
 * only on image notes that set altText or caption (absent when empty, not
 * `{}`, to keep list payloads tight).
 */
export type WpnNoteSearchHints = {
  altText?: string;
  caption?: string;
};

/** Flat preorder row for explorer (includes depth). */
export type WpnNoteListItem = {
  id: string;
  project_id: string;
  parent_id: string | null;
  type: string;
  title: string;
  depth: number;
  sibling_index: number;
  search_hints?: WpnNoteSearchHints;
};

export type WpnNoteDetail = {
  id: string;
  project_id: string;
  parent_id: string | null;
  type: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  sibling_index: number;
  created_at_ms: number;
  updated_at_ms: number;
  canWrite?: boolean;
};

/** Flat row for cross-project note listing (link picker, bulk load). */
export type WpnNoteWithContextListItem = {
  id: string;
  title: string;
  type: string;
  project_id: string;
  project_name: string;
  workspace_id: string;
  workspace_name: string;
  parent_id: string | null;
};

/** Note that links to the target note id in markdown content. */
export type WpnBacklinkSourceItem = {
  id: string;
  title: string;
  project_id: string;
};

export const WPN_SCHEMA_VERSION = 1;

export type WpnWorkspacePatch = {
  name?: string;
  sort_index?: number;
  color_token?: string | null;
};

export type WpnProjectPatch = WpnWorkspacePatch & {
  workspace_id?: string;
};
