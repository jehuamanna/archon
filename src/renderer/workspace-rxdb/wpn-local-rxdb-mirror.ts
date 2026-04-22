/**
 * ADR-016 P1: normalized WPN mirror collections + hydrate from main mirror payload.
 */
import type { RxJsonSchema } from "rxdb";
import { parseWorkspaceSlotWpnArrays } from "../../core/wpn/wpn-slot-json-parse";
import type { WorkspaceRxdbMirrorPayloadV1 } from "../../shared/workspace-rxdb-mirror-payload";
import type {
  WpnBacklinkSourceItem,
  WpnNoteDetail,
  WpnNoteListItem,
  WpnNoteRow,
  WpnNoteWithContextListItem,
  WpnProjectRow,
  WpnWorkspaceRow,
} from "../../shared/wpn-v2-types";

export type LocalWpnWorkspaceMirrorRow = {
  id: string;
  slot_index: number;
  owner_id: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

export type LocalWpnProjectMirrorRow = {
  id: string;
  slot_index: number;
  workspace_id: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

export type LocalWpnNoteMirrorRow = {
  id: string;
  slot_index: number;
  project_id: string;
  parent_id: string | null;
  type: string;
  title: string;
  content: string;
  metadata_json: string | null;
  sibling_index: number;
  created_at_ms: number;
  updated_at_ms: number;
};

export type LocalWpnExplorerMirrorRow = {
  id: string;
  slot_index: number;
  project_id: string;
  expanded_ids: string[];
};

const str = { type: "string" as const };
const strNull = { type: ["string", "null"] as const };

const localWpnWorkspaceMirrorSchemaLiteral = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 320 },
    slot_index: { type: "number", minimum: 0, multipleOf: 1 },
    owner_id: { type: "string", maxLength: 256 },
    name: { type: "string", maxLength: 2000 },
    sort_index: { type: "number" },
    color_token: strNull,
    created_at_ms: { type: "number" },
    updated_at_ms: { type: "number" },
  },
  required: [
    "id",
    "slot_index",
    "owner_id",
    "name",
    "sort_index",
    "color_token",
    "created_at_ms",
    "updated_at_ms",
  ],
  additionalProperties: false,
} as const;

const localWpnProjectMirrorSchemaLiteral = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 320 },
    slot_index: { type: "number", minimum: 0, multipleOf: 1 },
    workspace_id: { type: "string", maxLength: 128 },
    name: { type: "string", maxLength: 2000 },
    sort_index: { type: "number" },
    color_token: strNull,
    created_at_ms: { type: "number" },
    updated_at_ms: { type: "number" },
  },
  required: [
    "id",
    "slot_index",
    "workspace_id",
    "name",
    "sort_index",
    "color_token",
    "created_at_ms",
    "updated_at_ms",
  ],
  additionalProperties: false,
} as const;

const localWpnNoteMirrorSchemaLiteral = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 400 },
    slot_index: { type: "number", minimum: 0, multipleOf: 1 },
    project_id: { type: "string", maxLength: 128 },
    parent_id: strNull,
    type: { type: "string", maxLength: 200 },
    title: { type: "string", maxLength: 8000 },
    content: { type: "string", maxLength: 2_000_000 },
    metadata_json: strNull,
    sibling_index: { type: "number" },
    created_at_ms: { type: "number" },
    updated_at_ms: { type: "number" },
  },
  required: [
    "id",
    "slot_index",
    "project_id",
    "parent_id",
    "type",
    "title",
    "content",
    "metadata_json",
    "sibling_index",
    "created_at_ms",
    "updated_at_ms",
  ],
  additionalProperties: false,
} as const;

const localWpnExplorerMirrorSchemaLiteral = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 320 },
    slot_index: { type: "number", minimum: 0, multipleOf: 1 },
    project_id: { type: "string", maxLength: 128 },
    expanded_ids: { type: "array", items: str },
  },
  required: ["id", "slot_index", "project_id", "expanded_ids"],
  additionalProperties: false,
} as const;

export const localWpnWorkspaceMirrorRxSchema: RxJsonSchema<LocalWpnWorkspaceMirrorRow> =
  localWpnWorkspaceMirrorSchemaLiteral as unknown as RxJsonSchema<LocalWpnWorkspaceMirrorRow>;
export const localWpnProjectMirrorRxSchema: RxJsonSchema<LocalWpnProjectMirrorRow> =
  localWpnProjectMirrorSchemaLiteral as unknown as RxJsonSchema<LocalWpnProjectMirrorRow>;
export const localWpnNoteMirrorRxSchema: RxJsonSchema<LocalWpnNoteMirrorRow> =
  localWpnNoteMirrorSchemaLiteral as unknown as RxJsonSchema<LocalWpnNoteMirrorRow>;
export const localWpnExplorerMirrorRxSchema: RxJsonSchema<LocalWpnExplorerMirrorRow> =
  localWpnExplorerMirrorSchemaLiteral as unknown as RxJsonSchema<LocalWpnExplorerMirrorRow>;

export const LOCAL_WPN_MIRROR_COLLECTIONS = {
  local_wpn_workspaces: { schema: localWpnWorkspaceMirrorRxSchema },
  local_wpn_projects: { schema: localWpnProjectMirrorRxSchema },
  local_wpn_notes: { schema: localWpnNoteMirrorRxSchema },
  local_wpn_explorer: { schema: localWpnExplorerMirrorRxSchema },
} as const;

function compositeId(slotIndex: number, entityId: string): string {
  return `${slotIndex}__${entityId}`;
}

export function entityIdFromComposite(compositeId: string): string {
  const i = compositeId.indexOf("__");
  return i >= 0 ? compositeId.slice(i + 2) : compositeId;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function removeAllDocs(collection: any): Promise<void> {
  const docs = await collection.find().exec();
  await Promise.all(docs.map((d: { remove: () => Promise<unknown> }) => d.remove()));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function hydrateWpnLocalMirrorFromPayload(db: any, payload: WorkspaceRxdbMirrorPayloadV1): Promise<void> {
  const ws = db.local_wpn_workspaces;
  const pr = db.local_wpn_projects;
  const nt = db.local_wpn_notes;
  const ex = db.local_wpn_explorer;
  if (!ws || !pr || !nt || !ex) {
    return;
  }
  await removeAllDocs(ws);
  await removeAllDocs(pr);
  await removeAllDocs(nt);
  await removeAllDocs(ex);

  for (let slotIndex = 0; slotIndex < payload.slots.length; slotIndex++) {
    const slot = payload.slots[slotIndex]!;
    const parsed = parseWorkspaceSlotWpnArrays(slot.json);
    for (const w of parsed.workspaces) {
      const wid = typeof w.id === "string" ? w.id : "";
      if (!wid) {
        continue;
      }
      const owner_id = typeof w.owner_id === "string" ? w.owner_id : "";
      const row: LocalWpnWorkspaceMirrorRow = {
        id: compositeId(slotIndex, wid),
        slot_index: slotIndex,
        owner_id,
        name: typeof w.name === "string" ? w.name : "",
        sort_index: typeof w.sort_index === "number" ? w.sort_index : 0,
        color_token:
          w.color_token === null || typeof w.color_token === "string" ? w.color_token : null,
        created_at_ms: typeof w.created_at_ms === "number" ? w.created_at_ms : 0,
        updated_at_ms: typeof w.updated_at_ms === "number" ? w.updated_at_ms : 0,
      };
      await ws.upsert(row);
    }
    for (const p of parsed.projects) {
      const pid = typeof p.id === "string" ? p.id : "";
      if (!pid) {
        continue;
      }
      const row: LocalWpnProjectMirrorRow = {
        id: compositeId(slotIndex, pid),
        slot_index: slotIndex,
        workspace_id: typeof p.workspace_id === "string" ? p.workspace_id : "",
        name: typeof p.name === "string" ? p.name : "",
        sort_index: typeof p.sort_index === "number" ? p.sort_index : 0,
        color_token:
          p.color_token === null || typeof p.color_token === "string" ? p.color_token : null,
        created_at_ms: typeof p.created_at_ms === "number" ? p.created_at_ms : 0,
        updated_at_ms: typeof p.updated_at_ms === "number" ? p.updated_at_ms : 0,
      };
      await pr.upsert(row);
    }
    for (const n of parsed.notes) {
      const nid = typeof n.id === "string" ? n.id : "";
      if (!nid) {
        continue;
      }
      const row: LocalWpnNoteMirrorRow = {
        id: compositeId(slotIndex, nid),
        slot_index: slotIndex,
        project_id: typeof n.project_id === "string" ? n.project_id : "",
        parent_id:
          n.parent_id === null || typeof n.parent_id === "string" ? n.parent_id : null,
        type: typeof n.type === "string" ? n.type : "markdown",
        title: typeof n.title === "string" ? n.title : "",
        content: typeof n.content === "string" ? n.content : "",
        metadata_json:
          n.metadata_json === null || typeof n.metadata_json === "string"
            ? n.metadata_json
            : null,
        sibling_index: typeof n.sibling_index === "number" ? n.sibling_index : 0,
        created_at_ms: typeof n.created_at_ms === "number" ? n.created_at_ms : 0,
        updated_at_ms: typeof n.updated_at_ms === "number" ? n.updated_at_ms : 0,
      };
      await nt.upsert(row);
    }
    for (const e of parsed.explorer) {
      const project_id = typeof e.project_id === "string" ? e.project_id : "";
      if (!project_id) {
        continue;
      }
      const row: LocalWpnExplorerMirrorRow = {
        id: compositeId(slotIndex, project_id),
        slot_index: slotIndex,
        project_id,
        expanded_ids: Array.isArray(e.expanded_ids)
          ? e.expanded_ids.filter((x): x is string => typeof x === "string")
          : [],
      };
      await ex.upsert(row);
    }
  }
}

function parseMetadata(metadata_json: string | null): Record<string, unknown> | undefined {
  if (metadata_json == null || metadata_json === "") {
    return undefined;
  }
  try {
    return JSON.parse(metadata_json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tryWpnListWorkspacesFromLocalRxdb(db: any, ownerId: string): Promise<WpnWorkspaceRow[] | null> {
  const coll = db?.local_wpn_workspaces;
  if (!coll) {
    return null;
  }
  const docs = await coll.find({ selector: { owner_id: ownerId } }).exec();
  if (docs.length === 0) {
    return null;
  }
  const rows: WpnWorkspaceRow[] = docs.map((d: { toMutableJSON: (x: boolean) => LocalWpnWorkspaceMirrorRow }) => {
    const j = d.toMutableJSON(false);
    return {
      id: entityIdFromComposite(j.id),
      name: j.name,
      sort_index: j.sort_index,
      color_token: j.color_token,
      created_at_ms: j.created_at_ms,
      updated_at_ms: j.updated_at_ms,
    };
  });
  rows.sort((a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name));
  return rows;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tryWpnListProjectsFromLocalRxdb(
  db: any,
  workspaceId: string,
): Promise<WpnProjectRow[] | null> {
  const coll = db?.local_wpn_projects;
  if (!coll) {
    return null;
  }
  const docs = await coll.find({ selector: { workspace_id: workspaceId } }).exec();
  if (docs.length === 0) {
    return null;
  }
  const rows: WpnProjectRow[] = docs.map((d: { toMutableJSON: (x: boolean) => LocalWpnProjectMirrorRow }) => {
    const j = d.toMutableJSON(false);
    return {
      id: entityIdFromComposite(j.id),
      workspace_id: j.workspace_id,
      name: j.name,
      sort_index: j.sort_index,
      color_token: j.color_token,
      created_at_ms: j.created_at_ms,
      updated_at_ms: j.updated_at_ms,
    };
  });
  rows.sort((a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name));
  return rows;
}

function noteDepth(notes: WpnNoteRow[], id: string): number {
  const byId = new Map(notes.map((x) => [x.id, x]));
  let depth = 0;
  let cur: string | null = id;
  const guard = new Set<string>();
  while (cur) {
    if (guard.has(cur)) {
      break;
    }
    guard.add(cur);
    const row = byId.get(cur);
    if (!row) {
      break;
    }
    depth++;
    cur = row.parent_id;
  }
  return depth;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tryWpnListNotesFromLocalRxdb(db: any, projectId: string): Promise<WpnNoteListItem[] | null> {
  const coll = db?.local_wpn_notes;
  if (!coll) {
    return null;
  }
  const docs = await coll.find({ selector: { project_id: projectId } }).exec();
  if (docs.length === 0) {
    return null;
  }
  const notes: WpnNoteRow[] = docs.map((d: { toMutableJSON: (x: boolean) => LocalWpnNoteMirrorRow }) => {
    const j = d.toMutableJSON(false);
    return {
      id: entityIdFromComposite(j.id),
      project_id: j.project_id,
      parent_id: j.parent_id,
      type: j.type,
      title: j.title,
      content: j.content,
      metadata_json: j.metadata_json,
      sibling_index: j.sibling_index,
      created_at_ms: j.created_at_ms,
      updated_at_ms: j.updated_at_ms,
    };
  });
  return notes.map((n) => ({
    id: n.id,
    project_id: n.project_id,
    parent_id: n.parent_id,
    type: n.type,
    title: n.title,
    depth: noteDepth(notes, n.id),
    sibling_index: n.sibling_index,
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tryWpnGetNoteFromLocalRxdb(db: any, noteId: string): Promise<WpnNoteDetail | null> {
  const coll = db?.local_wpn_notes;
  if (!coll) {
    return null;
  }
  const docs = await coll.find().exec();
  const hit = docs.find(
    (d: { id: string }) => entityIdFromComposite(d.id) === noteId || d.id === noteId,
  );
  if (!hit) {
    return null;
  }
  const j = hit.toMutableJSON(false) as LocalWpnNoteMirrorRow;
  const realId = entityIdFromComposite(j.id);
  const meta = parseMetadata(j.metadata_json);
  return {
    id: realId,
    project_id: j.project_id,
    parent_id: j.parent_id,
    type: j.type,
    title: j.title,
    content: j.content,
    metadata: meta,
    sibling_index: j.sibling_index,
    created_at_ms: j.created_at_ms,
    updated_at_ms: j.updated_at_ms,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tryWpnGetExplorerStateFromLocalRxdb(
  db: any,
  projectId: string,
): Promise<string[] | null> {
  const coll = db?.local_wpn_explorer;
  if (!coll) {
    return null;
  }
  const docs = await coll.find({ selector: { project_id: projectId } }).exec();
  if (docs.length === 0) {
    return null;
  }
  const j = docs[0]!.toMutableJSON(false) as LocalWpnExplorerMirrorRow;
  return [...j.expanded_ids];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tryWpnListAllNotesWithContextFromLocalRxdb(
  db: any,
): Promise<WpnNoteWithContextListItem[] | null> {
  const wcoll = db?.local_wpn_workspaces;
  const pcoll = db?.local_wpn_projects;
  const ncoll = db?.local_wpn_notes;
  if (!wcoll || !pcoll || !ncoll) {
    return null;
  }
  const wdocs = await wcoll.find().exec();
  const pdocs = await pcoll.find().exec();
  const ndocs = await ncoll.find().exec();
  if (ndocs.length === 0) {
    return null;
  }
  const wsById = new Map<string, { name: string }>();
  for (const d of wdocs) {
    const j = d.toMutableJSON(false) as LocalWpnWorkspaceMirrorRow;
    const wid = entityIdFromComposite(j.id);
    wsById.set(wid, { name: j.name });
  }
  const projById = new Map<string, { name: string; workspace_id: string }>();
  for (const d of pdocs) {
    const j = d.toMutableJSON(false) as LocalWpnProjectMirrorRow;
    const pid = entityIdFromComposite(j.id);
    projById.set(pid, { name: j.name, workspace_id: j.workspace_id });
  }
  const out: WpnNoteWithContextListItem[] = [];
  for (const d of ndocs) {
    const n = d.toMutableJSON(false) as LocalWpnNoteMirrorRow;
    const nid = entityIdFromComposite(n.id);
    const p = projById.get(n.project_id);
    const w = p ? wsById.get(p.workspace_id) : undefined;
    if (!p || !w) {
      continue;
    }
    out.push({
      id: nid,
      title: n.title,
      type: n.type,
      project_id: n.project_id,
      project_name: p.name,
      workspace_id: p.workspace_id,
      workspace_name: w.name,
      parent_id: n.parent_id,
    });
  }
  if (out.length === 0) {
    return null;
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tryWpnListBacklinksFromLocalRxdb(
  db: any,
  targetNoteId: string,
): Promise<WpnBacklinkSourceItem[] | null> {
  const ncoll = db?.local_wpn_notes;
  if (!ncoll) {
    return null;
  }
  const needle = `#/w/${targetNoteId}`;
  const ndocs = await ncoll.find().exec();
  const sources: WpnBacklinkSourceItem[] = [];
  for (const d of ndocs) {
    const n = d.toMutableJSON(false) as LocalWpnNoteMirrorRow;
    const nid = entityIdFromComposite(n.id);
    if (nid === targetNoteId) {
      continue;
    }
    if (typeof n.content === "string" && n.content.includes(needle)) {
      sources.push({
        id: nid,
        title: n.title,
        project_id: n.project_id,
      });
    }
  }
  return sources.length > 0 ? sources : null;
}
