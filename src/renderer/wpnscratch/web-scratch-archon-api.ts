/**
 * When the browser try-out session is on and the user has no access token, route WPN + note
 * APIs to browser-local IndexedDB instead of HTTP. Electron does not use this — packaged
 * apps use empty `workspaceRoots` + {@link setElectronIdbScratchOverlay} / preload `Archon`.
 */
import { PLUGIN_UI_METADATA_KEY, validatePluginUiStateSize } from "../../shared/plugin-state-protocol";
import type { ArchonRendererApi, PasteSubtreePayload } from "../../shared/archon-renderer-api";
import { getAccessToken } from "../auth/auth-session";
import { isWebScratchSession } from "../auth/web-scratch";

const WPN_BUILTIN_NOTE_TYPES = ["markdown", "mdx", "text", "code", "root", "image"] as const;

import {
  scratchDeleteNotes,
  scratchGetAllNoteListItems,
  scratchGetNoteForEditor,
  scratchRenameNote,
  scratchSaveNoteContent,
  scratchWpnBuildExportBundle,
  scratchWpnCreateNoteInProject,
  scratchWpnCreateProject,
  scratchWpnCreateWorkspace,
  scratchWpnDeleteNotes,
  scratchWpnDeleteProject,
  scratchWpnDeleteWorkspace,
  scratchWpnDuplicateNoteSubtree,
  scratchWpnGetExplorerState,
  scratchWpnGetFullTree,
  scratchWpnGetNote,
  scratchWpnImportFromBundle,
  scratchWpnListAllNotesWithContext,
  scratchWpnListBacklinksToNote,
  scratchWpnListNotes,
  scratchWpnListProjects,
  scratchWpnListWorkspaces,
  scratchWpnListWorkspacesAndProjects,
  scratchWpnMoveNote,
  scratchWpnPatchNote,
  scratchWpnPreviewNoteTitleVfsImpact,
  scratchWpnSetExplorerState,
  scratchWpnUpdateProject,
  scratchWpnUpdateWorkspace,
} from "./wpn-scratch-store";
import { ensureScratchMarkdownProjectId } from "../shell/wpnScratchProject";

/** Web-only: `archon.web.scratchSession` + no sync token → WPN in IndexedDB. */
export function useWebTryoutWpnIndexedDb(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return isWebScratchSession() && !getAccessToken();
  } catch {
    return false;
  }
}

/** @deprecated Use {@link useWebTryoutWpnIndexedDb}. */
export function useWebScratchLocalFirst(): boolean {
  return useWebTryoutWpnIndexedDb();
}

async function scratchResolveProjectIdForNote(noteId: string): Promise<string | null> {
  const r = await scratchWpnGetNote(noteId);
  return r?.note.project_id ?? null;
}

/** Partial `window.Archon` overrides merged into the plain-browser stub when scratch is active. */
export function webScratchPlainStubOverrides(): Partial<ArchonRendererApi> {
  return {
    getNote: (noteId) => scratchGetNoteForEditor(noteId),
    getAllNotes: () => scratchGetAllNoteListItems(),
    getProjectState: async () => ({
      rootPath: null,
      notesDbPath: null,
      workspaceRoots: ["archon-web-scratch"],
      workspaceLabels: {},
    }),
    getRegisteredTypes: async () => [...WPN_BUILTIN_NOTE_TYPES],
    getSelectableNoteTypes: async () =>
      [...WPN_BUILTIN_NOTE_TYPES].filter((t) => t !== "root"),
    createNote: async (payload) => {
      const projectId = await ensureScratchMarkdownProjectId();
      return scratchWpnCreateNoteInProject(projectId, payload);
    },
    renameNote: (id, title, options) => scratchRenameNote(id, title, options),
    deleteNotes: (ids) => scratchDeleteNotes(ids),
    moveNote: async (draggedId, targetId, placement) => {
      const pd = await scratchResolveProjectIdForNote(draggedId);
      const pt = await scratchResolveProjectIdForNote(targetId);
      if (!pd || !pt || pd !== pt) {
        throw new Error(
          "moveNote: dragged and target notes must exist in the same WPN project",
        );
      }
      await scratchWpnMoveNote({ projectId: pd, draggedId, targetId, placement });
    },
    moveNotesBulk: async (ids, targetId, placement) => {
      for (const id of ids) {
        const pd = await scratchResolveProjectIdForNote(id);
        const pt = await scratchResolveProjectIdForNote(targetId);
        if (!pd || !pt || pd !== pt) {
          throw new Error("moveNotesBulk: notes must be in the same WPN project");
        }
        await scratchWpnMoveNote({ projectId: pd, draggedId: id, targetId, placement });
      }
    },
    pasteSubtree: async (payload: PasteSubtreePayload) => {
      const { sourceId, targetId, mode, placement } = payload;
      const projectId = await scratchResolveProjectIdForNote(sourceId);
      const pt = await scratchResolveProjectIdForNote(targetId);
      if (!projectId || !pt || projectId !== pt) {
        throw new Error("pasteSubtree: source and target notes must be in the same WPN project");
      }
      if (mode === "cut") {
        await scratchWpnMoveNote({ projectId, draggedId: sourceId, targetId, placement });
        return {};
      }
      const dup = await scratchWpnDuplicateNoteSubtree(projectId, sourceId);
      await scratchWpnMoveNote({
        projectId,
        draggedId: dup.newRootId,
        targetId,
        placement,
      });
      return { newRootId: dup.newRootId };
    },
    saveNotePluginUiState: async (noteId, state) => {
      const err = validatePluginUiStateSize(state);
      if (err) {
        throw new Error(err);
      }
      const cur = await scratchWpnGetNote(noteId);
      if (!cur) {
        throw new Error("Note not found");
      }
      const meta = {
        ...(cur.note.metadata && typeof cur.note.metadata === "object" ? cur.note.metadata : {}),
        [PLUGIN_UI_METADATA_KEY]: state,
      };
      await scratchWpnPatchNote(noteId, { metadata: meta });
    },
    saveNoteContent: (noteId, content) => scratchSaveNoteContent(noteId, content),
    patchNoteMetadata: async (noteId, patch) => {
      const cur = await scratchWpnGetNote(noteId);
      if (!cur) {
        throw new Error("patchNoteMetadata: WPN note not found");
      }
      const meta = {
        ...(cur.note.metadata && typeof cur.note.metadata === "object" ? cur.note.metadata : {}),
        ...patch,
      };
      await scratchWpnPatchNote(noteId, { metadata: meta });
    },
    wpnListWorkspaces: () => scratchWpnListWorkspaces(),
    wpnListWorkspacesAndProjects: () => scratchWpnListWorkspacesAndProjects(),
    wpnGetFullTree: () => scratchWpnGetFullTree(),
    wpnCreateWorkspace: (name) => scratchWpnCreateWorkspace(name),
    wpnUpdateWorkspace: async (id, patch) => {
      const r = await scratchWpnUpdateWorkspace(id, patch);
      if (!r) {
        throw new Error("Workspace not found");
      }
      return r;
    },
    wpnDeleteWorkspace: async (id) => {
      const r = await scratchWpnDeleteWorkspace(id);
      if (!r) {
        throw new Error("Workspace not found");
      }
      return r;
    },
    wpnListProjects: (workspaceId) => scratchWpnListProjects(workspaceId),
    wpnCreateProject: async (workspaceId, name) => {
      const r = await scratchWpnCreateProject(workspaceId, name);
      if (!r) {
        throw new Error("Workspace not found");
      }
      return r;
    },
    wpnUpdateProject: async (id, patch) => {
      const r = await scratchWpnUpdateProject(id, patch);
      if (!r) {
        throw new Error("Project not found");
      }
      return r;
    },
    wpnDeleteProject: async (id) => {
      const r = await scratchWpnDeleteProject(id);
      if (!r) {
        throw new Error("Project not found");
      }
      return r;
    },
    wpnListNotes: (projectId) => scratchWpnListNotes(projectId),
    wpnListAllNotesWithContext: () => scratchWpnListAllNotesWithContext(),
    wpnListBacklinksToNote: (targetNoteId) => scratchWpnListBacklinksToNote(targetNoteId),
    wpnGetNote: async (noteId) => {
      const r = await scratchWpnGetNote(noteId);
      if (!r) {
        throw new Error("Note not found");
      }
      return r;
    },
    wpnGetExplorerState: (projectId) => scratchWpnGetExplorerState(projectId),
    wpnSetExplorerState: (projectId, expandedIds) =>
      scratchWpnSetExplorerState(projectId, expandedIds),
    wpnCreateNoteInProject: (projectId, payload) =>
      scratchWpnCreateNoteInProject(projectId, payload),
    wpnPreviewNoteTitleVfsImpact: (noteId, newTitle) =>
      scratchWpnPreviewNoteTitleVfsImpact(noteId, newTitle),
    wpnPatchNote: async (noteId, patch) => {
      const r = await scratchWpnPatchNote(noteId, patch);
      if (!r) {
        throw new Error("Note not found");
      }
      return r;
    },
    wpnDeleteNotes: (ids) => scratchWpnDeleteNotes(ids),
    wpnMoveNote: (payload) => scratchWpnMoveNote(payload),
    wpnDuplicateNoteSubtree: (projectId, noteId) =>
      scratchWpnDuplicateNoteSubtree(projectId, noteId),
    wpnExportWorkspaces: async (workspaceIds?: string[]) => {
      const { zipSync, strToU8 } = await import("fflate");
      const { metadata, noteContents } = await scratchWpnBuildExportBundle(workspaceIds);
      const files: Record<string, Uint8Array> = {
        "metadata.json": strToU8(JSON.stringify(metadata, null, 2)),
      };
      for (const [noteId, content] of noteContents) {
        files[`notes/${noteId}.md`] = strToU8(content);
      }
      const zipped = zipSync(files, { level: 6 });
      const blob = new Blob([new Uint8Array(zipped)], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "archon-export.zip";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    },
    wpnImportWorkspaces: async (file?: File) => {
      let zipFile = file;
      if (!zipFile) {
        zipFile = await new Promise<File>((resolve, reject) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".zip";
          input.onchange = () => {
            const f = input.files?.[0];
            if (f) resolve(f); else reject(new Error("No file selected"));
          };
          input.click();
        });
      }
      const { unzipSync, strFromU8 } = await import("fflate");
      const buf = new Uint8Array(await zipFile.arrayBuffer());
      const unzipped = unzipSync(buf);
      const metaBytes = unzipped["metadata.json"];
      if (!metaBytes) throw new Error("Invalid ZIP: missing metadata.json");
      const metadata = JSON.parse(strFromU8(metaBytes)) as import("../../shared/wpn-import-export-types").WpnExportMetadata;
      if (metadata.version !== 1) throw new Error("Unsupported export version");
      const noteContents = new Map<string, string>();
      for (const [path, data] of Object.entries(unzipped)) {
        if (path.startsWith("notes/") && path.endsWith(".md")) {
          noteContents.set(path.slice(6, -3), strFromU8(data));
        }
      }
      return scratchWpnImportFromBundle(metadata, noteContents);
    },
  };
}
