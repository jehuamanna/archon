/**
 * Browser-local workspace → project → note (WPN) persistence for web scratch session.
 * Backed by IndexedDB (Dexie). Mirrors headless WPN behavior enough for the Notes explorer + editors.
 */
import Dexie, { type Table } from "dexie";
import { collectReferencedNoteIdsFromMarkdown } from "../../shared/markdown-internal-note-href";
import {
  rewriteMarkdownForWpnNoteTitleChange,
  vfsCanonicalPathsForTitleChange,
} from "../../shared/note-vfs-link-rewrite";
import { normalizeVfsSegment } from "../../shared/note-vfs-path";
import { normalizeLegacyNoteType } from "../../shared/note-type-legacy";
import type { NoteMovePlacement } from "../../shared/archon-renderer-api";
import type {
  WpnBacklinkSourceItem,
  WpnNoteDetail,
  WpnNoteListItem,
  WpnNoteWithContextListItem,
  WpnProjectRow,
  WpnWorkspaceRow,
} from "../../shared/wpn-v2-types";
import { wpnComputeChildMapAfterMove } from "../../core/wpn/wpn-note-move";
import type { WpnNoteRow } from "../../core/wpn/wpn-types";
import { WPN_SCRATCH_INDEXEDDB_NAME } from "./wpn-scratch-constants";
import {
  mergeLegacyMainScratchWpnIntoScratchBundle,
  type LegacyMainScratchWpnBundle,
} from "./merge-legacy-main-scratch-wpn";

const KV_KEY = "wpn_scratch_bundle_v1";

type ScratchBundle = {
  workspaces: WpnWorkspaceRow[];
  projects: WpnProjectRow[];
  notes: WpnNoteRow[];
  explorer: { project_id: string; expanded_ids: string[] }[];
};

function emptyBundle(): ScratchBundle {
  return { workspaces: [], projects: [], notes: [], explorer: [] };
}

function noteWithContextFromBundle(
  b: ScratchBundle,
  noteId: string,
): WpnNoteWithContextListItem | null {
  const n = b.notes.find((x) => x.id === noteId);
  if (!n) {
    return null;
  }
  const p = b.projects.find((x) => x.id === n.project_id);
  if (!p) {
    return null;
  }
  const w = b.workspaces.find((x) => x.id === p.workspace_id);
  if (!w) {
    return null;
  }
  return {
    id: n.id,
    type: normalizeLegacyNoteType(n.type),
    title: n.title,
    project_id: n.project_id,
    project_name: p.name,
    workspace_id: p.workspace_id,
    workspace_name: w.name,
    parent_id: n.parent_id,
  };
}

class WpnScratchDexie extends Dexie {
  kv!: Table<{ key: string; value: ScratchBundle }, string>;

  constructor() {
    super(WPN_SCRATCH_INDEXEDDB_NAME);
    this.version(1).stores({ kv: "&key" });
  }
}

let dbInst: WpnScratchDexie | null = null;

function db(): WpnScratchDexie {
  if (!dbInst) {
    dbInst = new WpnScratchDexie();
  }
  return dbInst;
}

async function loadBundle(): Promise<ScratchBundle> {
  if (typeof indexedDB === "undefined") {
    return emptyBundle();
  }
  const row = await db().kv.get(KV_KEY);
  if (!row?.value) {
    return emptyBundle();
  }
  return {
    ...emptyBundle(),
    ...row.value,
    workspaces: Array.isArray(row.value.workspaces) ? row.value.workspaces : [],
    projects: Array.isArray(row.value.projects) ? row.value.projects : [],
    notes: Array.isArray(row.value.notes) ? row.value.notes : [],
    explorer: Array.isArray(row.value.explorer) ? row.value.explorer : [],
  };
}

async function saveBundle(b: ScratchBundle): Promise<void> {
  if (typeof indexedDB === "undefined") {
    return;
  }
  await db().kv.put({ key: KV_KEY, value: b });
}

function nowMs(): number {
  return Date.now();
}

function newId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `id-${nowMs()}-${Math.random().toString(16).slice(2)}`;
}

function parseMetadata(json: string | null): Record<string, unknown> | undefined {
  if (json == null || json === "") {
    return undefined;
  }
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function workspaceOwned(b: ScratchBundle, id: string): WpnWorkspaceRow | null {
  return b.workspaces.find((w) => w.id === id) ?? null;
}

function projectOwned(b: ScratchBundle, projectId: string): WpnProjectRow | null {
  const p = b.projects.find((x) => x.id === projectId);
  if (!p) return null;
  const w = workspaceOwned(b, p.workspace_id);
  return w ? p : null;
}

/** True if `projectId` exists in the local scratch bundle (unlike HTTP WPN, list-notes never 404s). */
export async function scratchWpnProjectExists(projectId: string): Promise<boolean> {
  const b = await loadBundle();
  return projectOwned(b, projectId.trim()) != null;
}

function loadRows(b: ScratchBundle, projectId: string): WpnNoteRow[] {
  return b.notes
    .filter((r) => r.project_id === projectId)
    .map((r) => ({ ...r, type: normalizeLegacyNoteType(r.type) }));
}

function childrenMapFromRows(rows: WpnNoteRow[]): Map<string | null, WpnNoteRow[]> {
  const m = new Map<string | null, WpnNoteRow[]>();
  for (const r of rows) {
    const k = r.parent_id;
    const arr = m.get(k) ?? [];
    arr.push(r);
    m.set(k, arr);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => a.sibling_index - b.sibling_index);
  }
  return m;
}

function listNotesFlat(b: ScratchBundle, projectId: string): WpnNoteListItem[] {
  if (!projectOwned(b, projectId)) {
    return [];
  }
  const rows = loadRows(b, projectId);
  const cm = childrenMapFromRows(rows);
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
  return out;
}

function getNoteDetail(b: ScratchBundle, noteId: string): WpnNoteDetail | null {
  const n = b.notes.find((x) => x.id === noteId);
  if (!n || !projectOwned(b, n.project_id)) {
    return null;
  }
  return {
    id: n.id,
    project_id: n.project_id,
    parent_id: n.parent_id,
    type: normalizeLegacyNoteType(n.type),
    title: n.title,
    content: n.content,
    metadata: parseMetadata(n.metadata_json),
    sibling_index: n.sibling_index,
    created_at_ms: n.created_at_ms,
    updated_at_ms: n.updated_at_ms,
  };
}

function applySiblingOrderJson(
  b: ScratchBundle,
  projectId: string,
  orderedIds: string[],
): void {
  const t = nowMs();
  orderedIds.forEach((nid, i) => {
    const n = b.notes.find((x) => x.id === nid && x.project_id === projectId);
    if (n) {
      n.sibling_index = i;
      n.updated_at_ms = t;
    }
  });
}

function persistTreeJson(
  b: ScratchBundle,
  projectId: string,
  childMap: Map<string | null, string[]>,
): void {
  const t = nowMs();
  const walk = (parentId: string | null, ids: string[]): void => {
    ids.forEach((id, i) => {
      const n = b.notes.find((x) => x.id === id && x.project_id === projectId);
      if (n) {
        n.parent_id = parentId;
        n.sibling_index = i;
        n.updated_at_ms = t;
      }
      walk(id, childMap.get(id) ?? []);
    });
  };
  walk(null, childMap.get(null) ?? []);
}

function collectSubtreePreorder(rows: WpnNoteRow[], rootId: string): string[] {
  const cm = childrenMapFromRows(rows);
  const out: string[] = [];
  const visit = (id: string): void => {
    out.push(id);
    for (const k of cm.get(id) ?? []) {
      visit(k.id);
    }
  };
  visit(rootId);
  return out;
}

// —— Public API (async, matches window.Archon usage) ——

export async function scratchWpnListWorkspaces(): Promise<{ workspaces: WpnWorkspaceRow[] }> {
  const b = await loadBundle();
  const ws = [...b.workspaces].sort(
    (a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name),
  );
  return { workspaces: ws };
}

export async function scratchWpnCreateWorkspace(name?: string): Promise<{ workspace: WpnWorkspaceRow }> {
  const b = await loadBundle();
  const id = newId();
  const t = nowMs();
  const maxSort = b.workspaces.reduce((m, w) => Math.max(m, w.sort_index), -1);
  const row: WpnWorkspaceRow = {
    id,
    name: (name ?? "Workspace").trim() || "Workspace",
    sort_index: maxSort + 1,
    color_token: null,
    created_at_ms: t,
    updated_at_ms: t,
  };
  b.workspaces.push(row);
  await saveBundle(b);
  return { workspace: row };
}

export async function scratchWpnUpdateWorkspace(
  id: string,
  patch: { name?: string; sort_index?: number; color_token?: string | null },
): Promise<{ workspace: WpnWorkspaceRow } | null> {
  const b = await loadBundle();
  const idx = b.workspaces.findIndex((w) => w.id === id);
  if (idx < 0) return null;
  const cur = b.workspaces[idx]!;
  const name = patch.name !== undefined ? patch.name.trim() || cur.name : cur.name;
  const sort_index = patch.sort_index !== undefined ? patch.sort_index : cur.sort_index;
  const color_token =
    patch.color_token !== undefined ? patch.color_token : cur.color_token;
  const updated: WpnWorkspaceRow = {
    ...cur,
    name,
    sort_index,
    color_token,
    updated_at_ms: nowMs(),
  };
  b.workspaces[idx] = updated;
  await saveBundle(b);
  return { workspace: updated };
}

export async function scratchWpnDeleteWorkspace(id: string): Promise<{ ok: true } | null> {
  const b = await loadBundle();
  const idx = b.workspaces.findIndex((w) => w.id === id);
  if (idx < 0) return null;
  const projectIds = b.projects.filter((p) => p.workspace_id === id).map((p) => p.id);
  const dead = new Set(projectIds);
  b.notes = b.notes.filter((n) => !dead.has(n.project_id));
  b.explorer = b.explorer.filter((e) => !dead.has(e.project_id));
  b.projects = b.projects.filter((p) => p.workspace_id !== id);
  b.workspaces.splice(idx, 1);
  await saveBundle(b);
  return { ok: true };
}

export async function scratchWpnListProjects(
  workspaceId: string,
): Promise<{ projects: WpnProjectRow[] }> {
  const b = await loadBundle();
  if (!workspaceOwned(b, workspaceId)) {
    return { projects: [] };
  }
  const out = b.projects
    .filter((p) => p.workspace_id === workspaceId)
    .sort((a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name));
  return { projects: out.map((p) => ({ ...p })) };
}

export async function scratchWpnListWorkspacesAndProjects(): Promise<{
  workspaces: WpnWorkspaceRow[];
  projects: WpnProjectRow[];
}> {
  const b = await loadBundle();
  const workspaces = [...b.workspaces].sort(
    (a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name),
  );
  const wsIds = new Set(workspaces.map((w) => w.id));
  const projects = b.projects
    .filter((p) => wsIds.has(p.workspace_id))
    .sort((a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name))
    .map((p) => ({ ...p }));
  return { workspaces, projects };
}

export async function scratchWpnGetFullTree(): Promise<{
  workspaces: WpnWorkspaceRow[];
  projects: WpnProjectRow[];
  notesByProjectId: Record<string, WpnNoteListItem[]>;
  explorerStateByProjectId: Record<string, { expanded_ids: string[] }>;
}> {
  const b = await loadBundle();
  const workspaces = [...b.workspaces].sort(
    (a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name),
  );
  const wsIds = new Set(workspaces.map((w) => w.id));
  const projects = b.projects
    .filter((p) => wsIds.has(p.workspace_id))
    .sort((a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name))
    .map((p) => ({ ...p }));
  const notesByProjectId: Record<string, WpnNoteListItem[]> = {};
  for (const p of projects) {
    notesByProjectId[p.id] = listNotesFlat(b, p.id);
  }
  const explorerStateByProjectId: Record<string, { expanded_ids: string[] }> = {};
  const projectIds = new Set(projects.map((p) => p.id));
  for (const e of b.explorer) {
    if (!projectIds.has(e.project_id)) continue;
    explorerStateByProjectId[e.project_id] = {
      expanded_ids: Array.isArray(e.expanded_ids) ? [...e.expanded_ids] : [],
    };
  }
  for (const p of projects) {
    if (!explorerStateByProjectId[p.id]) {
      explorerStateByProjectId[p.id] = { expanded_ids: [] };
    }
  }
  return { workspaces, projects, notesByProjectId, explorerStateByProjectId };
}

export async function scratchWpnCreateProject(
  workspaceId: string,
  name?: string,
): Promise<{ project: WpnProjectRow } | null> {
  const b = await loadBundle();
  if (!workspaceOwned(b, workspaceId)) {
    return null;
  }
  const id = newId();
  const t = nowMs();
  const maxSort = b.projects
    .filter((p) => p.workspace_id === workspaceId)
    .reduce((m, p) => Math.max(m, p.sort_index), -1);
  const row: WpnProjectRow = {
    id,
    workspace_id: workspaceId,
    name: (name ?? "Project").trim() || "Project",
    sort_index: maxSort + 1,
    color_token: null,
    created_at_ms: t,
    updated_at_ms: t,
  };
  b.projects.push(row);
  await saveBundle(b);
  return { project: { ...row } };
}

export async function scratchWpnUpdateProject(
  id: string,
  patch: {
    name?: string;
    sort_index?: number;
    color_token?: string | null;
    workspace_id?: string;
  },
): Promise<{ project: WpnProjectRow } | null> {
  const b = await loadBundle();
  const idx = b.projects.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const cur = b.projects[idx]!;
  if (patch.workspace_id !== undefined) {
    const wid = patch.workspace_id;
    if (!workspaceOwned(b, wid)) {
      return null;
    }
  }
  const name = patch.name !== undefined ? patch.name.trim() || cur.name : cur.name;
  const sort_index = patch.sort_index !== undefined ? patch.sort_index : cur.sort_index;
  const color_token =
    patch.color_token !== undefined ? patch.color_token : cur.color_token;
  const workspace_id =
    patch.workspace_id !== undefined ? patch.workspace_id : cur.workspace_id;
  const updated: WpnProjectRow = {
    ...cur,
    name,
    sort_index,
    color_token,
    workspace_id,
    updated_at_ms: nowMs(),
  };
  b.projects[idx] = updated;
  await saveBundle(b);
  return { project: { ...updated } };
}

export async function scratchWpnDeleteProject(id: string): Promise<{ ok: true } | null> {
  const b = await loadBundle();
  const idx = b.projects.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  b.notes = b.notes.filter((n) => n.project_id !== id);
  b.explorer = b.explorer.filter((e) => e.project_id !== id);
  b.projects.splice(idx, 1);
  await saveBundle(b);
  return { ok: true };
}

export async function scratchWpnListNotes(
  projectId: string,
): Promise<{ notes: WpnNoteListItem[] }> {
  const b = await loadBundle();
  return { notes: listNotesFlat(b, projectId) };
}

export async function scratchWpnListAllNotesWithContext(): Promise<{
  notes: WpnNoteWithContextListItem[];
}> {
  const b = await loadBundle();
  const out: WpnNoteWithContextListItem[] = [];
  for (const n of b.notes) {
    const p = b.projects.find((x) => x.id === n.project_id);
    if (!p) continue;
    const w = b.workspaces.find((x) => x.id === p.workspace_id);
    if (!w) continue;
    out.push({
      id: n.id,
      type: normalizeLegacyNoteType(n.type),
      title: n.title,
      project_id: n.project_id,
      project_name: p.name,
      workspace_id: p.workspace_id,
      workspace_name: w.name,
      parent_id: n.parent_id,
    });
  }
  return { notes: out };
}

export async function scratchWpnListBacklinksToNote(
  targetNoteId: string,
): Promise<{ sources: WpnBacklinkSourceItem[] }> {
  const b = await loadBundle();
  const rows: { id: string; title: string; content: string; project_id: string }[] = [];
  for (const n of b.notes) {
    if (n.id === targetNoteId) continue;
    if (!projectOwned(b, n.project_id)) continue;
    rows.push({
      id: n.id,
      title: n.title,
      content: n.content,
      project_id: n.project_id,
    });
  }
  const out: WpnBacklinkSourceItem[] = [];
  for (const r of rows) {
    const refs = collectReferencedNoteIdsFromMarkdown(r.content ?? "");
    if (refs.has(targetNoteId)) {
      out.push({ id: r.id, title: r.title, project_id: r.project_id });
    }
  }
  return { sources: out };
}

export async function scratchWpnGetNote(noteId: string): Promise<{ note: WpnNoteDetail } | null> {
  const b = await loadBundle();
  const note = getNoteDetail(b, noteId);
  if (!note) return null;
  return { note };
}

export async function scratchWpnGetExplorerState(
  projectId: string,
): Promise<{ expanded_ids: string[] }> {
  const b = await loadBundle();
  if (!projectOwned(b, projectId)) {
    return { expanded_ids: [] };
  }
  const row = b.explorer.find((e) => e.project_id === projectId);
  return { expanded_ids: row?.expanded_ids?.length ? [...row.expanded_ids] : [] };
}

export async function scratchWpnSetExplorerState(
  projectId: string,
  expandedIds: string[],
): Promise<{ expanded_ids: string[] }> {
  const b = await loadBundle();
  if (!projectOwned(b, projectId)) {
    return { expanded_ids: [] };
  }
  const json = [...new Set(expandedIds)];
  const idx = b.explorer.findIndex((e) => e.project_id === projectId);
  if (idx >= 0) {
    b.explorer[idx] = { project_id: projectId, expanded_ids: json };
  } else {
    b.explorer.push({ project_id: projectId, expanded_ids: json });
  }
  await saveBundle(b);
  return { expanded_ids: json };
}

export async function scratchWpnCreateNoteInProject(
  projectId: string,
  payload: {
    anchorId?: string;
    relation: "child" | "sibling" | "root";
    type: string;
    content?: string;
    title?: string;
  },
): Promise<{ id: string }> {
  const b = await loadBundle();
  if (!projectOwned(b, projectId)) {
    throw new Error("Project not found");
  }
  const noteType = normalizeLegacyNoteType(payload.type);
  const rows = loadRows(b, projectId);
  const cm = childrenMapFromRows(rows);
  const id = newId();
  const t = nowMs();
  const title = (payload.title ?? "").trim() || "Untitled";
  const content = payload.content ?? "";
  const metadata_json: string | null = null;

  let parent_id: string | null = null;
  let sibling_index = 0;

  if (payload.relation === "root") {
    const roots = cm.get(null) ?? [];
    sibling_index =
      roots.length === 0 ? 0 : Math.max(...roots.map((r) => r.sibling_index)) + 1;
    parent_id = null;
  } else if (!payload.anchorId) {
    throw new Error("anchorId required for child/sibling");
  } else {
    const anchor = rows.find((r) => r.id === payload.anchorId);
    if (!anchor) {
      throw new Error("Anchor note not found");
    }
    if (payload.relation === "child") {
      parent_id = anchor.id;
      const kids = cm.get(anchor.id) ?? [];
      sibling_index =
        kids.length === 0 ? 0 : Math.max(...kids.map((r) => r.sibling_index)) + 1;
    } else {
      parent_id = anchor.parent_id;
      const sibs = (cm.get(parent_id) ?? [])
        .slice()
        .sort((a, b) => a.sibling_index - b.sibling_index);
      const ai = sibs.findIndex((x) => x.id === anchor.id);
      if (ai < 0) {
        throw new Error("Invalid anchor");
      }
      const orderedIds = [
        ...sibs.slice(0, ai + 1).map((r) => r.id),
        id,
        ...sibs.slice(ai + 1).map((r) => r.id),
      ];
      b.notes.push({
        id,
        project_id: projectId,
        parent_id,
        type: noteType,
        title,
        content,
        metadata_json,
        sibling_index: 0,
        created_at_ms: t,
        updated_at_ms: t,
      });
      applySiblingOrderJson(b, projectId, orderedIds);
      await saveBundle(b);
      return { id };
    }
  }

  b.notes.push({
    id,
    project_id: projectId,
    parent_id,
    type: noteType,
    title,
    content,
    metadata_json,
    sibling_index,
    created_at_ms: t,
    updated_at_ms: t,
  });
  await saveBundle(b);
  return { id };
}

export async function scratchWpnPatchNote(
  noteId: string,
  patch: {
    title?: string;
    content?: string;
    type?: string;
    metadata?: Record<string, unknown> | null;
    updateVfsDependentLinks?: boolean;
  },
): Promise<{ note: WpnNoteDetail } | null> {
  const b = await loadBundle();
  const cur = getNoteDetail(b, noteId);
  if (!cur) return null;
  const n = b.notes.find((x) => x.id === noteId);
  if (!n) return null;

  const updateVfs = patch.updateVfsDependentLinks !== false;
  const { updateVfsDependentLinks: _vfsOpt, ...cleanPatch } = patch;

  const oldTitle = n.title;
  const title =
    cleanPatch.title !== undefined ? cleanPatch.title.trim() || cur.title : cur.title;
  const content = cleanPatch.content !== undefined ? cleanPatch.content : cur.content;
  const type = normalizeLegacyNoteType(cleanPatch.type !== undefined ? cleanPatch.type : cur.type);
  let metadata_json: string | null =
    cur.metadata && Object.keys(cur.metadata).length > 0
      ? JSON.stringify(cur.metadata)
      : null;
  if (cleanPatch.metadata !== undefined) {
    metadata_json =
      cleanPatch.metadata && Object.keys(cleanPatch.metadata).length > 0
        ? JSON.stringify(cleanPatch.metadata)
        : null;
  }
  n.title = title;
  n.content = content;
  n.metadata_json = metadata_json;
  n.type = type;

  if (
    updateVfs &&
    cleanPatch.title !== undefined &&
    oldTitle !== title
  ) {
    const ctx = noteWithContextFromBundle(b, noteId);
    if (ctx) {
      const paths = vfsCanonicalPathsForTitleChange(ctx, oldTitle, title);
      if (paths) {
        const oldSeg = normalizeVfsSegment(oldTitle, "Untitled");
        const newSeg = normalizeVfsSegment(title, "Untitled");
        const { oldCanonical, newCanonical } = paths;
        const tms = nowMs();
        for (const o of b.notes) {
          const c0 = o.content ?? "";
          const c1 = rewriteMarkdownForWpnNoteTitleChange(
            c0,
            o.project_id,
            ctx.project_id,
            oldCanonical,
            newCanonical,
            oldSeg,
            newSeg,
          );
          if (c1 !== c0) {
            o.content = c1;
            o.updated_at_ms = tms;
          }
        }
      }
    }
  }

  n.updated_at_ms = nowMs();
  await saveBundle(b);
  const next = getNoteDetail(b, noteId);
  return next ? { note: next } : null;
}

export async function scratchWpnPreviewNoteTitleVfsImpact(
  noteId: string,
  newTitle: string,
): Promise<{ dependentNoteCount: number; dependentNoteIds: string[] }> {
  const b = await loadBundle();
  const ctx = noteWithContextFromBundle(b, noteId);
  if (!ctx) {
    return { dependentNoteCount: 0, dependentNoteIds: [] };
  }
  const n = b.notes.find((x) => x.id === noteId);
  if (!n) {
    return { dependentNoteCount: 0, dependentNoteIds: [] };
  }
  const nextTitle = newTitle.trim() ? newTitle.trim() : n.title;
  const paths = vfsCanonicalPathsForTitleChange(ctx, n.title, nextTitle);
  if (!paths) {
    return { dependentNoteCount: 0, dependentNoteIds: [] };
  }
  const oldSeg = normalizeVfsSegment(n.title, "Untitled");
  const newSeg = normalizeVfsSegment(nextTitle, "Untitled");
  const { oldCanonical, newCanonical } = paths;
  const dependentNoteIds: string[] = [];
  for (const o of b.notes) {
    const c0 = o.content ?? "";
    const c1 = rewriteMarkdownForWpnNoteTitleChange(
      c0,
      o.project_id,
      ctx.project_id,
      oldCanonical,
      newCanonical,
      oldSeg,
      newSeg,
    );
    if (c1 !== c0) {
      dependentNoteIds.push(o.id);
    }
  }
  return { dependentNoteCount: dependentNoteIds.length, dependentNoteIds };
}

export async function scratchWpnDeleteNotes(ids: string[]): Promise<{ ok: true }> {
  const b = await loadBundle();
  const seeds = [...new Set(ids)].filter((id) => getNoteDetail(b, id));
  if (seeds.length === 0) {
    return { ok: true };
  }
  const childMap = new Map<string | null, string[]>();
  for (const n of b.notes) {
    const arr = childMap.get(n.parent_id) ?? [];
    arr.push(n.id);
    childMap.set(n.parent_id, arr);
  }
  const toDelete = new Set<string>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (toDelete.has(id)) continue;
    toDelete.add(id);
    for (const childId of childMap.get(id) ?? []) {
      stack.push(childId);
    }
  }
  b.notes = b.notes.filter((x) => !toDelete.has(x.id));
  await saveBundle(b);
  return { ok: true };
}

export async function scratchWpnMoveNote(payload: {
  projectId: string;
  draggedId: string;
  targetId: string;
  placement: NoteMovePlacement;
}): Promise<{ ok: true }> {
  const { projectId, draggedId, targetId, placement } = payload;
  const b = await loadBundle();
  if (!projectOwned(b, projectId)) {
    throw new Error("Project not found");
  }
  if (draggedId === targetId) {
    return { ok: true };
  }
  const rows = loadRows(b, projectId);
  const childMap = wpnComputeChildMapAfterMove(rows, draggedId, targetId, placement);
  persistTreeJson(b, projectId, childMap);
  await saveBundle(b);
  return { ok: true };
}

export async function scratchWpnDuplicateNoteSubtree(
  projectId: string,
  rootNoteId: string,
): Promise<{ newRootId: string }> {
  const b = await loadBundle();
  if (!projectOwned(b, projectId)) {
    throw new Error("Project not found");
  }
  const rows = loadRows(b, projectId);
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const rootRow = rowMap.get(rootNoteId);
  if (!rootRow) {
    throw new Error("Note not found");
  }
  const ordered = collectSubtreePreorder(rows, rootNoteId);
  const subtreeIds = new Set(ordered);
  const idMap = new Map<string, string>();
  for (const id of ordered) {
    idMap.set(id, newId());
  }
  const newRootId = idMap.get(rootNoteId)!;
  const P = rootRow.parent_id;
  const cmBefore = childrenMapFromRows(rows);
  const siblingsAtP = (cmBefore.get(P) ?? []).map((r) => r.id);
  const idxAtP = siblingsAtP.indexOf(rootNoteId);
  const newOrderAtP =
    idxAtP >= 0
      ? [...siblingsAtP.slice(0, idxAtP + 1), newRootId, ...siblingsAtP.slice(idxAtP + 1)]
      : [...siblingsAtP, newRootId];

  const t = nowMs();
  for (const oid of ordered) {
    const r = rowMap.get(oid)!;
    const nid = idMap.get(oid)!;
    const newParent =
      r.parent_id === null
        ? null
        : subtreeIds.has(r.parent_id)
          ? idMap.get(r.parent_id)!
          : r.parent_id;
    b.notes.push({
      id: nid,
      project_id: projectId,
      parent_id: newParent,
      type: r.type,
      title: r.title,
      content: r.content,
      metadata_json: r.metadata_json,
      sibling_index: 0,
      created_at_ms: t,
      updated_at_ms: t,
    });
  }

  applySiblingOrderJson(b, projectId, newOrderAtP);

  for (const oid of ordered) {
    const kids = (cmBefore.get(oid) ?? []).filter((k) => subtreeIds.has(k.id));
    if (kids.length === 0) {
      continue;
    }
    const newPid = idMap.get(oid)!;
    const newKidOrder = kids.map((k) => idMap.get(k.id)!);
    applySiblingOrderJson(b, projectId, newKidOrder);
  }

  await saveBundle(b);
  return { newRootId };
}

/** Flat note list for `getAllNotes` / sidebar (all projects). */
export async function scratchGetAllNoteListItems(): Promise<
  import("../../shared/archon-renderer-api").NoteListItem[]
> {
  const b = await loadBundle();
  const out: import("../../shared/archon-renderer-api").NoteListItem[] = [];
  for (const p of b.projects) {
    const flat = listNotesFlat(b, p.id);
    for (const n of flat) {
      out.push({
        id: n.id,
        type: n.type,
        title: n.title,
        parentId: n.parent_id,
        depth: n.depth,
      });
    }
  }
  return out;
}

/** Map WPN detail to legacy `Note` for editors. */
export function scratchWpnDetailToNote(d: WpnNoteDetail): import("../../shared/archon-renderer-api").Note {
  return {
    id: d.id,
    type: d.type,
    title: d.title,
    content: d.content,
    metadata: d.metadata,
  };
}

export async function scratchGetNoteForEditor(
  noteId?: string,
): Promise<import("../../shared/archon-renderer-api").Note | null> {
  if (!noteId) {
    const items = await scratchGetAllNoteListItems();
    if (items.length === 0) return null;
    const d = await scratchWpnGetNote(items[0]!.id);
    return d?.note ? scratchWpnDetailToNote(d.note) : null;
  }
  const d = await scratchWpnGetNote(noteId);
  return d?.note ? scratchWpnDetailToNote(d.note) : null;
}

export async function scratchSaveNoteContent(noteId: string, content: string): Promise<void> {
  await scratchWpnPatchNote(noteId, { content });
}

export async function scratchRenameNote(
  noteId: string,
  title: string,
  options?: { updateVfsDependentLinks?: boolean },
): Promise<void> {
  await scratchWpnPatchNote(noteId, { title, ...options });
}

export async function scratchDeleteNotes(ids: string[]): Promise<void> {
  await scratchWpnDeleteNotes(ids);
}

/** Delete IndexedDB database for scratch WPN (used by clear-db). */
/** Merge WPN rows from a legacy Electron temp-dir scratch session (main memory) into this DB. */
export async function applyLegacyMainScratchWpnMigration(
  legacy: LegacyMainScratchWpnBundle,
): Promise<void> {
  const cur = await loadBundle();
  const next = mergeLegacyMainScratchWpnIntoScratchBundle(
    {
      workspaces: cur.workspaces,
      projects: cur.projects,
      notes: cur.notes,
      explorer: cur.explorer,
    },
    legacy,
  );
  await saveBundle({
    workspaces: next.workspaces,
    projects: next.projects,
    notes: next.notes,
    explorer: next.explorer,
  });
}

export async function scratchWpnBuildExportBundle(
  workspaceIds?: string[],
): Promise<{
  metadata: import("../../shared/wpn-import-export-types").WpnExportMetadata;
  noteContents: Map<string, string>;
}> {
  const b = await loadBundle();
  const filterIds = workspaceIds && workspaceIds.length > 0 ? new Set(workspaceIds) : null;
  const noteContents = new Map<string, string>();

  type ExportWs = import("../../shared/wpn-import-export-types").WpnExportWorkspaceEntry;
  type ExportProj = import("../../shared/wpn-import-export-types").WpnExportProjectEntry;
  type ExportNote = import("../../shared/wpn-import-export-types").WpnExportNoteEntry;

  const workspaces: ExportWs[] = [];
  const wsList = b.workspaces
    .filter((w) => !filterIds || filterIds.has(w.id))
    .sort((a, c) => a.sort_index - c.sort_index || a.name.localeCompare(c.name));

  for (const ws of wsList) {
    const projects: ExportProj[] = [];
    const projList = b.projects
      .filter((p) => p.workspace_id === ws.id)
      .sort((a, c) => a.sort_index - c.sort_index || a.name.localeCompare(c.name));

    for (const proj of projList) {
      const noteRows = b.notes.filter((n) => n.project_id === proj.id);
      const notes: ExportNote[] = noteRows.map((n) => {
        noteContents.set(n.id, n.content ?? "");
        let metadata: Record<string, unknown> | null = null;
        if (n.metadata_json) {
          try { metadata = JSON.parse(n.metadata_json) as Record<string, unknown>; } catch { metadata = null; }
        }
        return {
          id: n.id,
          parent_id: n.parent_id,
          type: n.type,
          title: n.title,
          sibling_index: n.sibling_index,
          metadata,
        };
      });
      projects.push({
        id: proj.id,
        name: proj.name,
        sort_index: proj.sort_index,
        color_token: proj.color_token,
        notes,
      });
    }
    workspaces.push({
      id: ws.id,
      name: ws.name,
      sort_index: ws.sort_index,
      color_token: ws.color_token,
      projects,
    });
  }

  return {
    metadata: { version: 1, exported_at_ms: nowMs(), workspaces },
    noteContents,
  };
}

export async function scratchWpnImportFromBundle(
  metadata: import("../../shared/wpn-import-export-types").WpnExportMetadata,
  noteContents: Map<string, string>,
): Promise<import("../../shared/wpn-import-export-types").WpnImportResult> {
  const b = await loadBundle();
  const existingNames = new Set(b.workspaces.map((w) => w.name));
  let maxSort = b.workspaces.reduce((m, w) => Math.max(m, w.sort_index), -1);

  let importedWs = 0;
  let importedProj = 0;
  let importedNotes = 0;
  const t = nowMs();

  for (const wsEntry of metadata.workspaces ?? []) {
    let wsName = wsEntry.name;
    if (existingNames.has(wsName)) {
      let suffix = 1;
      while (existingNames.has(`${wsEntry.name} ${suffix}`)) suffix++;
      wsName = `${wsEntry.name} ${suffix}`;
    }
    existingNames.add(wsName);

    const newWsId = newId();
    b.workspaces.push({
      id: newWsId,
      name: wsName,
      sort_index: ++maxSort,
      color_token: wsEntry.color_token,
      created_at_ms: t,
      updated_at_ms: t,
    });
    importedWs++;

    let nextProjSort = 0;
    for (const projEntry of wsEntry.projects) {
      const newProjId = newId();
      b.projects.push({
        id: newProjId,
        workspace_id: newWsId,
        name: projEntry.name,
        sort_index: nextProjSort++,
        color_token: projEntry.color_token,
        created_at_ms: t,
        updated_at_ms: t,
      });
      importedProj++;

      const idMap = new Map<string, string>();
      for (const ne of projEntry.notes) idMap.set(ne.id, newId());

      for (const ne of projEntry.notes) {
        const newNoteId = idMap.get(ne.id)!;
        const newParentId = ne.parent_id !== null ? (idMap.get(ne.parent_id) ?? null) : null;
        const content = noteContents.get(ne.id) ?? "";
        const metadata_json = ne.metadata && Object.keys(ne.metadata).length > 0
          ? JSON.stringify(ne.metadata)
          : null;
        b.notes.push({
          id: newNoteId,
          project_id: newProjId,
          parent_id: newParentId,
          type: ne.type,
          title: ne.title,
          content,
          metadata_json,
          sibling_index: ne.sibling_index,
          created_at_ms: t,
          updated_at_ms: t,
        });
        importedNotes++;
      }
    }
  }

  await saveBundle(b);
  return { workspaces: importedWs, projects: importedProj, notes: importedNotes };
}

export async function destroyWpnScratchIndexedDb(): Promise<void> {
  if (typeof indexedDB === "undefined") {
    return;
  }
  try {
    await db().close();
  } catch {
    /* ignore */
  }
  dbInst = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(WPN_SCRATCH_INDEXEDDB_NAME);
    req.onblocked = () => {};
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("deleteDatabase failed"));
  });
}
