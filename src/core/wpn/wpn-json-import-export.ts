import * as crypto from "crypto";
import type { WorkspaceStore, WpnWorkspaceStored } from "../workspace-store";
import type { WpnProjectRow, WpnNoteRow } from "./wpn-types";
import type {
  WpnExportMetadata,
  WpnExportWorkspaceEntry,
  WpnExportProjectEntry,
  WpnExportNoteEntry,
  WpnImportResult,
} from "../../shared/wpn-import-export-types";

function nowMs(): number {
  return Date.now();
}

function newId(): string {
  return crypto.randomUUID();
}

/**
 * Build an export bundle from the local JSON workspace store.
 * Returns the metadata.json content and a Map of noteId→content.
 */
export function wpnJsonBuildExportBundle(
  store: WorkspaceStore,
  ownerId: string,
  workspaceIds?: string[],
): { metadata: WpnExportMetadata; noteContents: Map<string, string> } {
  const filterIds = workspaceIds && workspaceIds.length > 0 ? new Set(workspaceIds) : null;
  const noteContents = new Map<string, string>();

  const workspaces: WpnExportWorkspaceEntry[] = [];

  for (const slot of store.slots) {
    const wsRows = slot.workspaces
      .filter((w) => w.owner_id === ownerId && (!filterIds || filterIds.has(w.id)))
      .sort((a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name));

    for (const ws of wsRows) {
      const projects: WpnExportProjectEntry[] = [];
      const projRows = slot.projects
        .filter((p) => p.workspace_id === ws.id)
        .sort((a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name));

      for (const proj of projRows) {
        const noteRows = slot.notes.filter((n) => n.project_id === proj.id);
        const notes: WpnExportNoteEntry[] = noteRows.map((n) => {
          noteContents.set(n.id, n.content ?? "");
          let metadata: Record<string, unknown> | null = null;
          if (n.metadata_json) {
            try {
              metadata = JSON.parse(n.metadata_json) as Record<string, unknown>;
            } catch {
              metadata = null;
            }
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
  }

  const metadata: WpnExportMetadata = {
    version: 1,
    exported_at_ms: nowMs(),
    workspaces,
  };

  return { metadata, noteContents };
}

/**
 * Import workspaces/projects/notes from export metadata into the local JSON store.
 * Creates fresh IDs, remaps parent_id references, handles duplicate workspace names.
 */
export function wpnJsonImportFromBundle(
  store: WorkspaceStore,
  ownerId: string,
  metadata: WpnExportMetadata,
  noteContents: Map<string, string>,
): WpnImportResult {
  const slot = store.slots[0];
  if (!slot) {
    throw new Error("No workspace slot available");
  }

  const existingNames = new Set(
    slot.workspaces.filter((w) => w.owner_id === ownerId).map((w) => w.name),
  );

  let maxWsSortIndex = slot.workspaces
    .filter((w) => w.owner_id === ownerId)
    .reduce((m, w) => Math.max(m, w.sort_index), -1);

  let importedWs = 0;
  let importedProj = 0;
  let importedNotes = 0;
  const t = nowMs();

  for (const wsEntry of metadata.workspaces) {
    let wsName = wsEntry.name;
    if (existingNames.has(wsName)) {
      let suffix = 1;
      while (existingNames.has(`${wsEntry.name} ${suffix}`)) {
        suffix++;
      }
      wsName = `${wsEntry.name} ${suffix}`;
    }
    existingNames.add(wsName);

    const newWsId = newId();
    const wsRow: WpnWorkspaceStored = {
      id: newWsId,
      name: wsName,
      sort_index: ++maxWsSortIndex,
      color_token: wsEntry.color_token,
      created_at_ms: t,
      updated_at_ms: t,
      owner_id: ownerId,
    };
    slot.workspaces.push(wsRow);
    importedWs++;

    let nextProjSortIndex = 0;
    for (const projEntry of wsEntry.projects) {
      const newProjId = newId();
      const projRow: WpnProjectRow = {
        id: newProjId,
        workspace_id: newWsId,
        name: projEntry.name,
        sort_index: nextProjSortIndex++,
        color_token: projEntry.color_token,
        created_at_ms: t,
        updated_at_ms: t,
      };
      slot.projects.push(projRow);
      importedProj++;

      // Build old→new ID map
      const idMap = new Map<string, string>();
      for (const noteEntry of projEntry.notes) {
        idMap.set(noteEntry.id, newId());
      }

      for (const noteEntry of projEntry.notes) {
        const newNoteId = idMap.get(noteEntry.id)!;
        const newParentId =
          noteEntry.parent_id !== null
            ? idMap.get(noteEntry.parent_id) ?? null
            : null;
        const content = noteContents.get(noteEntry.id) ?? "";
        const metadata_json =
          noteEntry.metadata && Object.keys(noteEntry.metadata).length > 0
            ? JSON.stringify(noteEntry.metadata)
            : null;

        const noteRow: WpnNoteRow = {
          id: newNoteId,
          project_id: newProjId,
          parent_id: newParentId,
          type: noteEntry.type,
          title: noteEntry.title,
          content,
          metadata_json,
          sibling_index: noteEntry.sibling_index,
          created_at_ms: t,
          updated_at_ms: t,
        };
        slot.notes.push(noteRow);
        importedNotes++;
      }
    }
  }

  store.persist();
  return { workspaces: importedWs, projects: importedProj, notes: importedNotes };
}
