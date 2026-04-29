import type { WpnHttpClient, WpnNoteWithContextRow, WpnProjectRow } from "./wpn-client.js";
import { norm } from "./resolve-note.js";

/** RFC-style UUID v1–v5 (loose check for id vs name disambiguation). */
export function isLikelyUuid(s: string): boolean {
  const t = s.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(t);
}

/**
 * Project hit shape post-migration. Workspaces are gone; the unique path
 * is just the project name within the active org.
 */
export type ProjectPathRow = {
  projectId: string;
  projectName: string;
  path: string;
};

/**
 * Note hit shape post-migration. The Org → Project → Note hierarchy means
 * the human-readable path is just `Project / Title`.
 */
export type NotePathRow = {
  noteId: string;
  title: string;
  type: string;
  projectId: string;
  projectName: string;
  path: string;
};

/**
 * Find project(s) by name or UUID within the active org. Project listing is
 * already org-scoped by the JWT, so no workspace/team filter is needed —
 * cross-org search is not supported (callers switch active org first).
 */
export async function findProjectsByQuery(
  client: WpnHttpClient,
  query: string,
): Promise<
  | { status: "none"; message: string }
  | { status: "ambiguous"; message: string; matches: ProjectPathRow[] }
  | { status: "unique"; matches: ProjectPathRow[] }
> {
  const q = query.trim();
  if (!q) {
    return { status: "none", message: "Empty query." };
  }

  const projects: WpnProjectRow[] = await client.listProjects();

  let matches: ProjectPathRow[];
  if (isLikelyUuid(q)) {
    matches = projects
      .filter((p) => p.id === q)
      .map((p) => ({ projectId: p.id, projectName: p.name, path: p.name }));
  } else {
    const nq = norm(q);
    matches = projects
      .filter((p) => norm(p.name) === nq)
      .map((p) => ({ projectId: p.id, projectName: p.name, path: p.name }));
  }

  if (matches.length === 0) {
    return {
      status: "none",
      message: isLikelyUuid(q)
        ? `No project with id "${q}" in the active org.`
        : `No project named "${query}" in the active org.`,
    };
  }
  if (matches.length === 1) {
    return { status: "unique", matches };
  }
  return {
    status: "ambiguous",
    message:
      "Multiple projects share that name in the active org; pick one by passing a UUID query.",
    matches,
  };
}

/**
 * Find note(s) by title or UUID using the cached `notes-with-context`
 * catalog. Optional `projectQuery` narrows by project name or UUID.
 */
export function findNotesByQuery(
  rows: WpnNoteWithContextRow[],
  query: string,
  projectQuery?: string,
):
  | { status: "none"; message: string }
  | {
      status: "project_ambiguous";
      message: string;
      projects: { projectId: string; projectName: string; path: string }[];
    }
  | { status: "ambiguous"; message: string; matches: NotePathRow[] }
  | { status: "unique"; matches: NotePathRow[] } {
  const q = query.trim();
  if (!q) {
    return { status: "none", message: "Empty query." };
  }

  let filtered = rows;

  if (projectQuery !== undefined && projectQuery.trim() !== "") {
    const pq = projectQuery.trim();
    if (isLikelyUuid(pq)) {
      filtered = filtered.filter((r) => r.project_id === pq);
    } else {
      const projBuckets = new Map<
        string,
        { projectId: string; projectName: string; path: string }
      >();
      for (const r of filtered) {
        if (norm(r.project_name) !== norm(pq)) {
          continue;
        }
        if (!projBuckets.has(r.project_id)) {
          projBuckets.set(r.project_id, {
            projectId: r.project_id,
            projectName: r.project_name,
            path: r.project_name,
          });
        }
      }
      if (projBuckets.size > 1) {
        return {
          status: "project_ambiguous",
          message:
            "Multiple projects share that name in the active org; pass project id as projectQuery.",
          projects: [...projBuckets.values()],
        };
      }
      filtered = filtered.filter((r) => norm(r.project_name) === norm(pq));
    }
    if (filtered.length === 0) {
      return {
        status: "none",
        message: `No notes in a project matching "${projectQuery}" in the current scope.`,
      };
    }
  }

  let matches: WpnNoteWithContextRow[];
  if (isLikelyUuid(q)) {
    matches = filtered.filter((r) => r.id === q);
  } else {
    matches = filtered.filter((r) => norm(r.title) === norm(q));
  }

  const out: NotePathRow[] = matches.map((r) => ({
    noteId: r.id,
    title: r.title,
    type: r.type,
    projectId: r.project_id,
    projectName: r.project_name,
    path: `${r.project_name} / ${r.title}`,
  }));

  if (out.length === 0) {
    return {
      status: "none",
      message: isLikelyUuid(q)
        ? `No note with id "${q}" in the selected scope.`
        : `No note titled "${query}" in the selected scope.`,
    };
  }
  if (out.length === 1) {
    return { status: "unique", matches: out };
  }
  return {
    status: "ambiguous",
    message:
      "Multiple notes match; each row includes noteId and path (Project / Title). Pick one id or narrow projectQuery.",
    matches: out,
  };
}
