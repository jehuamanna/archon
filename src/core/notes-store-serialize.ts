import { randomUUID } from "crypto";
import * as path from "path";
import { normalizeLegacyNoteType } from "../shared/note-type-legacy";
import {
  childOrder,
  getChildren,
  notes,
  ROOT_KEY,
  setChildren,
  type NoteRecord,
} from "./notes-store-core";
import { registry } from "./registry";
import {
  bodyForType,
  getSeedSampleNotesPreference,
  overviewTitleAndBody,
  pickWorkspaceOverviewType,
  sampleChildNoteTypes,
  titleForType,
} from "./notes-store-seed";

export type SerializedNotesState = {
  v: 1;
  records: NoteRecord[];
  order: Record<string, string[]>;
};

export function mergeAttachedSerializedIntoStore(
  mountIndex: number,
  folderAbsPath: string,
  data: SerializedNotesState,
  registeredTypes: string[],
): void {
  const mountId = `__archon_mount_${mountIndex}`;
  const rootType = registeredTypes.includes("root")
    ? "root"
    : registeredTypes[0]!;
  const title = path.basename(folderAbsPath);
  notes.set(mountId, {
    id: mountId,
    parentId: null,
    type: rootType,
    title,
    content: `_Notes from added folder: \`${title}\`_`,
    metadata: {
      archonWorkspaceMount: true,
      archonMountPath: folderAbsPath,
    },
  });

  const pref = `r${mountIndex}_`;
  const idMap = new Map<string, string>();
  for (const r of data.records) {
    idMap.set(r.id, pref + r.id);
  }

  for (const r of data.records) {
    const newId = idMap.get(r.id)!;
    const newParent =
      r.parentId == null ? mountId : (idMap.get(r.parentId) ?? mountId);
    notes.set(newId, {
      id: newId,
      parentId: newParent,
      type: normalizeLegacyNoteType(r.type),
      title: r.title,
      content: r.content,
      metadata: r.metadata,
    });
  }

  for (const [k, ids] of Object.entries(data.order)) {
    if (!Array.isArray(ids)) {
      continue;
    }
    const mappedKey = k === ROOT_KEY ? mountId : (idMap.get(k) ?? "");
    if (mappedKey === "") {
      continue;
    }
    const mappedIds = ids
      .map((id) => idMap.get(id))
      .filter((x): x is string => typeof x === "string");
    setChildren(mappedKey, mappedIds);
  }

  const roots = [...getChildren(null), mountId];
  setChildren(null, roots);
}

export function seedAttachedWorkspaceIfEmpty(
  mountIndex: number,
  registeredTypes: string[],
): void {
  if (!getSeedSampleNotesPreference() || registeredTypes.length === 0) {
    return;
  }
  const mountId = `__archon_mount_${mountIndex}`;
  if (getChildren(mountId).length > 0) {
    return;
  }
  const pref = `r${mountIndex}_`;
  const overviewType = pickWorkspaceOverviewType(registeredTypes);
  if (!overviewType) {
    return;
  }
  const { title: overviewTitle, content, metadata } =
    overviewTitleAndBody(overviewType);
  const homeId = `${pref}${randomUUID()}`;
  notes.set(homeId, {
    id: homeId,
    parentId: mountId,
    type: overviewType,
    title: overviewTitle,
    content,
    metadata,
  });
  const childTypes = sampleChildNoteTypes(
    overviewType,
    registry.getSelectableNoteTypes(),
  );
  const childIds: string[] = [];
  for (const type of childTypes) {
    const id = `${pref}${randomUUID()}`;
    const body = bodyForType(type);
    notes.set(id, {
      id,
      parentId: homeId,
      type,
      title: titleForType(type),
      content: body.content,
      metadata: body.metadata,
    });
    childIds.push(id);
  }
  setChildren(mountId, [homeId]);
  setChildren(homeId, childIds);
}

export function exportSerializedState(): SerializedNotesState {
  return {
    v: 1,
    records: Array.from(notes.values()),
    order: Object.fromEntries(childOrder.entries()),
  };
}

export function importSerializedState(data: unknown): boolean {
  if (!data || typeof data !== "object") {
    return false;
  }
  const d = data as Partial<SerializedNotesState>;
  if (d.v !== 1 || !Array.isArray(d.records) || !d.order || typeof d.order !== "object") {
    return false;
  }
  notes.clear();
  childOrder.clear();
  for (const r of d.records) {
    if (!r?.id || typeof r.type !== "string") {
      continue;
    }
    notes.set(r.id, {
      id: r.id,
      parentId: r.parentId ?? null,
      type: normalizeLegacyNoteType(r.type),
      title: typeof r.title === "string" ? r.title : "Untitled",
      content: typeof r.content === "string" ? r.content : "",
      metadata: r.metadata,
    });
  }
  for (const [k, v] of Object.entries(d.order)) {
    if (Array.isArray(v)) {
      childOrder.set(k, v.filter((x) => typeof x === "string"));
    }
  }
  return notes.size > 0;
}
