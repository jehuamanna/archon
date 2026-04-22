import { createSyncBaseUrlResolver } from "@archon/platform";
import { getArchon } from "../../../../../shared/archon-host-access";
import type { Note } from "@archon/ui-types";

const resolveSyncApiBaseForBundled = createSyncBaseUrlResolver();

export type BundledGuideIndexEntry = { id: string; title: string; section: string };

/**
 * Lists bundled guide ids/titles from sync-api (web: WPN has no seeded Documentation project).
 */
export async function fetchBundledGuideIndexFromSyncPublic(): Promise<BundledGuideIndexEntry[]> {
  const base = resolveSyncApiBaseForBundled().trim().replace(/\/$/, "");
  if (!base) {
    return [];
  }
  try {
    const url = `${base}/public/bundled-docs/guide-index`;
    const res = await fetch(url);
    if (!res.ok) {
      return [];
    }
    const j = (await res.json()) as {
      guides?: Array<{ id?: string; title?: string; section?: string }>;
    };
    const guides = j.guides;
    if (!Array.isArray(guides)) {
      return [];
    }
    return guides
      .filter((g) => typeof g?.id === "string" && typeof g?.title === "string")
      .map((g) => ({
        id: g.id as string,
        title: g.title as string,
        section: typeof g.section === "string" && g.section.trim() ? g.section : "Guides",
      }));
  } catch {
    return [];
  }
}

async function fetchBundledDocFromSyncPublic(logicalId: string): Promise<Note | null> {
  const base = resolveSyncApiBaseForBundled().trim().replace(/\/$/, "");
  if (!base) {
    return null;
  }
  try {
    const url = `${base}/public/bundled-docs/notes/${encodeURIComponent(logicalId)}`;
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    const j = (await res.json()) as { note?: Note };
    if (j.note && typeof (j.note as { id?: unknown }).id === "string") {
      return j.note as Note;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Loads a bundled documentation note by logical id: tries legacy notes first, then
 * sync-api public `/public/bundled-docs/notes/:id` (web / no local seed), then
 * `wpn-docs:{workspaceId}:{logicalId}` in the first WPN workspace.
 */
export async function fetchBundledDocumentationNote(logicalId: string): Promise<Note> {
  try {
    const n = await getArchon().getNote(logicalId);
    if (n && typeof (n as { id?: unknown }).id === "string") {
      return n as unknown as Note;
    }
  } catch {
    /* try sync public / WPN composite id */
  }

  const fromSyncPublic = await fetchBundledDocFromSyncPublic(logicalId);
  if (fromSyncPublic) {
    return fromSyncPublic;
  }

  const { workspaces } = await getArchon().wpnListWorkspaces();
  const ws0 = workspaces[0];
  if (!ws0) {
    throw new Error("No workspace available to load bundled documentation.");
  }
  const noteId = `wpn-docs:${ws0.id}:${logicalId}`;
  const r = await getArchon().wpnGetNote(noteId);
  return r.note as unknown as Note;
}
