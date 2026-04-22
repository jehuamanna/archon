import { ipcMain, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import { readAppPrefs, writeAppPrefs } from "../core/app-prefs";
import {
  clearArchonUndoRedo,
  pushNotesUndoSnapshot,
} from "../core/archon-undo";
import {
  setSeedSampleNotesPreference,
  swapWorkspaceRootBlock,
} from "../core/notes-store";
import {
  activateProject,
  activateWorkspace,
  closeWorkspace,
  readProjectPrefs,
  setWorkspaceFolderLabel,
  pruneWorkspaceLabels,
  writeProjectPrefs,
} from "../core/project-session";
import { getNotesDatabase } from "../core/workspace-store";
import { registry } from "../core/registry";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { getWebContentsWpnBackend } from "./electron-wpn-backend";
import { ctx } from "./main-context";
import {
  applyWorkspaceActivateResult,
  assertProjectOpenForNotes,
  broadcastProjectRootChanged,
  persistNotes,
  showOpenDialogWithParent,
} from "./main-helpers";

const ELECTRON_CLOUD_WPN_WINDOW_FOLDER_ERROR =
  "This window is a cloud WPN session. Use File → New local window to open a folder on disk.";

function isElectronCloudWpnWindow(e: { sender: { id: number } }): boolean {
  return getWebContentsWpnBackend(e.sender.id) === "cloud";
}

export function registerRunAppReadyProjectIpc(userDataPath: string): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT_GET_STATE, (e) => {
    if (isElectronCloudWpnWindow(e)) {
      return {
        rootPath: null,
        notesDbPath: null,
        workspaceRoots: [] as string[],
        workspaceLabels: {} as Record<string, string>,
        scratchSession: false,
        mountKind: "cloud" as const,
      };
    }
    const prefs = readProjectPrefs(userDataPath);
    const roots = ctx.workspaceRoots;
    const labels =
      roots.length > 0
        ? pruneWorkspaceLabels(prefs.workspaceLabels, roots) ?? {}
        : {};
    return {
      rootPath: ctx.projectRootPath,
      notesDbPath: ctx.notesPersistencePath,
      workspaceRoots: [...roots],
      workspaceLabels: labels,
      scratchSession: ctx.scratchSession,
      ...(roots.length > 0 ? { mountKind: "folder" as const } : {}),
    };
  });

  ipcMain.handle(IPC_CHANNELS.SHELL_GET_LAYOUT, (e) => {
    if (isElectronCloudWpnWindow(e)) {
      return null;
    }
    const prefs = readProjectPrefs(userDataPath);
    return prefs.shellLayout ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.SHELL_SET_LAYOUT, (e, layout: unknown) => {
    if (isElectronCloudWpnWindow(e)) {
      return { ok: true as const };
    }
    const prefs = readProjectPrefs(userDataPath);
    // Keep as renderer-owned blob; only enforce JSON-serializable object shape.
    if (layout !== null && (typeof layout !== "object" || Array.isArray(layout))) {
      return { ok: false as const, error: "layout must be an object or null" };
    }
    writeProjectPrefs(userDataPath, {
      lastProjectRoot: prefs.lastProjectRoot,
      workspaceRoots: prefs.workspaceRoots,
      workspaceLabels: prefs.workspaceLabels,
      shellLayout: layout ?? undefined,
    });
    return { ok: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.APP_GET_PREFS, () => readAppPrefs(userDataPath));

  ipcMain.handle(
    IPC_CHANNELS.APP_SET_SEED_SAMPLE_NOTES,
    (_e, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        return { ok: false as const, error: "Invalid value" };
      }
      const next = writeAppPrefs(userDataPath, { seedSampleNotes: enabled });
      setSeedSampleNotesPreference(next.seedSampleNotes);
      return { ok: true as const, seedSampleNotes: next.seedSampleNotes };
    },
  );

  ipcMain.handle(IPC_CHANNELS.PROJECT_START_SCRATCH_SESSION, async (e) => {
    if (isElectronCloudWpnWindow(e)) {
      return {
        ok: false as const,
        error: ELECTRON_CLOUD_WPN_WINDOW_FOLDER_ERROR,
      };
    }
    if (ctx.workspaceRoots.length > 0 && !ctx.scratchSession) {
      return {
        ok: false as const,
        error:
          "A project folder is already open. Close it from Notes before using scratch-only mode (IndexedDB).",
      };
    }
    if (ctx.scratchSession) {
      const res = closeWorkspace(userDataPath);
      if (res.ok) {
        applyWorkspaceActivateResult(res);
      }
    } else {
      applyWorkspaceActivateResult({
        ok: true,
        root: "",
        dbPath: "",
        workspaceRoots: [],
      });
    }
    clearArchonUndoRedo();
    broadcastProjectRootChanged();
    return {
      ok: true as const,
      rootPath: ctx.projectRootPath,
      workspaceRoots: [...ctx.workspaceRoots],
      scratchSession: false as const,
    };
  });

  ipcMain.removeHandler(IPC_CHANNELS.ELECTRON_CLEAR_WORKSPACE_ROOTS);
  ipcMain.handle(IPC_CHANNELS.ELECTRON_CLEAR_WORKSPACE_ROOTS, () => {
    if (ctx.scratchSession) {
      const res = closeWorkspace(userDataPath);
      if (res.ok) {
        applyWorkspaceActivateResult(res);
      }
    } else if (ctx.workspaceRoots.length > 0) {
      const res = closeWorkspace(userDataPath);
      if (res.ok) {
        applyWorkspaceActivateResult(res);
      }
    } else {
      applyWorkspaceActivateResult({
        ok: true,
        root: "",
        dbPath: "",
        workspaceRoots: [],
      });
    }
    clearArchonUndoRedo();
    broadcastProjectRootChanged();
    return { ok: true as const };
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_SAVE_SCRATCH_TO_FOLDER, async () => ({
    ok: false as const,
    error:
      "Scratch notes live in IndexedDB. Use Notes → Open project to use a folder on disk.",
  }));

  ipcMain.handle(IPC_CHANNELS.PROJECT_NEW_SCRATCH_SESSION, async () => ({
    ok: false as const,
    error:
      "Use the Notes explorer in scratch mode, or clear local IndexedDB from developer commands.",
  }));

  ipcMain.handle(IPC_CHANNELS.PROJECT_PULL_LEGACY_SCRATCH_WPN_MIGRATION, () => {
    const prefs = readAppPrefs(userDataPath);
    if (prefs.legacyScratchToIdbMigrated === true) {
      return { ok: false as const, reason: "none" as const };
    }
    const store = getNotesDatabase();
    if (!store?.scratchSession || store.roots.length === 0) {
      return { ok: false as const, reason: "none" as const };
    }
    const slot = store.slots[0]!;
    const workspaces = slot.workspaces.map(({ owner_id: _o, ...row }) => row);
    return {
      ok: true as const,
      bundle: {
        workspaces,
        projects: slot.projects.map((p) => ({ ...p })),
        notes: slot.notes.map((n) => ({ ...n })),
        explorer: slot.explorer.map((e) => ({
          project_id: e.project_id,
          expanded_ids: [...e.expanded_ids],
        })),
      },
    };
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_ACK_LEGACY_SCRATCH_WPN_MIGRATION, () => {
    try {
      const prefs = readAppPrefs(userDataPath);
      if (prefs.legacyScratchToIdbMigrated === true) {
        return { ok: true as const };
      }
      if (!ctx.scratchSession) {
        return {
          ok: false as const,
          error: "No legacy in-memory scratch session to finalize",
        };
      }
      const res = closeWorkspace(userDataPath);
      if (res.ok) {
        applyWorkspaceActivateResult(res);
      }
      clearArchonUndoRedo();
      writeAppPrefs(userDataPath, { legacyScratchToIdbMigrated: true });
      broadcastProjectRootChanged();
      return { ok: true as const };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_SELECT_FOLDER, async (e) => {
    if (isElectronCloudWpnWindow(e)) {
      return { ok: false as const, error: ELECTRON_CLOUD_WPN_WINDOW_FOLDER_ERROR };
    }
    const r = await showOpenDialogWithParent({
      properties: ["openDirectory", "createDirectory"],
      title: "Choose or create a folder for your notes",
    });
    if (r.canceled || r.filePaths.length === 0) {
      return { ok: false as const, cancelled: true as const };
    }
    const chosen = r.filePaths[0]!;
    const res = activateProject(
      chosen,
      userDataPath,
      registry.getRegisteredTypes(),
    );
    if (!res.ok) {
      return { ok: false as const, error: res.error };
    }
    applyWorkspaceActivateResult(res);
    clearArchonUndoRedo();
    broadcastProjectRootChanged();
    return {
      ok: true as const,
      rootPath: ctx.projectRootPath,
      workspaceRoots: [...ctx.workspaceRoots],
    };
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_ADD_WORKSPACE_FOLDER, async (e) => {
    if (isElectronCloudWpnWindow(e)) {
      return { ok: false as const, error: ELECTRON_CLOUD_WPN_WINDOW_FOLDER_ERROR };
    }
    if (!ctx.projectRootPath || ctx.workspaceRoots.length === 0) {
      return {
        ok: false as const,
        error: "Open a project folder first (Notes → Open project).",
      };
    }
    const r = await showOpenDialogWithParent({
      properties: ["openDirectory", "createDirectory"],
      title: "Add another project folder to the workspace",
    });
    if (r.canceled || r.filePaths.length === 0) {
      return { ok: false as const, cancelled: true as const };
    }
    const chosen = path.resolve(r.filePaths[0]!);
    if (ctx.workspaceRoots.includes(chosen)) {
      return {
        ok: false as const,
        error: "That folder is already in the workspace.",
      };
    }
    const next = [...ctx.workspaceRoots, chosen];
    const res = activateWorkspace(next, userDataPath, registry.getRegisteredTypes());
    if (!res.ok) {
      return { ok: false as const, error: res.error };
    }
    applyWorkspaceActivateResult(res);
    broadcastProjectRootChanged();
    return {
      ok: true as const,
      rootPath: ctx.projectRootPath,
      workspaceRoots: [...ctx.workspaceRoots],
    };
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_OPEN_PATH, async (e, absPath: unknown) => {
    if (isElectronCloudWpnWindow(e)) {
      return { ok: false as const, error: ELECTRON_CLOUD_WPN_WINDOW_FOLDER_ERROR };
    }
    if (typeof absPath !== "string" || absPath.length === 0) {
      return { ok: false as const, error: "Invalid path" };
    }
    const res = activateProject(
      absPath,
      userDataPath,
      registry.getRegisteredTypes(),
    );
    if (!res.ok) {
      return { ok: false as const, error: res.error };
    }
    applyWorkspaceActivateResult(res);
    clearArchonUndoRedo();
    broadcastProjectRootChanged();
    return {
      ok: true as const,
      rootPath: ctx.projectRootPath,
      workspaceRoots: [...ctx.workspaceRoots],
    };
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_REVEAL_FOLDER, async (e, folderPath: unknown) => {
    if (isElectronCloudWpnWindow(e)) {
      return { ok: false as const, error: ELECTRON_CLOUD_WPN_WINDOW_FOLDER_ERROR };
    }
    try {
      if (typeof folderPath !== "string" || folderPath.length === 0) {
        return { ok: false as const, error: "Invalid path" };
      }
      const abs = path.resolve(folderPath);
      const allowed = ctx.workspaceRoots.some((r) => path.resolve(r) === abs);
      if (!allowed) {
        return {
          ok: false as const,
          error: "Path is not an open project folder",
        };
      }
      if (!fs.existsSync(abs)) {
        return { ok: false as const, error: "Path does not exist" };
      }
      let err: string;
      try {
        const OPEN_PATH_TIMEOUT_MS = 60_000;
        err = await Promise.race([
          shell.openPath(abs),
          new Promise<string>((_, reject) =>
            setTimeout(
              () => reject(new Error("Timed out opening folder in file manager")),
              OPEN_PATH_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (e) {
        return {
          ok: false as const,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      if (err) {
        return { ok: false as const, error: err };
      }
      return { ok: true as const };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_SWAP_WORKSPACE_BLOCK,
    (e, payload: unknown) => {
      if (isElectronCloudWpnWindow(e)) {
        return { ok: false as const, error: ELECTRON_CLOUD_WPN_WINDOW_FOLDER_ERROR };
      }
      assertProjectOpenForNotes();
      if (!payload || typeof payload !== "object") {
        return { ok: false as const, error: "Invalid payload" };
      }
      const raw = payload as { blockIndex?: unknown; direction?: unknown };
      const blockIndex = raw.blockIndex;
      const direction = raw.direction;
      if (
        typeof blockIndex !== "number" ||
        !Number.isInteger(blockIndex) ||
        blockIndex < 0
      ) {
        return { ok: false as const, error: "Invalid block index" };
      }
      if (direction !== "up" && direction !== "down") {
        return { ok: false as const, error: "Invalid direction" };
      }
      pushNotesUndoSnapshot();
      const r = swapWorkspaceRootBlock(blockIndex, direction);
      if (!r.ok) {
        return r;
      }
      persistNotes();
      return { ok: true as const };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_SET_WORKSPACE_LABEL,
    (e, payload: unknown) => {
      if (isElectronCloudWpnWindow(e)) {
        return { ok: false as const, error: ELECTRON_CLOUD_WPN_WINDOW_FOLDER_ERROR };
      }
      if (!payload || typeof payload !== "object") {
        return { ok: false as const, error: "Invalid payload" };
      }
      const raw = payload as { rootPath?: unknown; label?: unknown };
      if (typeof raw.rootPath !== "string" || raw.rootPath.trim().length === 0) {
        return { ok: false as const, error: "Invalid path" };
      }
      const label =
        raw.label == null
          ? null
          : typeof raw.label === "string"
            ? raw.label
            : null;
      const r = setWorkspaceFolderLabel(userDataPath, raw.rootPath, label);
      if (!r.ok) {
        return r;
      }
      return { ok: true as const, workspaceLabels: r.workspaceLabels };
    },
  );

  ipcMain.handle(IPC_CHANNELS.PROJECT_REFRESH_WORKSPACE, (e) => {
    if (isElectronCloudWpnWindow(e)) {
      return { ok: false as const, error: ELECTRON_CLOUD_WPN_WINDOW_FOLDER_ERROR };
    }
    if (ctx.workspaceRoots.length === 0) {
      return { ok: false as const, error: "No workspace open" };
    }
    const res = activateWorkspace(
      [...ctx.workspaceRoots],
      userDataPath,
      registry.getRegisteredTypes(),
    );
    if (!res.ok) {
      return { ok: false as const, error: res.error };
    }
    applyWorkspaceActivateResult(res);
    clearArchonUndoRedo();
    broadcastProjectRootChanged();
    return {
      ok: true as const,
      rootPath: ctx.projectRootPath,
      workspaceRoots: [...ctx.workspaceRoots],
    };
  });

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_REMOVE_WORKSPACE_ROOT,
    async (e, payload: unknown) => {
      if (isElectronCloudWpnWindow(e)) {
        return { ok: false as const, error: ELECTRON_CLOUD_WPN_WINDOW_FOLDER_ERROR };
      }
      if (!payload || typeof payload !== "object") {
        return { ok: false as const, error: "Invalid payload" };
      }
      const raw = payload as {
        projectRootAbs?: unknown;
        moveToTrash?: unknown;
      };
      if (
        typeof raw.projectRootAbs !== "string" ||
        raw.projectRootAbs.trim().length === 0
      ) {
        return { ok: false as const, error: "Invalid path" };
      }
      const abs = path.resolve(raw.projectRootAbs.trim());
      const moveToTrash = raw.moveToTrash === true;
      const idx = ctx.workspaceRoots.findIndex(
        (r) => path.resolve(r) === abs,
      );
      if (idx < 0) {
        return {
          ok: false as const,
          error: "That folder is not in the workspace",
        };
      }
      const next = ctx.workspaceRoots.filter((_, i) => i !== idx);
      const res =
        next.length === 0
          ? closeWorkspace(userDataPath)
          : activateWorkspace(
              next,
              userDataPath,
              registry.getRegisteredTypes(),
            );
      if (!res.ok) {
        return { ok: false as const, error: res.error };
      }
      applyWorkspaceActivateResult(res);
      clearArchonUndoRedo();
      broadcastProjectRootChanged();
      let trashError: string | undefined;
      if (moveToTrash) {
        try {
          await shell.trashItem(abs);
        } catch (e) {
          trashError = e instanceof Error ? e.message : String(e);
        }
      }
      return {
        ok: true as const,
        rootPath: ctx.projectRootPath,
        workspaceRoots: [...ctx.workspaceRoots],
        trashError,
      };
    },
  );
}
