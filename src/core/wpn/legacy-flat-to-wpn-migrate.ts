import { getNoteById, getNotesFlat, resetNotesStore } from "../notes-store";
import type { WorkspaceStore } from "../workspace-store";
import { normalizeLegacyNoteType } from "../../shared/note-type-legacy";
import {
  isLegacyFlatToWpnMigrationDisabled,
} from "../../shared/wpn-file-vault-env";
import type { WpnNoteRow } from "./wpn-types";
import { wpnJsonCreateProject, wpnJsonCreateWorkspace } from "./wpn-json-service";
import { getWpnOwnerId } from "./wpn-owner";

const MIGRATED_META = "legacy_flat_to_wpn_migrated_v1";

function emptyLegacySlot(): { v: 1; records: never[]; order: Record<string, never[]> } {
  return { v: 1, records: [], order: {} };
}

/**
 * One-time: copy the in-memory flat tree (from `slot.legacy` / `notes-store`) into WPN rows
 * on the primary slot, then clear `slot.legacy` and mark appMeta so re-open is idempotent.
 */
export function migrateLegacyFlatToWpnInPrimarySlot(store: WorkspaceStore): boolean {
  if (isLegacyFlatToWpnMigrationDisabled()) {
    return false;
  }
  const slot0 = store.slots[0]!;
  if (slot0.appMeta[MIGRATED_META] === "1") {
    return false;
  }
  if (slot0.notes.length > 0) {
    return false;
  }
  if (slot0.workspaces.length > 0 || slot0.projects.length > 0) {
    return false;
  }
  const flat = getNotesFlat();
  if (flat.length === 0) {
    return false;
  }
  const ownerId = getWpnOwnerId();
  const ws = wpnJsonCreateWorkspace(store, ownerId, "Workspace");
  const proj = wpnJsonCreateProject(store, ownerId, ws.id, "Notes");
  if (!proj) {
    return false;
  }
  const projectId = proj.id;
  const byParent = new Map<string | null, typeof flat>();
  for (const row of flat) {
    const pid = row.parentId ?? null;
    const arr = byParent.get(pid) ?? [];
    arr.push(row);
    byParent.set(pid, arr);
  }
  const siblingIndex = new Map<string, number>();
  for (const [, rows] of byParent) {
    rows.forEach((r, i) => siblingIndex.set(r.id, i));
  }
  const t = Date.now();
  for (const row of flat) {
    const rec = getNoteById(row.id);
    if (!rec) {
      continue;
    }
    const noteRow: WpnNoteRow = {
      id: rec.id,
      project_id: projectId,
      parent_id: rec.parentId,
      type: normalizeLegacyNoteType(rec.type),
      title: rec.title,
      content: rec.content,
      metadata_json:
        rec.metadata && Object.keys(rec.metadata).length > 0
          ? JSON.stringify(rec.metadata)
          : null,
      sibling_index: siblingIndex.get(rec.id) ?? 0,
      created_at_ms: t,
      updated_at_ms: t,
    };
    slot0.notes.push(noteRow);
  }
  slot0.explorer.push({ project_id: projectId, expanded_ids: [] });
  slot0.legacy = emptyLegacySlot();
  slot0.appMeta[MIGRATED_META] = "1";
  resetNotesStore();
  store.persist();
  return true;
}
