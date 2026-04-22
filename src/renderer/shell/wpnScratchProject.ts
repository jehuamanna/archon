import { getArchon } from "../../shared/archon-host-access";
import { getAccessToken } from "../auth/auth-session";
import { isWebScratchSession } from "../auth/web-scratch";
import { syncWpnNotesBackend } from "../archon-web-shim";
import { scratchWpnProjectExists } from "../wpnscratch/wpn-scratch-store";
import {
  computeNextScratchNoteTitle,
  SCRATCH_NOTE_BASE_TITLE,
} from "./scratch-buffer-titles";

/**
 * Remembers the last WPN project the user had open in the explorer so shell commands
 * (e.g. Scratch) can create a root note without a flat legacy `createNote` API.
 */
export const ARCHON_LAST_WPN_PROJECT_ID_SESSION_KEY = "archon-last-wpn-project-id";

/** Default WPN container for scratch notes when no explorer project is remembered. */
export const SCRATCH_WORKSPACE_NAME = "Scratch";
export const SCRATCH_PROJECT_NAME = "Scratch";

export function rememberWpnProjectIdForScratch(projectId: string | null): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  try {
    if (projectId && projectId.trim()) {
      sessionStorage.setItem(ARCHON_LAST_WPN_PROJECT_ID_SESSION_KEY, projectId.trim());
    }
  } catch {
    /* quota / private mode */
  }
}

export function clearRememberedWpnProjectId(): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  try {
    sessionStorage.removeItem(ARCHON_LAST_WPN_PROJECT_ID_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** True when the project exists in the current WPN store (sync, file vault, or IDB scratch). */
export async function wpnProjectIdExists(projectId: string): Promise<boolean> {
  const id = projectId.trim();
  if (!id) {
    return false;
  }
  if (isWebScratchSession()) {
    try {
      if (await scratchWpnProjectExists(id)) {
        return true;
      }
    } catch {
      /* ignore */
    }
    if (!getAccessToken()) {
      return false;
    }
  }
  try {
    await getArchon().wpnListNotes(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `wpnListWorkspaces` works (browser scratch store, sync API, or headless with auth).
 */
export async function wpnNotesApiAvailable(): Promise<boolean> {
  try {
    await getArchon().wpnListWorkspaces();
    return true;
  } catch {
    return false;
  }
}

export async function scratchNotesUseWpnPath(): Promise<boolean> {
  return syncWpnNotesBackend() || (await wpnNotesApiAvailable());
}

/** Last project id the user selected in the Notes explorer, if it still exists in the WPN store. */
export async function getValidRememberedWpnProjectId(): Promise<string | null> {
  if (typeof window === "undefined" || !window.Archon) {
    return null;
  }
  try {
    const sid =
      typeof sessionStorage !== "undefined"
        ? sessionStorage.getItem(ARCHON_LAST_WPN_PROJECT_ID_SESSION_KEY)?.trim()
        : "";
    if (!sid) {
      return null;
    }
    if (await wpnProjectIdExists(sid)) {
      return sid;
    }
    clearRememberedWpnProjectId();
    return null;
  } catch {
    return null;
  }
}

/**
 * Prefer last-selected project from the WPN explorer if it still exists; otherwise first project
 * in the first workspace.
 */
export async function resolveWpnProjectIdForRootNote(): Promise<string | null> {
  const remembered = await getValidRememberedWpnProjectId();
  if (remembered) {
    return remembered;
  }
  if (typeof window === "undefined" || !window.Archon) {
    return null;
  }
  try {
    const { workspaces } = await getArchon().wpnListWorkspaces();
    const w = workspaces?.[0];
    if (!w) {
      return null;
    }
    const { projects } = await getArchon().wpnListProjects(w.id);
    return projects?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function findOrCreateScratchBucketProjectId(): Promise<string> {
  const { workspaces } = await getArchon().wpnListWorkspaces();
  const w = workspaces.find((x) => x.name === SCRATCH_WORKSPACE_NAME);
  if (w) {
    const { projects } = await getArchon().wpnListProjects(w.id);
    const p = projects.find((x) => x.name === SCRATCH_PROJECT_NAME);
    if (p) {
      return p.id;
    }
    const { project } = await getArchon().wpnCreateProject(w.id, SCRATCH_PROJECT_NAME);
    return project.id;
  }
  const { workspace } = await getArchon().wpnCreateWorkspace(SCRATCH_WORKSPACE_NAME);
  const { project } = await getArchon().wpnCreateProject(workspace.id, SCRATCH_PROJECT_NAME);
  return project.id;
}

/**
 * Explorer-selected project if remembered and still valid; otherwise the dedicated Scratch / Scratch
 * WPN project (created when missing). Does not fall back to “first workspace’s first project”.
 */
export async function ensureScratchMarkdownProjectId(): Promise<string> {
  const remembered = await getValidRememberedWpnProjectId();
  if (remembered) {
    return remembered;
  }
  return findOrCreateScratchBucketProjectId();
}

/** Root note in `projectId` whose title equals `title` (trimmed, exact). */
export async function findRootNoteIdWithTitle(
  projectId: string,
  title: string,
): Promise<string | null> {
  const { notes } = await getArchon().wpnListNotes(projectId);
  const row = notes.find(
    (n) => n.parent_id === null && n.title.trim() === title,
  );
  return row?.id ?? null;
}

/** Root markdown note with title matching `title` case-insensitively (first match wins). */
export async function findRootMarkdownNoteIdWithTitleCaseInsensitive(
  projectId: string,
  title: string,
): Promise<string | null> {
  const needle = title.trim().toLowerCase();
  if (!needle) {
    return null;
  }
  const { notes } = await getArchon().wpnListNotes(projectId);
  const row = notes.find(
    (n) =>
      n.parent_id === null &&
      n.type === "markdown" &&
      n.title.trim().toLowerCase() === needle,
  );
  return row?.id ?? null;
}

export { computeNextScratchNoteTitle, SCRATCH_NOTE_BASE_TITLE };

/** Next root markdown scratch title in `projectId` (per-type sibling rules). */
export async function nextScratchBufferTitle(projectId: string): Promise<string> {
  const { notes } = await getArchon().wpnListNotes(projectId);
  const siblings = notes.map((n) => ({
    title: n.title,
    type: n.type,
    parentId: n.parent_id,
  }));
  return computeNextScratchNoteTitle("markdown", null, siblings);
}

/** Legacy flat list: next root markdown scratch title (same sibling rules as WPN). */
export async function nextScratchMarkdownTitleFromFlatList(): Promise<string> {
  const list = await getArchon().getAllNotes();
  const siblings = list.map((n) => ({
    title: n.title,
    type: n.type,
    parentId: n.parentId,
  }));
  return computeNextScratchNoteTitle("markdown", null, siblings);
}

/** Legacy flat list: id of root markdown note with title (case-insensitive), if any. */
export async function findFlatRootMarkdownNoteIdWithTitleCaseInsensitive(
  title: string,
): Promise<string | null> {
  const needle = title.trim().toLowerCase();
  if (!needle) {
    return null;
  }
  const list = await getArchon().getAllNotes();
  const row = list.find(
    (n) =>
      n.type === "markdown" &&
      n.parentId === null &&
      n.title.trim().toLowerCase() === needle,
  );
  return row?.id ?? null;
}
