/**
 * Project → note DTOs for HTTP responses, Postgres rows (post-migration),
 * IPC, and frontend store rows.
 *
 * Workspaces are gone with the org/team migration. Visibility ("public" /
 * "private" / "shared") is gone too — project access flows through
 * team_projects + team_memberships, not per-row visibility.
 *
 * The file path keeps its `wpn-v2-types` name for stable imports across
 * the frontend; the contents reflect the current model.
 */

/** Single canonical row per project. */
export type ProjectRow = {
  id: string;
  org_id: string;
  /** First user to create the project. Used for advisory display only;
   * access is determined by team_projects, not creator. */
  creator_user_id: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

export type ProjectPatch = {
  name?: string;
  sort_index?: number;
  color_token?: string | null;
};

/**
 * A team grant on a project. The user's effective role is the strongest of
 * (owner > contributor > viewer) across teams they're on that share the
 * project.
 */
export type TeamProjectRow = {
  team_id: string;
  project_id: string;
  role: "owner" | "contributor" | "viewer";
  granted_at: string;
};

export type DepartmentRow = {
  id: string;
  org_id: string;
  name: string;
  color_token: string | null;
  created_at: string;
};

export type TeamRow = {
  id: string;
  org_id: string;
  department_id: string;
  name: string;
  color_token: string | null;
  created_at: string;
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
 * Compact metadata slice for client-side search; present only on image
 * notes that set altText or caption (absent when empty, to keep list
 * payloads tight).
 */
export type WpnNoteSearchHints = {
  altText?: string;
  caption?: string;
};

/** Flat preorder row for the explorer (includes depth). */
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

/**
 * Flat row for cross-project note listing (link picker, bulk load). The
 * pre-migration version included workspace_id / workspace_name; those are
 * gone with the workspaces table.
 */
export type WpnNoteWithContextListItem = {
  id: string;
  title: string;
  type: string;
  project_id: string;
  project_name: string;
  parent_id: string | null;
};

/** Note that links to the target note id in markdown content. */
export type WpnBacklinkSourceItem = {
  id: string;
  title: string;
  project_id: string;
};

export const WPN_SCHEMA_VERSION = 2;
