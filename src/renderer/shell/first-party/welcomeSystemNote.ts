import { getArchon } from "../../../shared/archon-host-access";

/**
 * Per-org welcome content lives at this canonical path. Lazy-bootstrapped on
 * first admin save — no migration. The `__system` prefix is the existing
 * convention for non-user-content infrastructure (mirrors `__pushbutton_*`,
 * `__slideshow_*` stateKeys in the MDX SDK runtime).
 */
export const WELCOME_SYSTEM_WORKSPACE = "__system";
export const WELCOME_SYSTEM_PROJECT = "Welcome";
export const WELCOME_SYSTEM_TITLE = "Welcome";
export const WELCOME_SYSTEM_NOTE_TYPE = "mdx";

export type WelcomeNoteRow = {
  noteId: string;
  workspaceId: string;
  projectId: string;
  content: string;
};

const WELCOME_SYSTEM_NOTE_CHANGED_EVENT = "archon:welcome-system-note-changed";

/**
 * Cache keyed by org id. `null` means "looked up, doesn't exist." Allows
 * Welcome view to avoid refetching per render. Invalidated on save and
 * on org switch (the view passes `activeOrgId` in its effect deps).
 */
const cache = new Map<string, WelcomeNoteRow | null>();

/**
 * Drop the cached row for an org (or all orgs). Use before refetching when
 * you need to bypass the in-memory cache — e.g. just before the editor
 * opens, so the draft starts from the freshest server content rather than
 * whatever React state had captured.
 */
export function invalidateWelcomeCache(orgId?: string | null): void {
  if (orgId === undefined) {
    cache.clear();
    return;
  }
  cache.delete(orgId ?? "<none>");
}

export function subscribeWelcomeSystemNoteChanged(
  fn: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (): void => fn();
  window.addEventListener(WELCOME_SYSTEM_NOTE_CHANGED_EVENT, listener);
  return () =>
    window.removeEventListener(WELCOME_SYSTEM_NOTE_CHANGED_EVENT, listener);
}

function emitChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(WELCOME_SYSTEM_NOTE_CHANGED_EVENT));
}

/**
 * Resolves the welcome-note row for the active org (the wpn endpoints are
 * auth-scoped server-side, so no explicit org id is needed). Returns null
 * when the note hasn't been created yet — callers fall back to the bundled
 * default in that case. `orgId` is used purely as a cache key.
 */
export async function findWelcomeNoteForActiveOrg(
  orgId: string | null | undefined,
): Promise<WelcomeNoteRow | null> {
  const key = orgId ?? "<none>";
  if (cache.has(key)) return cache.get(key) ?? null;

  try {
    const { notes } = await getArchon().wpnListAllNotesWithContext();
    const hit = notes.find(
      (n) =>
        n.workspace_name === WELCOME_SYSTEM_WORKSPACE &&
        n.project_name === WELCOME_SYSTEM_PROJECT &&
        n.title === WELCOME_SYSTEM_TITLE &&
        n.type === WELCOME_SYSTEM_NOTE_TYPE,
    );
    if (!hit) {
      cache.set(key, null);
      return null;
    }
    // Fetch full content (the listing endpoint omits it).
    const { note } = await getArchon().wpnGetNote(hit.id);
    const row: WelcomeNoteRow = {
      noteId: note.id,
      workspaceId: hit.workspace_id ?? "",
      projectId: hit.project_id,
      content: note.content ?? "",
    };
    cache.set(key, row);
    return row;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[welcome-system-note] find failed:", e);
    cache.set(key, null);
    return null;
  }
}

/**
 * Save welcome MDX content for the active org. Bootstraps `__system`
 * workspace, `Welcome` project, and `Welcome` note on first call;
 * subsequent calls update the existing note's content.
 */
export async function saveWelcomeNote(
  orgId: string | null | undefined,
  content: string,
): Promise<WelcomeNoteRow> {
  const key = orgId ?? "<none>";
  const archon = getArchon();
  // Always re-resolve here in case another tab created the note since our
  // cached lookup. Bypass the in-memory cache for the read.
  const { notes } = await archon.wpnListAllNotesWithContext();
  const existing = notes.find(
    (n) =>
      n.workspace_name === WELCOME_SYSTEM_WORKSPACE &&
      n.project_name === WELCOME_SYSTEM_PROJECT &&
      n.title === WELCOME_SYSTEM_TITLE &&
      n.type === WELCOME_SYSTEM_NOTE_TYPE,
  );

  if (existing) {
    await archon.saveNoteContent(existing.id, content);
    const row: WelcomeNoteRow = {
      noteId: existing.id,
      workspaceId: existing.workspace_id ?? "",
      projectId: existing.project_id,
      content,
    };
    cache.set(key, row);
    emitChanged();
    return row;
  }

  // Bootstrap: workspace → project → note.
  const { workspaces, projects } = await archon.wpnListWorkspacesAndProjects();
  let workspace = workspaces.find((w) => w.name === WELCOME_SYSTEM_WORKSPACE);
  if (!workspace) {
    const created = await archon.wpnCreateWorkspace(WELCOME_SYSTEM_WORKSPACE);
    workspace = created.workspace;
  }
  const workspaceId = workspace.id;

  let project = projects.find(
    (p) => p.workspace_id === workspaceId && p.name === WELCOME_SYSTEM_PROJECT,
  );
  if (!project) {
    const created = await archon.wpnCreateProject(
      workspaceId,
      WELCOME_SYSTEM_PROJECT,
    );
    project = created.project;
  }
  const projectId = project.id;

  const created = await archon.wpnCreateNoteInProject(projectId, {
    relation: "root",
    type: WELCOME_SYSTEM_NOTE_TYPE,
    title: WELCOME_SYSTEM_TITLE,
    content,
  });

  const row: WelcomeNoteRow = {
    noteId: created.id,
    workspaceId,
    projectId,
    content,
  };
  cache.set(key, row);
  emitChanged();
  return row;
}
