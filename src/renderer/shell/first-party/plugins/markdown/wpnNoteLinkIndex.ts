import { getArchon } from "../../../../../shared/archon-host-access";
import type { WpnNoteWithContextListItem } from "../../../../../shared/wpn-v2-types";

export type WpnNoteLinkRow = {
  noteId: string;
  title: string;
  workspaceName: string;
  projectName: string;
  /** `Workspace / Project / Note title` for list display and search */
  pathLabel: string;
};

function trimLabel(s: string, fallback: string): string {
  const t = s.trim();
  return t.length > 0 ? t : fallback;
}

function rowsFromBulk(notes: readonly WpnNoteWithContextListItem[]): WpnNoteLinkRow[] {
  const byId = new Map<string, WpnNoteWithContextListItem>();
  for (const n of notes) {
    byId.set(n.id, n);
  }

  function ancestorTitles(note: WpnNoteWithContextListItem): string[] {
    const titles: string[] = [];
    const seen = new Set<string>();
    let cur = note.parent_id;
    while (cur) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const parent = byId.get(cur);
      if (!parent) break;
      titles.push(trimLabel(parent.title, "Untitled"));
      cur = parent.parent_id;
    }
    titles.reverse();
    return titles;
  }

  return notes.map((n) => {
    const wsName = trimLabel(n.workspace_name, "Workspace");
    const projName = trimLabel(n.project_name, "Project");
    const title = trimLabel(n.title, "Untitled");
    const ancestors = ancestorTitles(n);
    const segments = [wsName, projName, ...ancestors, title];
    const pathLabel = segments.join(" / ");
    return {
      noteId: n.id,
      title,
      workspaceName: wsName,
      projectName: projName,
      pathLabel,
    };
  });
}

export type WpnNoteLinkIndexResult = {
  rows: WpnNoteLinkRow[];
  rawNotes: WpnNoteWithContextListItem[];
};

/**
 * Loads every WPN note (all workspaces and projects, including Documentation) for link insertion.
 * Uses `wpnListAllNotesWithContext` when available; falls back to nested list calls.
 */
export async function fetchWpnNoteLinkIndex(): Promise<WpnNoteLinkIndexResult> {
  const archon = typeof window !== "undefined" ? getArchon() : undefined;
  if (!archon?.wpnListWorkspaces) {
    return { rows: [], rawNotes: [] };
  }

  if (archon.wpnListAllNotesWithContext) {
    try {
      const res = await archon.wpnListAllNotesWithContext();
      const notes = Array.isArray(res?.notes) ? res.notes : [];
      return { rows: rowsFromBulk(notes), rawNotes: notes };
    } catch {
      /* fall through */
    }
  }

  let workspaces: { id: string; name: string }[] = [];
  try {
    const res = await archon.wpnListWorkspaces();
    workspaces = Array.isArray(res?.workspaces) ? res.workspaces : [];
  } catch {
    return { rows: [], rawNotes: [] };
  }

  const projectTasks: Promise<{
    workspace: { id: string; name: string };
    projects: { id: string; name: string }[];
  }>[] = workspaces.map(async (w) => {
    try {
      const { projects } = await archon.wpnListProjects(w.id);
      return { workspace: w, projects: Array.isArray(projects) ? projects : [] };
    } catch {
      return { workspace: w, projects: [] };
    }
  });

  const workspaceProjects = await Promise.all(projectTasks);

  const noteTasks: Promise<WpnNoteLinkRow[]>[] = [];
  for (const { workspace, projects } of workspaceProjects) {
    const wsName = trimLabel(workspace.name, "Workspace");
    for (const project of projects) {
      const projName = trimLabel(project.name, "Project");
      noteTasks.push(
        (async () => {
          try {
            const { notes } = await archon.wpnListNotes(project.id);
            const list = Array.isArray(notes) ? notes : [];
            return list.map((n) => {
              const title = trimLabel(n.title, "Untitled");
              const pathLabel = `${wsName} / ${projName} / ${title}`;
              return {
                noteId: n.id,
                title,
                workspaceName: wsName,
                projectName: projName,
                pathLabel,
              };
            });
          } catch {
            return [];
          }
        })(),
      );
    }
  }

  const chunks = await Promise.all(noteTasks);
  return { rows: chunks.flat(), rawNotes: [] };
}

export function filterWpnNoteLinkRows(rows: readonly WpnNoteLinkRow[], query: string): WpnNoteLinkRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter(
    (r) =>
      r.title.toLowerCase().includes(q) ||
      r.pathLabel.toLowerCase().includes(q) ||
      r.noteId.toLowerCase().includes(q),
  );
}
