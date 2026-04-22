import { ipcMain } from "electron";
import { assertElectronFileVaultWindow } from "./electron-wpn-backend";
import { registry } from "../core/registry";
import { getNotesDatabase } from "../core/workspace-store";
import { getWpnOwnerId } from "../core/wpn/wpn-owner";
import {
  wpnJsonCreateProject,
  wpnJsonCreateWorkspace,
  wpnJsonDeleteProject,
  wpnJsonDeleteWorkspace,
  wpnJsonGetFullTree,
  wpnJsonListProjects,
  wpnJsonListWorkspaces,
  wpnJsonListWorkspacesAndProjects,
  wpnJsonUpdateProject,
  wpnJsonUpdateWorkspace,
} from "../core/wpn/wpn-json-service";
import {
  wpnJsonBuildExportBundle,
  wpnJsonImportFromBundle,
} from "../core/wpn/wpn-json-import-export";
import {
  wpnJsonCreateNote,
  wpnJsonDeleteNotes,
  wpnJsonDuplicateNoteSubtree,
  wpnJsonGetExplorerExpanded,
  wpnJsonGetNoteById,
  wpnJsonGetNoteWithContextById,
  wpnJsonListAllNotesWithContext,
  wpnJsonListBacklinksToNote,
  wpnJsonListNotesFlat,
  wpnJsonMoveNote,
  wpnJsonMoveNoteCrossProject,
  wpnJsonSetExplorerExpanded,
  wpnJsonUpdateNote,
} from "../core/wpn/wpn-json-notes";
import {
  wpnJsonApplyVfsRewritesAfterMove,
  wpnJsonApplyVfsRewritesAfterTitleChange,
  wpnJsonPreviewVfsRewritesAfterMove,
  wpnJsonPreviewVfsRewritesAfterTitleChange,
} from "../core/wpn/wpn-rename-vfs-rewrite";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import type { NoteMovePlacement } from "../shared/archon-renderer-api";
import { convertTreeRelativeLinksToAbsolute } from "../shared/note-vfs-link-rewrite";
import { isValidNoteId, isValidNoteType } from "../shared/validators";
import type {
  WpnProjectPatch,
  WpnWorkspacePatch,
} from "../shared/wpn-v2-types";
import { assertProjectOpenForNotes } from "./main-helpers";

function requireWorkspaceStore() {
  assertProjectOpenForNotes();
  const store = getNotesDatabase();
  if (!store) {
    throw new Error("Workspace store is not open");
  }
  return store;
}

export function registerStaticIpcWpnHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.WPN_LIST_WORKSPACES, async (e) => {
    assertElectronFileVaultWindow(e);
    const db = requireWorkspaceStore();
    const ownerId = getWpnOwnerId();
    return { workspaces: wpnJsonListWorkspaces(db, ownerId) };
  });

  ipcMain.handle(IPC_CHANNELS.WPN_LIST_WORKSPACES_AND_PROJECTS, async (e) => {
    assertElectronFileVaultWindow(e);
    const db = requireWorkspaceStore();
    const ownerId = getWpnOwnerId();
    return wpnJsonListWorkspacesAndProjects(db, ownerId);
  });

  ipcMain.handle(IPC_CHANNELS.WPN_GET_FULL_TREE, async (e) => {
    assertElectronFileVaultWindow(e);
    const db = requireWorkspaceStore();
    const ownerId = getWpnOwnerId();
    return wpnJsonGetFullTree(db, ownerId);
  });

  ipcMain.handle(IPC_CHANNELS.WPN_CREATE_WORKSPACE, async (e, name?: unknown) => {
    assertElectronFileVaultWindow(e);
    const db = requireWorkspaceStore();
    const ownerId = getWpnOwnerId();
    const n = typeof name === "string" ? name : "Workspace";
    const workspace = wpnJsonCreateWorkspace(db, ownerId, n);
    return { workspace };
  });

  ipcMain.handle(
    IPC_CHANNELS.WPN_UPDATE_WORKSPACE,
    async (e, id: unknown, patch: unknown) => {
      assertElectronFileVaultWindow(e);
      if (typeof id !== "string" || !id) {
        throw new Error("Invalid workspace id");
      }
      const db = requireWorkspaceStore();
      const ownerId = getWpnOwnerId();
      const p = (patch && typeof patch === "object"
        ? patch
        : {}) as WpnWorkspacePatch;
      const workspace = wpnJsonUpdateWorkspace(db, ownerId, id, p);
      if (!workspace) {
        throw new Error("Workspace not found");
      }
      return { workspace };
    },
  );

  ipcMain.handle(IPC_CHANNELS.WPN_DELETE_WORKSPACE, async (e, id: unknown) => {
    assertElectronFileVaultWindow(e);
    if (typeof id !== "string" || !id) {
      throw new Error("Invalid workspace id");
    }
    const db = requireWorkspaceStore();
    const ownerId = getWpnOwnerId();
    const ok = wpnJsonDeleteWorkspace(db, ownerId, id);
    if (!ok) {
      throw new Error("Workspace not found");
    }
    return { ok: true as const };
  });

  ipcMain.handle(
    IPC_CHANNELS.WPN_LIST_PROJECTS,
    async (e, workspaceId: unknown) => {
      assertElectronFileVaultWindow(e);
      if (typeof workspaceId !== "string" || !workspaceId) {
        throw new Error("Invalid workspace id");
      }
      const db = requireWorkspaceStore();
      const ownerId = getWpnOwnerId();
      return { projects: wpnJsonListProjects(db, ownerId, workspaceId) };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WPN_CREATE_PROJECT,
    async (e, workspaceId: unknown, name?: unknown) => {
      assertElectronFileVaultWindow(e);
      if (typeof workspaceId !== "string" || !workspaceId) {
        throw new Error("Invalid workspace id");
      }
      const db = requireWorkspaceStore();
      const ownerId = getWpnOwnerId();
      const n = typeof name === "string" ? name : "Project";
      const project = wpnJsonCreateProject(db, ownerId, workspaceId, n);
      if (!project) {
        throw new Error("Workspace not found");
      }
      return { project };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WPN_UPDATE_PROJECT,
    async (e, id: unknown, patch: unknown) => {
      assertElectronFileVaultWindow(e);
      if (typeof id !== "string" || !id) {
        throw new Error("Invalid project id");
      }
      const db = requireWorkspaceStore();
      const ownerId = getWpnOwnerId();
      const p = (patch && typeof patch === "object"
        ? patch
        : {}) as WpnProjectPatch;
      const project = wpnJsonUpdateProject(db, ownerId, id, p);
      if (!project) {
        throw new Error("Project not found");
      }
      return { project };
    },
  );

  ipcMain.handle(IPC_CHANNELS.WPN_DELETE_PROJECT, async (e, id: unknown) => {
    assertElectronFileVaultWindow(e);
    if (typeof id !== "string" || !id) {
      throw new Error("Invalid project id");
    }
    const db = requireWorkspaceStore();
    const ownerId = getWpnOwnerId();
    const ok = wpnJsonDeleteProject(db, ownerId, id);
    if (!ok) {
      throw new Error("Project not found");
    }
    return { ok: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.WPN_LIST_NOTES, async (e, projectId: unknown) => {
    assertElectronFileVaultWindow(e);
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project id");
    }
    const db = requireWorkspaceStore();
    const ownerId = getWpnOwnerId();
    return { notes: wpnJsonListNotesFlat(db, ownerId, projectId) };
  });

  ipcMain.handle(IPC_CHANNELS.WPN_LIST_ALL_NOTES_WITH_CONTEXT, async (e) => {
    assertElectronFileVaultWindow(e);
    const db = requireWorkspaceStore();
    const ownerId = getWpnOwnerId();
    return { notes: wpnJsonListAllNotesWithContext(db, ownerId) };
  });

  ipcMain.handle(IPC_CHANNELS.WPN_LIST_BACKLINKS_TO_NOTE, async (e, targetNoteId: unknown) => {
    assertElectronFileVaultWindow(e);
    if (typeof targetNoteId !== "string" || !targetNoteId) {
      throw new Error("Invalid note id");
    }
    const db = requireWorkspaceStore();
    const ownerId = getWpnOwnerId();
    return { sources: wpnJsonListBacklinksToNote(db, ownerId, targetNoteId) };
  });

  ipcMain.handle(IPC_CHANNELS.WPN_GET_NOTE, async (e, noteId: unknown) => {
    assertElectronFileVaultWindow(e);
    if (typeof noteId !== "string" || !noteId) {
      throw new Error("Invalid note id");
    }
    const db = requireWorkspaceStore();
    const ownerId = getWpnOwnerId();
    const note = wpnJsonGetNoteById(db, ownerId, noteId);
    if (!note) {
      throw new Error("Note not found");
    }
    return { note };
  });

  ipcMain.handle(IPC_CHANNELS.WPN_GET_EXPLORER_STATE, async (e, projectId: unknown) => {
    assertElectronFileVaultWindow(e);
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project id");
    }
    const db = requireWorkspaceStore();
    const ownerId = getWpnOwnerId();
    return { expanded_ids: wpnJsonGetExplorerExpanded(db, ownerId, projectId) };
  });

  ipcMain.handle(
    IPC_CHANNELS.WPN_SET_EXPLORER_STATE,
    async (e, projectId: unknown, expandedIds: unknown) => {
      assertElectronFileVaultWindow(e);
      if (typeof projectId !== "string" || !projectId) {
        throw new Error("Invalid project id");
      }
      const ids = Array.isArray(expandedIds)
        ? expandedIds.filter((x): x is string => typeof x === "string")
        : [];
      const db = requireWorkspaceStore();
      const ownerId = getWpnOwnerId();
      wpnJsonSetExplorerExpanded(db, ownerId, projectId, ids);
      return { expanded_ids: ids };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WPN_CREATE_NOTE_IN_PROJECT,
    async (e, projectId: unknown, payload: unknown) => {
      assertElectronFileVaultWindow(e);
      if (typeof projectId !== "string" || !projectId) {
        throw new Error("Invalid project id");
      }
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      const p = payload as {
        type?: string;
        relation?: string;
        anchorId?: string;
        content?: string;
        title?: string;
      };
      const type = typeof p.type === "string" ? p.type : "";
      const selectable = registry.getSelectableNoteTypes();
      if (!isValidNoteType(type) || !selectable.includes(type)) {
        throw new Error("Invalid note type");
      }
      const rel = p.relation;
      if (rel !== "child" && rel !== "sibling" && rel !== "root") {
        throw new Error("Invalid relation");
      }
      const db = requireWorkspaceStore();
      const ownerId = getWpnOwnerId();
      return wpnJsonCreateNote(db, ownerId, projectId, {
        anchorId: rel === "root" ? undefined : p.anchorId,
        relation: rel,
        type,
        content: typeof p.content === "string" ? p.content : undefined,
        title: typeof p.title === "string" ? p.title : undefined,
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.WPN_PATCH_NOTE, async (e, noteId: unknown, patch: unknown) => {
    assertElectronFileVaultWindow(e);
    if (typeof noteId !== "string" || !noteId) {
      throw new Error("Invalid note id");
    }
    const p =
      patch && typeof patch === "object"
        ? (patch as {
            title?: string;
            content?: string;
            type?: string;
            metadata?: Record<string, unknown> | null;
            updateVfsDependentLinks?: boolean;
          })
        : {};
    const updateVfsDependentLinks = p.updateVfsDependentLinks !== false;
    const { updateVfsDependentLinks: _drop, ...notePatch } = p;
    const db = requireWorkspaceStore();
    const ownerId = getWpnOwnerId();
    const before =
      notePatch.title !== undefined ? wpnJsonGetNoteById(db, ownerId, noteId) : null;
    const note = wpnJsonUpdateNote(db, ownerId, noteId, notePatch);
    if (!note) {
      throw new Error("Note not found");
    }
    if (
      updateVfsDependentLinks &&
      before &&
      notePatch.title !== undefined &&
      (notePatch.title.trim() || before.title) !== before.title
    ) {
      try {
        wpnJsonApplyVfsRewritesAfterTitleChange(db, ownerId, noteId, before.title, note.title);
      } catch (err) {
        console.error("[WPN_PATCH_NOTE] VFS rewrite after title change:", err);
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
    return { note };
  });

  ipcMain.handle(
    IPC_CHANNELS.WPN_PREVIEW_NOTE_TITLE_VFS_IMPACT,
    async (e, noteId: unknown, newTitle: unknown) => {
      assertElectronFileVaultWindow(e);
      if (typeof noteId !== "string" || !noteId) {
        throw new Error("Invalid note id");
      }
      if (typeof newTitle !== "string") {
        throw new Error("Invalid title");
      }
      const db = requireWorkspaceStore();
      const ownerId = getWpnOwnerId();
      const before = wpnJsonGetNoteById(db, ownerId, noteId);
      if (!before) {
        throw new Error("Note not found");
      }
      const nextTitle = newTitle.trim() ? newTitle.trim() : before.title;
      const preview = wpnJsonPreviewVfsRewritesAfterTitleChange(
        db,
        ownerId,
        noteId,
        before.title,
        nextTitle,
      );
      return {
        dependentNoteCount: preview.dependentNoteCount,
        dependentNoteIds: preview.dependentNoteIds,
      };
    },
  );

  ipcMain.handle(IPC_CHANNELS.WPN_DELETE_NOTES, async (e, ids: unknown) => {
    assertElectronFileVaultWindow(e);
    if (!Array.isArray(ids)) {
      throw new Error("Invalid ids");
    }
    const list = ids.filter((x): x is string => typeof x === "string" && isValidNoteId(x));
    const db = requireWorkspaceStore();
    const ownerId = getWpnOwnerId();
    wpnJsonDeleteNotes(db, ownerId, list);
    return { ok: true as const };
  });

  ipcMain.handle(
    IPC_CHANNELS.WPN_MOVE_NOTE,
    async (
      e,
      payload: {
        projectId?: string;
        draggedId?: string;
        targetId?: string;
        placement?: string;
      },
    ) => {
      assertElectronFileVaultWindow(e);
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      const { projectId, draggedId, targetId, placement } = payload;
      if (
        typeof projectId !== "string" ||
        typeof draggedId !== "string" ||
        typeof targetId !== "string"
      ) {
        throw new Error("projectId, draggedId, targetId required");
      }
      if (placement !== "before" && placement !== "after" && placement !== "into") {
        throw new Error("Invalid placement");
      }
      const db = requireWorkspaceStore();
      const ownerId = getWpnOwnerId();

      // Convert tree-relative `../` links to absolute paths BEFORE the move,
      // while the old tree position is still valid. Applies to the dragged note and its subtree.
      {
        const allNotes = wpnJsonListAllNotesWithContext(db, ownerId);
        // Collect the full subtree (dragged note + all descendants)
        const subtreeIds = new Set<string>();
        const stack = [draggedId];
        while (stack.length > 0) {
          const id = stack.pop()!;
          if (subtreeIds.has(id)) continue;
          subtreeIds.add(id);
          for (const n of allNotes) {
            if (n.parent_id === id && n.project_id === projectId) {
              stack.push(n.id);
            }
          }
        }
        // For each note in the subtree, convert tree-relative links
        for (const sid of subtreeIds) {
          const detail = wpnJsonGetNoteById(db, ownerId, sid);
          if (!detail?.content) continue;
          const rewritten = convertTreeRelativeLinksToAbsolute(detail.content, sid, allNotes);
          if (rewritten !== detail.content) {
            wpnJsonUpdateNote(db, ownerId, sid, { content: rewritten });
          }
        }
      }

      wpnJsonMoveNote(
        db,
        ownerId,
        projectId,
        draggedId,
        targetId,
        placement as NoteMovePlacement,
      );
      return { ok: true as const };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WPN_PREVIEW_NOTE_MOVE_VFS_IMPACT,
    async (e, noteId: unknown, targetProjectId: unknown) => {
      assertElectronFileVaultWindow(e);
      if (typeof noteId !== "string" || !noteId) {
        throw new Error("Invalid note id");
      }
      if (typeof targetProjectId !== "string" || !targetProjectId) {
        throw new Error("Invalid target project id");
      }
      const db = requireWorkspaceStore();
      const ownerId = getWpnOwnerId();
      const noteCtx = wpnJsonGetNoteWithContextById(db, ownerId, noteId);
      if (!noteCtx) {
        throw new Error("Note not found");
      }
      // Look up target project context (workspace/project names)
      let targetWorkspaceName = "";
      let targetProjectName = "";
      for (const slot of db.slots) {
        const proj = slot.projects.find((p) => p.id === targetProjectId);
        if (!proj) continue;
        const ws = slot.workspaces.find((w) => w.id === proj.workspace_id && w.owner_id === ownerId);
        if (!ws) continue;
        targetWorkspaceName = ws.name;
        targetProjectName = proj.name;
        break;
      }
      if (!targetProjectName) {
        throw new Error("Target project not found");
      }
      const preview = wpnJsonPreviewVfsRewritesAfterMove(
        db,
        ownerId,
        noteId,
        noteCtx.workspace_name,
        noteCtx.project_name,
        targetWorkspaceName,
        targetProjectName,
      );
      return {
        dependentNoteCount: preview.dependentNoteCount,
        dependentNoteIds: preview.dependentNoteIds,
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WPN_MOVE_NOTE_CROSS_PROJECT,
    async (
      e,
      payload: {
        noteId?: string;
        targetProjectId?: string;
        targetParentId?: string;
      },
    ) => {
      assertElectronFileVaultWindow(e);
      if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload");
      }
      const { noteId, targetProjectId, targetParentId } = payload;
      if (typeof noteId !== "string" || !noteId) {
        throw new Error("noteId required");
      }
      if (typeof targetProjectId !== "string" || !targetProjectId) {
        throw new Error("targetProjectId required");
      }
      const db = requireWorkspaceStore();
      const ownerId = getWpnOwnerId();

      // Capture note context BEFORE the move (for VFS rewrite)
      const noteCtx = wpnJsonGetNoteWithContextById(db, ownerId, noteId);
      if (!noteCtx) {
        throw new Error("Note not found");
      }
      const oldProjectId = noteCtx.project_id;
      const noteTitle = noteCtx.title;
      const oldWorkspaceName = noteCtx.workspace_name;
      const oldProjectName = noteCtx.project_name;

      // Convert tree-relative `../` links to absolute paths BEFORE the move,
      // while the old tree position is still valid. Applies to the note and its subtree.
      {
        const allNotes = wpnJsonListAllNotesWithContext(db, ownerId);
        // Collect the full subtree (note + all descendants)
        const subtreeIds = new Set<string>();
        const stack = [noteId];
        while (stack.length > 0) {
          const id = stack.pop()!;
          if (subtreeIds.has(id)) continue;
          subtreeIds.add(id);
          for (const n of allNotes) {
            if (n.parent_id === id && n.project_id === oldProjectId) {
              stack.push(n.id);
            }
          }
        }
        // For each note in the subtree, convert tree-relative links
        for (const sid of subtreeIds) {
          const detail = wpnJsonGetNoteById(db, ownerId, sid);
          if (!detail?.content) continue;
          const rewritten = convertTreeRelativeLinksToAbsolute(detail.content, sid, allNotes);
          if (rewritten !== detail.content) {
            wpnJsonUpdateNote(db, ownerId, sid, { content: rewritten });
          }
        }
      }

      // Look up target project workspace/project names
      let targetWorkspaceName = "";
      let targetProjectName = "";
      for (const slot of db.slots) {
        const proj = slot.projects.find((p) => p.id === targetProjectId);
        if (!proj) continue;
        const ws = slot.workspaces.find((w) => w.id === proj.workspace_id && w.owner_id === ownerId);
        if (!ws) continue;
        targetWorkspaceName = ws.name;
        targetProjectName = proj.name;
        break;
      }
      if (!targetProjectName) {
        throw new Error("Target project not found");
      }

      // Perform the cross-project move
      wpnJsonMoveNoteCrossProject(
        db,
        ownerId,
        noteId,
        targetProjectId,
        targetParentId ?? null,
      );

      // Apply VFS link rewrites
      try {
        wpnJsonApplyVfsRewritesAfterMove(
          db,
          ownerId,
          oldProjectId,
          noteTitle,
          oldWorkspaceName,
          oldProjectName,
          targetWorkspaceName,
          targetProjectName,
        );
      } catch (err) {
        console.error("[WPN_MOVE_NOTE_CROSS_PROJECT] VFS rewrite after move:", err);
        throw err instanceof Error ? err : new Error(String(err));
      }

      return { ok: true as const };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WPN_DUPLICATE_NOTE_SUBTREE,
    async (e, projectId: unknown, noteId: unknown) => {
      assertElectronFileVaultWindow(e);
      if (typeof projectId !== "string" || typeof noteId !== "string") {
        throw new Error("projectId and noteId required");
      }
      const db = requireWorkspaceStore();
      const ownerId = getWpnOwnerId();
      return wpnJsonDuplicateNoteSubtree(db, ownerId, projectId, noteId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WPN_EXPORT_WORKSPACES,
    async (e, workspaceIds: unknown) => {
      assertElectronFileVaultWindow(e);
      const db = requireWorkspaceStore();
      const ownerId = getWpnOwnerId();
      const ids =
        Array.isArray(workspaceIds)
          ? workspaceIds.filter((x): x is string => typeof x === "string")
          : undefined;
      const { metadata, noteContents } = wpnJsonBuildExportBundle(db, ownerId, ids);

      const { dialog, BrowserWindow } = await import("electron");
      const win = BrowserWindow.getFocusedWindow();
      const dialogOpts = {
        title: "Export Workspaces",
        defaultPath: "archon-export.zip",
        filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
      };
      const { canceled, filePath } = win
        ? await dialog.showSaveDialog(win, dialogOpts)
        : await dialog.showSaveDialog(dialogOpts);
      if (canceled || !filePath) {
        return { ok: false as const, cancelled: true };
      }

      const { default: archiver } = await import("archiver");
      const fs = await import("fs");
      const output = fs.createWriteStream(filePath);
      const archive = archiver("zip", { zlib: { level: 6 } });

      await new Promise<void>((resolve, reject) => {
        output.on("close", resolve);
        archive.on("error", reject);
        archive.pipe(output);
        archive.append(JSON.stringify(metadata, null, 2), { name: "metadata.json" });
        for (const [noteId, content] of noteContents) {
          archive.append(content, { name: `notes/${noteId}.md` });
        }
        void archive.finalize();
      });

      return { ok: true as const, path: filePath };
    },
  );

  ipcMain.handle(IPC_CHANNELS.WPN_IMPORT_WORKSPACES, async (e) => {
    assertElectronFileVaultWindow(e);

    const { dialog, BrowserWindow } = await import("electron");
    const win = BrowserWindow.getFocusedWindow();
    const dialogOpts = {
      title: "Import Workspaces",
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
      properties: ["openFile" as const],
    };
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);
    if (canceled || filePaths.length === 0) {
      return { ok: false as const, cancelled: true };
    }

    const fs = await import("fs");
    const { default: unzipper } = await import("unzipper");
    const zipBuf = fs.readFileSync(filePaths[0]!);
    const directory = await unzipper.Open.buffer(zipBuf);

    let metadataJson: import("../shared/wpn-import-export-types").WpnExportMetadata | null = null;
    const noteContents = new Map<string, string>();

    for (const entry of directory.files) {
      if (entry.path === "metadata.json") {
        const buf = await entry.buffer();
        metadataJson = JSON.parse(buf.toString("utf-8"));
      } else if (entry.path.startsWith("notes/") && entry.path.endsWith(".md")) {
        const noteId = entry.path.slice(6, -3);
        const buf = await entry.buffer();
        noteContents.set(noteId, buf.toString("utf-8"));
      }
    }

    if (!metadataJson || metadataJson.version !== 1) {
      throw new Error("Invalid or missing metadata.json in ZIP");
    }

    const db = requireWorkspaceStore();
    const ownerId = getWpnOwnerId();
    const result = wpnJsonImportFromBundle(db, ownerId, metadataJson, noteContents);
    return { ok: true as const, imported: result };
  });
}
