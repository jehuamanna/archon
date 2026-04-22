import * as crypto from "crypto";
import type { WorkspaceStore, WpnWorkspaceStored } from "../workspace-store";
import type { WpnNoteListItem } from "../../shared/wpn-v2-types";
import type { WpnProjectRow, WpnWorkspaceRow } from "./wpn-types";

function nowMs(): number {
  return Date.now();
}

function newId(): string {
  return crypto.randomUUID();
}

function persist(store: WorkspaceStore): void {
  store.persist();
}

export function wpnJsonListWorkspaces(
  store: WorkspaceStore,
  ownerId: string,
): WpnWorkspaceRow[] {
  const out: WpnWorkspaceRow[] = [];
  for (const slot of store.slots) {
    for (const w of slot.workspaces) {
      if (w.owner_id === ownerId) {
        const { owner_id: _o, ...row } = w;
        out.push(row);
      }
    }
  }
  out.sort((a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name));
  return out;
}

export function wpnJsonCreateWorkspace(
  store: WorkspaceStore,
  ownerId: string,
  name: string,
): WpnWorkspaceRow {
  const slot = store.slots[0]!;
  const id = newId();
  const t = nowMs();
  const maxSort = slot.workspaces
    .filter((w) => w.owner_id === ownerId)
    .reduce((m, w) => Math.max(m, w.sort_index), -1);
  const sort_index = maxSort + 1;
  const row: WpnWorkspaceStored = {
    id,
    name: name.trim() || "Workspace",
    sort_index,
    color_token: null,
    created_at_ms: t,
    updated_at_ms: t,
    owner_id: ownerId,
  };
  slot.workspaces.push(row);
  persist(store);
  const { owner_id: _o, ...pub } = row;
  return pub;
}

export function wpnJsonUpdateWorkspace(
  store: WorkspaceStore,
  ownerId: string,
  id: string,
  patch: { name?: string; sort_index?: number; color_token?: string | null },
): WpnWorkspaceRow | null {
  for (const slot of store.slots) {
    const idx = slot.workspaces.findIndex((w) => w.id === id && w.owner_id === ownerId);
    if (idx < 0) {
      continue;
    }
    const cur = slot.workspaces[idx]!;
    const name = patch.name !== undefined ? patch.name.trim() || cur.name : cur.name;
    const sort_index =
      patch.sort_index !== undefined ? patch.sort_index : cur.sort_index;
    const color_token =
      patch.color_token !== undefined ? patch.color_token : cur.color_token;
    const updated_at_ms = nowMs();
    slot.workspaces[idx] = {
      ...cur,
      name,
      sort_index,
      color_token,
      updated_at_ms,
    };
    persist(store);
    const { owner_id: _o, ...pub } = slot.workspaces[idx]!;
    return pub;
  }
  return null;
}

export function wpnJsonDeleteWorkspace(
  store: WorkspaceStore,
  ownerId: string,
  id: string,
): boolean {
  for (const slot of store.slots) {
    const idx = slot.workspaces.findIndex((w) => w.id === id && w.owner_id === ownerId);
    if (idx < 0) {
      continue;
    }
    const wsId = slot.workspaces[idx]!.id;
    const projectIds = slot.projects
      .filter((p) => p.workspace_id === wsId)
      .map((p) => p.id);
    const dead = new Set(projectIds);
    slot.notes = slot.notes.filter((n) => !dead.has(n.project_id));
    slot.explorer = slot.explorer.filter((e) => !dead.has(e.project_id));
    slot.projects = slot.projects.filter((p) => p.workspace_id !== wsId);
    slot.workspaces.splice(idx, 1);
    persist(store);
    return true;
  }
  return false;
}

export function wpnJsonListProjects(
  store: WorkspaceStore,
  ownerId: string,
  workspaceId: string,
): WpnProjectRow[] {
  const out: WpnProjectRow[] = [];
  for (const slot of store.slots) {
    const ws = slot.workspaces.find((w) => w.id === workspaceId && w.owner_id === ownerId);
    if (!ws) {
      continue;
    }
    for (const p of slot.projects) {
      if (p.workspace_id === workspaceId) {
        out.push({ ...p });
      }
    }
  }
  out.sort((a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name));
  return out;
}

export function wpnJsonListWorkspacesAndProjects(
  store: WorkspaceStore,
  ownerId: string,
): { workspaces: WpnWorkspaceRow[]; projects: WpnProjectRow[] } {
  const workspaces = wpnJsonListWorkspaces(store, ownerId);
  const wsIds = new Set(workspaces.map((w) => w.id));
  const projects: WpnProjectRow[] = [];
  for (const slot of store.slots) {
    for (const p of slot.projects) {
      if (wsIds.has(p.workspace_id)) {
        projects.push({ ...p });
      }
    }
  }
  projects.sort((a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name));
  return { workspaces, projects };
}

export function wpnJsonGetFullTree(
  store: WorkspaceStore,
  ownerId: string,
): {
  workspaces: WpnWorkspaceRow[];
  projects: WpnProjectRow[];
  notesByProjectId: Record<string, WpnNoteListItem[]>;
  explorerStateByProjectId: Record<string, { expanded_ids: string[] }>;
} {
  const { workspaces, projects } = wpnJsonListWorkspacesAndProjects(store, ownerId);
  const projectIds = new Set(projects.map((p) => p.id));
  const notesByProjectId: Record<string, WpnNoteListItem[]> = {};
  const explorerStateByProjectId: Record<string, { expanded_ids: string[] }> = {};

  for (const slot of store.slots) {
    // Build notes by project
    const notesByProj = new Map<string, typeof slot.notes>();
    for (const n of slot.notes) {
      if (!projectIds.has(n.project_id)) continue;
      const arr = notesByProj.get(n.project_id) ?? [];
      arr.push(n);
      notesByProj.set(n.project_id, arr);
    }
    for (const [pid, rows] of notesByProj) {
      // Build flat preorder list
      const cm = new Map<string | null, typeof rows>();
      for (const r of rows) {
        const k = r.parent_id;
        const arr = cm.get(k) ?? [];
        arr.push(r);
        cm.set(k, arr);
      }
      for (const arr of cm.values()) {
        arr.sort((a, b) => a.sibling_index - b.sibling_index);
      }
      const out: WpnNoteListItem[] = [];
      const visit = (parentId: string | null, depth: number): void => {
        const kids = cm.get(parentId) ?? [];
        for (const r of kids) {
          out.push({
            id: r.id,
            project_id: r.project_id,
            parent_id: r.parent_id,
            type: r.type,
            title: r.title,
            depth,
            sibling_index: r.sibling_index,
          });
          visit(r.id, depth + 1);
        }
      };
      visit(null, 0);
      notesByProjectId[pid] = out;
    }
    // Build explorer state by project
    for (const ex of slot.explorer) {
      if (!projectIds.has(ex.project_id)) continue;
      explorerStateByProjectId[ex.project_id] = {
        expanded_ids: Array.isArray(ex.expanded_ids) ? [...ex.expanded_ids] : [],
      };
    }
  }

  // Ensure every project has an entry (even if empty)
  for (const p of projects) {
    if (!notesByProjectId[p.id]) notesByProjectId[p.id] = [];
    if (!explorerStateByProjectId[p.id]) explorerStateByProjectId[p.id] = { expanded_ids: [] };
  }

  return { workspaces, projects, notesByProjectId, explorerStateByProjectId };
}

export function wpnJsonCreateProject(
  store: WorkspaceStore,
  ownerId: string,
  workspaceId: string,
  name: string,
): WpnProjectRow | null {
  for (const slot of store.slots) {
    const ws = slot.workspaces.find((w) => w.id === workspaceId && w.owner_id === ownerId);
    if (!ws) {
      continue;
    }
    const id = newId();
    const t = nowMs();
    const maxSort = slot.projects
      .filter((p) => p.workspace_id === workspaceId)
      .reduce((m, p) => Math.max(m, p.sort_index), -1);
    const sort_index = maxSort + 1;
    const row: WpnProjectRow = {
      id,
      workspace_id: workspaceId,
      name: name.trim() || "Project",
      sort_index,
      color_token: null,
      created_at_ms: t,
      updated_at_ms: t,
    };
    slot.projects.push(row);
    persist(store);
    return { ...row };
  }
  return null;
}

export function wpnJsonUpdateProject(
  store: WorkspaceStore,
  ownerId: string,
  id: string,
  patch: {
    name?: string;
    sort_index?: number;
    color_token?: string | null;
    workspace_id?: string;
  },
): WpnProjectRow | null {
  for (const slot of store.slots) {
    const idx = slot.projects.findIndex((p) => p.id === id);
    if (idx < 0) {
      continue;
    }
    const cur = slot.projects[idx]!;
    const ws = slot.workspaces.find(
      (w) => w.id === cur.workspace_id && w.owner_id === ownerId,
    );
    if (!ws) {
      continue;
    }
    const workspace_id = patch.workspace_id ?? cur.workspace_id;
    if (patch.workspace_id) {
      const nws = slot.workspaces.find(
        (w) => w.id === workspace_id && w.owner_id === ownerId,
      );
      if (!nws) {
        return null;
      }
    }
    const name = patch.name !== undefined ? patch.name.trim() || cur.name : cur.name;
    const sort_index =
      patch.sort_index !== undefined ? patch.sort_index : cur.sort_index;
    const color_token =
      patch.color_token !== undefined ? patch.color_token : cur.color_token;
    const updated_at_ms = nowMs();
    slot.projects[idx] = {
      ...cur,
      workspace_id,
      name,
      sort_index,
      color_token,
      updated_at_ms,
    };
    persist(store);
    return { ...slot.projects[idx]! };
  }
  return null;
}

export function wpnJsonDeleteProject(
  store: WorkspaceStore,
  ownerId: string,
  id: string,
): boolean {
  for (const slot of store.slots) {
    const idx = slot.projects.findIndex((p) => p.id === id);
    if (idx < 0) {
      continue;
    }
    const cur = slot.projects[idx]!;
    const ws = slot.workspaces.find(
      (w) => w.id === cur.workspace_id && w.owner_id === ownerId,
    );
    if (!ws) {
      continue;
    }
    slot.projects.splice(idx, 1);
    slot.notes = slot.notes.filter((n) => n.project_id !== id);
    slot.explorer = slot.explorer.filter((e) => e.project_id !== id);
    persist(store);
    return true;
  }
  return false;
}

export function wpnJsonProjectOwnedBy(
  store: WorkspaceStore,
  ownerId: string,
  projectId: string,
): boolean {
  for (const slot of store.slots) {
    const p = slot.projects.find((x) => x.id === projectId);
    if (!p) {
      continue;
    }
    const w = slot.workspaces.find(
      (x) => x.id === p.workspace_id && x.owner_id === ownerId,
    );
    if (w) {
      return true;
    }
  }
  return false;
}
