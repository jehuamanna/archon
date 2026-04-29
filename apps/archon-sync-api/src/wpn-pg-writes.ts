/**
 * Postgres write helpers for projects + notes.
 *
 * STATUS: Migration stub. The pre-migration implementation (a 1,614-line
 * module of intricate tree-mutation logic with notify-fanout and
 * reconcileNoteEdges) is preserved in git history at commit 7691348^ and
 * earlier. Each exported function below throws a `NotPortedError` so any
 * accidental call surfaces immediately.
 *
 * Why a stub instead of a port? The 14 functions touch tree invariants
 * (parent/sibling reordering, subtree duplication, cross-project moves)
 * that need careful adaptation against the new schema:
 *
 *   - notes.parentId / projectId / siblingIndex / createdAtMs / updatedAtMs /
 *     createdByUserId / updatedByUserId are now camelCase TS fields
 *     (snake_case in PG).
 *   - notes/projects are single canonical rows; the (id, user_id) composite
 *     keys are gone. Callers no longer pass `userId`.
 *   - Project create needs an `orgId` parameter (no longer derivable from a
 *     workspace) and an optional `teamId` to attach the project to a team
 *     via team_projects on creation.
 *   - The pgWpnCreateWorkspace / pgWpnUpdateWorkspace / pgWpn*Workspace*
 *     functions are dropped entirely along with the workspaces table.
 *
 * The actual port is tracked as commit A1 of the migration. Until that
 * lands, project/note writes return 501 from the route layer.
 */

class NotPortedError extends Error {
  constructor(fnName: string) {
    super(
      `wpn-pg-writes.${fnName}: not yet ported to the post-migration schema. ` +
        `Tracked in the migration plan as commit A1.`,
    );
    this.name = "NotPortedError";
  }
}

// ---------- public surface (kept stable for wpn-write-routes imports) ----------

export const WPN_DUPLICATE_NOTE_TITLE_MESSAGE =
  "Note title already exists. Try a different title.";

export class WpnDuplicateSiblingTitleError extends Error {
  constructor() {
    super(WPN_DUPLICATE_NOTE_TITLE_MESSAGE);
    this.name = "WpnDuplicateSiblingTitleError";
  }
}

// ---------- projects ----------

export async function pgWpnCreateProject(
  orgId: string,
  name: string,
  opts?: { creatorUserId?: string; teamId?: string },
): Promise<unknown> {
  void orgId;
  void name;
  void opts;
  throw new NotPortedError("pgWpnCreateProject");
}

export async function pgWpnUpdateProject(
  id: string,
  patch: {
    name?: string;
    sortIndex?: number;
    colorToken?: string | null;
  },
): Promise<unknown> {
  void id;
  void patch;
  throw new NotPortedError("pgWpnUpdateProject");
}

export async function pgWpnDeleteProject(id: string): Promise<boolean> {
  void id;
  throw new NotPortedError("pgWpnDeleteProject");
}

export async function pgWpnDeleteProjects(
  ids: string[],
): Promise<{ deletedProjectIds: string[] }> {
  void ids;
  throw new NotPortedError("pgWpnDeleteProjects");
}

export async function pgWpnDuplicateProject(
  srcId: string,
  opts?: { creatorUserId?: string },
): Promise<unknown> {
  void srcId;
  void opts;
  throw new NotPortedError("pgWpnDuplicateProject");
}

export async function pgWpnGetProjectSettings(
  id: string,
): Promise<Record<string, unknown> | null> {
  void id;
  throw new NotPortedError("pgWpnGetProjectSettings");
}

export async function pgWpnPatchProjectSettings(
  id: string,
  settings: Record<string, unknown>,
): Promise<boolean> {
  void id;
  void settings;
  throw new NotPortedError("pgWpnPatchProjectSettings");
}

// ---------- notes ----------

export async function pgWpnCreateNote(
  projectId: string,
  payload: {
    anchorId?: string;
    relation: "child" | "sibling" | "root";
    type: string;
    content?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  },
  authorship?: { editorUserId?: string },
): Promise<{ id: string }> {
  void projectId;
  void payload;
  void authorship;
  throw new NotPortedError("pgWpnCreateNote");
}

export async function pgWpnUpdateNote(
  noteId: string,
  patch: {
    title?: string;
    content?: string;
    metadata?: Record<string, unknown> | null;
    type?: string;
  },
  authorship?: { editorUserId?: string },
): Promise<unknown> {
  void noteId;
  void patch;
  void authorship;
  throw new NotPortedError("pgWpnUpdateNote");
}

export async function pgWpnDeleteNotes(ids: string[]): Promise<void> {
  void ids;
  throw new NotPortedError("pgWpnDeleteNotes");
}

export async function pgWpnMoveNote(
  noteId: string,
  placement: import("./wpn-tree.js").NoteMovePlacement,
): Promise<unknown> {
  void noteId;
  void placement;
  throw new NotPortedError("pgWpnMoveNote");
}

export async function pgWpnMoveNoteToProject(
  noteId: string,
  targetProjectId: string,
  placement: import("./wpn-tree.js").NoteMovePlacement,
): Promise<unknown> {
  void noteId;
  void targetProjectId;
  void placement;
  throw new NotPortedError("pgWpnMoveNoteToProject");
}

export async function pgWpnDuplicateSubtree(
  rootNoteId: string,
  opts?: { editorUserId?: string },
): Promise<{ id: string }> {
  void rootNoteId;
  void opts;
  throw new NotPortedError("pgWpnDuplicateSubtree");
}

// ---------- explorer state ----------

export async function pgWpnSetExplorerExpanded(
  userId: string,
  projectId: string,
  expandedIds: string[],
): Promise<void> {
  void userId;
  void projectId;
  void expandedIds;
  throw new NotPortedError("pgWpnSetExplorerExpanded");
}
