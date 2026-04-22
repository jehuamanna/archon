import type { WpnHttpClient } from "./wpn-client.js";
import type { WpnNoteWithContextRow } from "./wpn-client.js";
import { norm } from "./resolve-note.js";

/** RFC-style UUID v1–v5 (loose check for id vs name disambiguation). */
export function isLikelyUuid(s: string): boolean {
  const t = s.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(t);
}

export type ProjectPathRow = {
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  path: string;
};

export type WorkspaceRef = {
  workspaceId: string;
  workspaceName: string;
};

export type NotePathRow = {
  noteId: string;
  title: string;
  type: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  path: string;
};

type WsRow = { id: string; name?: string };
type ProjRow = { id: string; name?: string; workspace_id?: string };

export async function findProjectsByQuery(
  client: WpnHttpClient,
  query: string,
  workspaceQuery?: string,
): Promise<
  | { status: "none"; message: string }
  | { status: "workspace_ambiguous"; message: string; workspaces: WorkspaceRef[] }
  | { status: "ambiguous"; message: string; matches: ProjectPathRow[] }
  | { status: "unique"; matches: ProjectPathRow[] }
> {
  const q = query.trim();
  if (!q) {
    return { status: "none", message: "Empty query." };
  }

  const workspaces = (await client.getWorkspaces()) as WsRow[];
  let scopedWs = workspaces;

  if (workspaceQuery !== undefined && workspaceQuery.trim() !== "") {
    const wq = workspaceQuery.trim();
    if (isLikelyUuid(wq)) {
      scopedWs = workspaces.filter((w) => w.id === wq);
    } else {
      scopedWs = workspaces.filter((w) => norm(w.name ?? "") === norm(wq));
    }
    if (scopedWs.length === 0) {
      return {
        status: "none",
        message: `No workspace matched "${workspaceQuery}".`,
      };
    }
    if (scopedWs.length > 1) {
      return {
        status: "workspace_ambiguous",
        message:
          "Multiple workspaces match that name; pass workspace id or a more specific workspaceQuery.",
        workspaces: scopedWs.map((w) => ({
          workspaceId: w.id,
          workspaceName: w.name ?? "",
        })),
      };
    }
  }

  const flat: ProjectPathRow[] = [];
  for (const w of scopedWs) {
    const projects = (await client.getProjects(w.id)) as ProjRow[];
    const wname = w.name ?? "";
    for (const p of projects) {
      const pname = p.name ?? "";
      flat.push({
        projectId: p.id,
        projectName: pname,
        workspaceId: w.id,
        workspaceName: wname,
        path: `${wname} / ${pname}`,
      });
    }
  }

  let matches: ProjectPathRow[];
  if (isLikelyUuid(q)) {
    matches = flat.filter((r) => r.projectId === q);
  } else {
    matches = flat.filter((r) => norm(r.projectName) === norm(q));
  }

  if (matches.length === 0) {
    return {
      status: "none",
      message: isLikelyUuid(q)
        ? `No project with id "${q}".`
        : `No project named "${query}" in the selected scope.`,
    };
  }
  if (matches.length === 1) {
    return { status: "unique", matches };
  }
  return {
    status: "ambiguous",
    message:
      "Multiple projects match; each row includes projectId and path (Workspace / Project). Pick one id or narrow workspaceQuery.",
    matches,
  };
}

export function findNotesByQuery(
  rows: WpnNoteWithContextRow[],
  query: string,
  workspaceQuery?: string,
  projectQuery?: string,
):
  | { status: "none"; message: string }
  | { status: "workspace_ambiguous"; message: string; workspaces: WorkspaceRef[] }
  | { status: "project_ambiguous"; message: string; projects: { projectId: string; projectName: string; workspaceId: string; workspaceName: string; path: string }[] }
  | { status: "ambiguous"; message: string; matches: NotePathRow[] }
  | { status: "unique"; matches: NotePathRow[] } {
  const q = query.trim();
  if (!q) {
    return { status: "none", message: "Empty query." };
  }

  let filtered = rows;

  if (workspaceQuery !== undefined && workspaceQuery.trim() !== "") {
    const wq = workspaceQuery.trim();
    if (isLikelyUuid(wq)) {
      filtered = filtered.filter((r) => r.workspace_id === wq);
    } else {
      const wsMatches = new Map<string, string>();
      for (const r of filtered) {
        if (norm(r.workspace_name) === norm(wq)) {
          wsMatches.set(r.workspace_id, r.workspace_name);
        }
      }
      if (wsMatches.size > 1) {
        return {
          status: "workspace_ambiguous",
          message:
            "Multiple workspaces share that name; pass workspace id as workspaceQuery or disambiguate.",
          workspaces: [...wsMatches.entries()].map(([workspaceId, workspaceName]) => ({
            workspaceId,
            workspaceName,
          })),
        };
      }
      filtered = filtered.filter((r) => norm(r.workspace_name) === norm(wq));
    }
    if (filtered.length === 0) {
      return {
        status: "none",
        message: `No notes in a workspace matching "${workspaceQuery}".`,
      };
    }
  }

  if (projectQuery !== undefined && projectQuery.trim() !== "") {
    const pq = projectQuery.trim();
    if (isLikelyUuid(pq)) {
      filtered = filtered.filter((r) => r.project_id === pq);
    } else {
      const projBuckets = new Map<
        string,
        { projectId: string; projectName: string; workspaceId: string; workspaceName: string; path: string }
      >();
      for (const r of filtered) {
        if (norm(r.project_name) !== norm(pq)) {
          continue;
        }
        const k = `${r.workspace_id}\0${r.project_id}`;
        if (!projBuckets.has(k)) {
          const path = `${r.workspace_name} / ${r.project_name}`;
          projBuckets.set(k, {
            projectId: r.project_id,
            projectName: r.project_name,
            workspaceId: r.workspace_id,
            workspaceName: r.workspace_name,
            path,
          });
        }
      }
      if (projBuckets.size > 1) {
        return {
          status: "project_ambiguous",
          message:
            "Multiple projects match that name in scope; pass project id as projectQuery or narrow workspace.",
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
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    path: `${r.workspace_name} / ${r.project_name} / ${r.title}`,
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
      "Multiple notes match; each row includes noteId and path (Workspace / Project / Title). Pick one id or narrow filters.",
    matches: out,
  };
}
