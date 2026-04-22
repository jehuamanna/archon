import type { WpnNoteWithContextRow } from "./wpn-client.js";

export function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export type ResolveNoteInput = {
  workspaceName: string;
  projectName: string;
  noteTitle: string;
};

export type ResolveNoteOk = {
  ok: true;
  noteId: string;
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectName: string;
  title: string;
  type: string;
};

export type ResolveNoteAmbiguous = {
  ok: false;
  reason: "none" | "ambiguous";
  candidates: {
    noteId: string;
    workspaceName: string;
    projectName: string;
    title: string;
  }[];
};

export type ResolveNoteResult = ResolveNoteOk | ResolveNoteAmbiguous;

/**
 * Match workspace, project, and note title using trim + case-insensitive comparison
 * (Unicode case-folding via `toLowerCase()`).
 */
export function resolveNoteFromCatalog(
  rows: WpnNoteWithContextRow[],
  input: ResolveNoteInput,
): ResolveNoteResult {
  const wn = norm(input.workspaceName);
  const pn = norm(input.projectName);
  const tn = norm(input.noteTitle);
  const matches = rows.filter(
    (r) =>
      norm(r.workspace_name) === wn &&
      norm(r.project_name) === pn &&
      norm(r.title) === tn,
  );
  if (matches.length === 0) {
    return { ok: false, reason: "none", candidates: [] };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      candidates: matches.map((r) => ({
        noteId: r.id,
        workspaceName: r.workspace_name,
        projectName: r.project_name,
        title: r.title,
      })),
    };
  }
  const r = matches[0]!;
  return {
    ok: true,
    noteId: r.id,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    projectId: r.project_id,
    projectName: r.project_name,
    title: r.title,
    type: r.type,
  };
}
