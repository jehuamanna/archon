import { contextBridge, ipcRenderer } from "electron";
import type { ClientLogPayload } from "./shared/client-log";
import { IPC_CHANNELS } from "./shared/ipc-channels";
import type { WorkspaceRxdbMirrorPayloadV1 } from "./shared/workspace-rxdb-mirror-payload";
import { isWorkspaceRxdbMirrorPayloadV1 } from "./shared/workspace-rxdb-mirror-payload";
import { buildCanonicalArchonAssetHref } from "./shared/archon-asset-path";
import type { ArchonRendererApi } from "./shared/archon-renderer-api";

export type {
  CreateNoteRelation,
  MainDebugLogEntry,
  MarketplaceListResponse,
  MarketplacePluginRow,
  Note,
  NoteListItem,
  NoteMovePlacement,
  OpenPluginWorkspaceArgs,
  PasteSubtreePayload,
  PluginInventoryItem,
  PluginProgressPayload,
} from "./shared/archon-renderer-api";

function readElectronWpnBackendFromArgv(): "file" | "cloud" {
  try {
    const hit = process.argv.find((a) =>
      a.startsWith("--archon-electron-wpn-backend="),
    );
    const v = hit?.split("=", 2)[1]?.trim().toLowerCase();
    if (v === "cloud") {
      return "cloud";
    }
  } catch {
    /* ignore */
  }
  return "file";
}

const electronWpnBackendMode = readElectronWpnBackendFromArgv();
contextBridge.exposeInMainWorld(
  "__ARCHON_ELECTRON_WPN_BACKEND__",
  electronWpnBackendMode,
);

const api: ArchonRendererApi = {
  getNote: (noteId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_NOTE, noteId),
  getAllNotes: () => ipcRenderer.invoke(IPC_CHANNELS.GET_ALL_NOTES),
  createNote: (payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.CREATE_NOTE, payload),
  renameNote: (id, title, options) =>
    ipcRenderer.invoke(IPC_CHANNELS.RENAME_NOTE, id, title, options),
  deleteNotes: (ids) => ipcRenderer.invoke(IPC_CHANNELS.DELETE_NOTES, ids),
  moveNote: (draggedId, targetId, placement) =>
    ipcRenderer.invoke(IPC_CHANNELS.MOVE_NOTE, {
      draggedId,
      targetId,
      placement,
    }),
  moveNotesBulk: (ids, targetId, placement) =>
    ipcRenderer.invoke(IPC_CHANNELS.MOVE_NOTES_BULK, {
      ids,
      targetId,
      placement,
    }),
  pasteSubtree: (payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.PASTE_SUBTREE, payload),
  saveNotePluginUiState: (noteId, state) =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_NOTE_PLUGIN_UI_STATE, noteId, state),
  saveNoteContent: (noteId, content) =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_NOTE_CONTENT, noteId, content),
  patchNoteMetadata: (noteId, patch) =>
    ipcRenderer.invoke(IPC_CHANNELS.PATCH_NOTE_METADATA, noteId, patch),
  getPluginHTML: (type, note) =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_PLUGIN_HTML, type, note),
  getRegisteredTypes: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_REGISTERED_TYPES),
  getSelectableNoteTypes: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SELECTABLE_NOTE_TYPES),
  selectZipFile: () => ipcRenderer.invoke(IPC_CHANNELS.SELECT_ZIP_FILE),
  importPlugin: (zipPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPORT_PLUGIN, zipPath),
  listMarketplacePlugins: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS),
  installMarketplacePlugin: (packageFile) =>
    ipcRenderer.invoke(IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN, packageFile),
  getInstalledPlugins: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_INSTALLED_PLUGINS),
  getPluginInventory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_GET_INVENTORY),
  getDisabledPluginIds: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_GET_DISABLED_IDS),
  setPluginEnabled: (pluginId, enabled) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_SET_ENABLED, {
      pluginId,
      enabled,
    }),
  toggleDeveloperTools: () =>
    ipcRenderer.invoke(IPC_CHANNELS.UI_TOGGLE_DEVTOOLS),
  quitApp: () => ipcRenderer.invoke(IPC_CHANNELS.UI_QUIT_APP),
  reloadWindow: () => ipcRenderer.invoke(IPC_CHANNELS.UI_RELOAD_WINDOW),
  applyElectronPrimaryWpnBackend: (args: { backend: "file" | "cloud"; relaunch: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.ELECTRON_APPLY_PRIMARY_WPN_BACKEND, args),
  openCloudWpnWindowCloseSender: () =>
    ipcRenderer.invoke(IPC_CHANNELS.ELECTRON_OPEN_CLOUD_WPN_WINDOW_CLOSE_SENDER),
  openFileWpnWindowCloseSender: () =>
    ipcRenderer.invoke(IPC_CHANNELS.ELECTRON_OPEN_FILE_WPN_WINDOW_CLOSE_SENDER),
  setElectronWpnBackendForSession: (mode: "file" | "cloud") =>
    ipcRenderer.invoke(IPC_CHANNELS.ELECTRON_SET_WPN_BACKEND_FOR_SENDER, { mode }),
  clearElectronWorkspaceRoots: () =>
    ipcRenderer.invoke(IPC_CHANNELS.ELECTRON_CLEAR_WORKSPACE_ROOTS),
  openExternalUrl: (url: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.UI_OPEN_EXTERNAL_URL, url),
  getUserPluginsDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_GET_USER_PLUGINS_DIR),
  resetUserPluginsDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_RESET_USER_DATA_PLUGINS),
  deletePluginBinAndCaches: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_MAINT_DELETE_BIN_AND_CACHES),
  formatArchonPluginData: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_MAINT_FORMAT_ARCHON),
  deleteAllPluginSources: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_MAINT_DELETE_SOURCES),
  uninstallPlugin: (pluginName) =>
    ipcRenderer.invoke(IPC_CHANNELS.UNINSTALL_PLUGIN, pluginName),
  exportPluginDev: (pluginName) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPORT_PLUGIN_DEV, pluginName),
  exportPluginProduction: (pluginName) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPORT_PLUGIN_PRODUCTION, pluginName),
  publishPluginAsFile: (pluginName) =>
    ipcRenderer.invoke(IPC_CHANNELS.PUBLISH_PLUGIN_AS_FILE, pluginName),
  publishPluginToMarketplace: (pluginName, options) =>
    ipcRenderer.invoke(IPC_CHANNELS.PUBLISH_PLUGIN_TO_MARKETPLACE, {
      pluginName,
      options,
    }),
  bundlePluginLocal: (pluginName) =>
    ipcRenderer.invoke(IPC_CHANNELS.BUNDLE_PLUGIN_LOCAL, pluginName),
  installPluginDependencies: (pluginName) =>
    ipcRenderer.invoke(IPC_CHANNELS.INSTALL_PLUGIN_DEPENDENCIES, pluginName),
  clearPluginDependencyCache: (pluginName) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.CLEAR_PLUGIN_DEPENDENCY_CACHE,
      pluginName,
    ),
  clearAllPluginDependencyCaches: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CLEAR_ALL_PLUGIN_DEPENDENCY_CACHES),
  getPluginCacheStats: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_PLUGIN_CACHE_STATS),
  onPluginsChanged: (callback) => {
    ipcRenderer.on(IPC_CHANNELS.PLUGINS_CHANGED, callback);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.PLUGINS_CHANGED, callback);
  },
  getProjectState: () => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_GET_STATE),
  getShellLayout: () => ipcRenderer.invoke(IPC_CHANNELS.SHELL_GET_LAYOUT),
  setShellLayout: (layout) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_SET_LAYOUT, layout),
  getAppPrefs: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_PREFS),
  setSeedSampleNotes: (enabled) =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_SET_SEED_SAMPLE_NOTES, enabled),
  selectProjectFolder: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SELECT_FOLDER),
  startScratchSession: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_START_SCRATCH_SESSION),
  saveScratchSessionToFolder: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SAVE_SCRATCH_TO_FOLDER),
  newScratchSession: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_NEW_SCRATCH_SESSION),
  pullLegacyScratchWpnMigrationPayload: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_PULL_LEGACY_SCRATCH_WPN_MIGRATION),
  ackLegacyScratchWpnMigrationImported: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_ACK_LEGACY_SCRATCH_WPN_MIGRATION),
  openProjectPath: (absPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_OPEN_PATH, absPath),
  addWorkspaceFolder: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_ADD_WORKSPACE_FOLDER),
  removeWorkspaceRoot: (projectRootAbs, moveToTrash) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_REMOVE_WORKSPACE_ROOT, {
      projectRootAbs,
      moveToTrash,
    }),
  swapWorkspaceBlock: (payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SWAP_WORKSPACE_BLOCK, payload),
  setWorkspaceFolderLabel: (rootPath, label) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SET_WORKSPACE_LABEL, {
      rootPath,
      label,
    }),
  onProjectRootChanged: (callback) => {
    const ch = IPC_CHANNELS.PROJECT_ROOT_CHANGED;
    ipcRenderer.on(ch, callback);
    return () => ipcRenderer.removeListener(ch, callback);
  },
  listAssets: (relativePath, projectRoot) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.ASSET_LIST,
      projectRoot !== undefined && projectRoot.length > 0
        ? { relativePath, projectRoot }
        : relativePath,
    ),
  listAssetsByCategory: (category, projectRoot) =>
    ipcRenderer.invoke(IPC_CHANNELS.ASSET_LIST_BY_CATEGORY, {
      category,
      ...(projectRoot !== undefined && projectRoot.length > 0
        ? { projectRoot }
        : {}),
    }),
  pickImportMediaFile: (category, projectRoot) =>
    ipcRenderer.invoke(IPC_CHANNELS.ASSET_PICK_IMPORT, {
      category,
      ...(projectRoot !== undefined && projectRoot.length > 0
        ? { projectRoot }
        : {}),
    }),
  getAssetInfo: (relativePath, projectRoot) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.ASSET_GET_INFO,
      projectRoot !== undefined && projectRoot.length > 0
        ? { relativePath, projectRoot }
        : relativePath,
    ),
  readAssetText: (relativePath, projectRoot) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.ASSET_READ_TEXT,
      projectRoot !== undefined && projectRoot.length > 0
        ? { relativePath, projectRoot }
        : relativePath,
    ),
  openAssetExternal: (relativePath, projectRoot) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.ASSET_OPEN_EXTERNAL,
      projectRoot !== undefined && projectRoot.length > 0
        ? { relativePath, projectRoot }
        : relativePath,
    ),
  moveProjectAsset: (payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.ASSET_MOVE, payload),
  revealAssetInFileManager: (relativePath, projectRoot) =>
    ipcRenderer.invoke(IPC_CHANNELS.ASSET_REVEAL_IN_FILE_MANAGER, {
      relativePath,
      projectRoot,
    }),
  archonUndo: () => ipcRenderer.invoke(IPC_CHANNELS.ARCHON_UNDO),
  archonRedo: () => ipcRenderer.invoke(IPC_CHANNELS.ARCHON_REDO),
  assetUrl: (relativePath, projectRoot) =>
    buildCanonicalArchonAssetHref(
      relativePath,
      projectRoot !== undefined && projectRoot.length > 0
        ? projectRoot
        : undefined,
    ),
  revealProjectFolderInExplorer: (absPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_REVEAL_FOLDER, absPath),
  refreshWorkspace: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_REFRESH_WORKSPACE),
  onPluginProgress: (callback) => {
    const ch = IPC_CHANNELS.PLUGIN_PROGRESS;
    const fn = (_e: unknown, p: unknown) =>
      callback(p as Parameters<typeof callback>[0]);
    ipcRenderer.on(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  },
  validatePluginZip: (zipPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.VALIDATE_PLUGIN_ZIP, zipPath),
  getPluginInstallPlan: (installedFolderName) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.GET_PLUGIN_INSTALL_PLAN,
      installedFolderName,
    ),
  getPluginResolvedDeps: (installedFolderName) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.GET_PLUGIN_RESOLVED_DEPS,
      installedFolderName,
    ),
  runPluginCacheNpm: (installedFolderName, npmArgs) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.RUN_PLUGIN_CACHE_NPM,
      installedFolderName,
      npmArgs,
    ),
  getPluginLoadIssues: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_PLUGIN_LOAD_ISSUES),
  listPluginWorkspaceFolders: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_LIST_WORKSPACE_FOLDERS),
  listPluginSourceFiles: (installedFolderName) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_LIST_SOURCE_FILES,
      installedFolderName,
    ),
  readPluginSourceFile: (installedFolderName, relativePath) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_READ_SOURCE_FILE,
      installedFolderName,
      relativePath,
    ),
  writePluginSourceFile: (installedFolderName, relativePath, content) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_WRITE_SOURCE_FILE,
      installedFolderName,
      relativePath,
      content,
    ),
  mkdirPluginSource: (installedFolderName, relativeDir) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_MKDIR_SOURCE,
      installedFolderName,
      relativeDir,
    ),
  createPluginSourceFile: (installedFolderName, relativePath, content) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_CREATE_SOURCE_FILE,
      installedFolderName,
      relativePath,
      content ?? "",
    ),
  deletePluginSourcePath: (installedFolderName, relativePath) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_DELETE_SOURCE_PATH,
      installedFolderName,
      relativePath,
    ),
  selectImportFiles: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_SELECT_IMPORT_FILES),
  selectImportDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_SELECT_IMPORT_DIRECTORY),
  importFilesIntoWorkspace: (
    installedFolderName,
    absolutePaths,
    destRelativeBase,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_IMPORT_FILES_INTO_WORKSPACE,
      installedFolderName,
      absolutePaths,
      destRelativeBase ?? "",
    ),
  importDirectoryIntoWorkspace: (
    installedFolderName,
    absoluteDir,
    destRelativeBase,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_IMPORT_DIRECTORY_INTO_WORKSPACE,
      installedFolderName,
      absoluteDir,
      destRelativeBase ?? "",
    ),
  importDirectoryAsNewWorkspace: (absoluteDir) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_IMPORT_DIRECTORY_AS_NEW_WORKSPACE,
      absoluteDir,
    ),
  npmRegistrySearch: (query) =>
    ipcRenderer.invoke(IPC_CHANNELS.NPM_REGISTRY_SEARCH, query),
  runPluginTypecheck: (pluginName) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_TYPECHECK, pluginName),
  getIdeTypings: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_IDE_TYPINGS),
  getIdePluginTypings: (installedFolderName) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_IDE_PLUGIN_TYPINGS,
      installedFolderName,
    ),
  loadArchonPluginsFromParent: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_LOAD_ARCHON_FROM_PARENT),
  removeExternalPluginWorkspace: (pluginId) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_REMOVE_EXTERNAL_PLUGIN, pluginId),
  renamePluginSourcePath: (installedFolderName, fromRelative, toRelative) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_RENAME_SOURCE_PATH,
      installedFolderName,
      fromRelative,
      toRelative,
    ),
  copyPluginSourceWithinWorkspace: (
    installedFolderName,
    fromRelative,
    toRelative,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_COPY_SOURCE_WITHIN_WORKSPACE,
      installedFolderName,
      fromRelative,
      toRelative,
    ),
  copyPluginSourceBetweenWorkspaces: (
    fromPlugin,
    fromRelative,
    toPlugin,
    toRelative,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_COPY_SOURCE_BETWEEN_WORKSPACES,
      fromPlugin,
      fromRelative,
      toPlugin,
      toRelative,
    ),
  movePluginSourceBetweenWorkspaces: (
    fromPlugin,
    fromRelative,
    toPlugin,
    toRelative,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_MOVE_SOURCE_BETWEEN_WORKSPACES,
      fromPlugin,
      fromRelative,
      toPlugin,
      toRelative,
    ),
  copyPluginDistToFolder: (installedFolderName) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_COPY_DIST_TO_FOLDER,
      installedFolderName,
    ),
  getPluginSourceEntryKind: (installedFolderName, relativePath) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_GET_SOURCE_ENTRY_KIND,
      installedFolderName,
      relativePath,
    ),
  getPluginSourceFileMeta: (installedFolderName, relativePath) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_GET_SOURCE_FILE_META,
      installedFolderName,
      relativePath,
    ),
  openPluginWorkspaceInEditor: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_OPEN_WORKSPACE_IN_EDITOR, args),
  revealPluginWorkspaceInFileManager: (pluginName) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_REVEAL_WORKSPACE, pluginName),
  scaffoldPluginWorkspace: (pluginName) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PLUGIN_SCAFFOLD_PLUGIN_WORKSPACE,
      pluginName,
    ),
  setIdeWorkspaceWatch: (pluginName) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_IDE_SET_WORKSPACE_WATCH, pluginName),
  onIdeWorkspaceFsChanged: (callback) => {
    const ch = IPC_CHANNELS.PLUGIN_IDE_WORKSPACE_FS_CHANGED;
    const fn = () => callback();
    ipcRenderer.on(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  },
  getMainDebugLogBuffer: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_IDE_GET_MAIN_DEBUG_LOGS),
  clearMainDebugLogBuffer: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_IDE_CLEAR_MAIN_DEBUG_LOGS),
  onMainDebugLog: (callback) => {
    const ch = IPC_CHANNELS.PLUGIN_IDE_MAIN_DEBUG_LOG;
    const fn = (_e: unknown, entry: unknown) =>
      callback(entry as Parameters<typeof callback>[0]);
    ipcRenderer.on(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  },
  sendClientLog: (payload: ClientLogPayload) =>
    ipcRenderer.send(IPC_CHANNELS.ARCHON_CLIENT_LOG, payload),
  reloadPluginRegistry: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_RELOAD_REGISTRY),
  getNativeThemeDark: () =>
    ipcRenderer.invoke(IPC_CHANNELS.UI_GET_NATIVE_THEME_DARK),
  onNativeThemeChanged: (callback) => {
    const ch = IPC_CHANNELS.UI_NATIVE_THEME_CHANGED;
    const fn = (_e: unknown, dark: boolean) => callback(dark);
    ipcRenderer.on(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  },
  onRunContributionCommand: (callback) => {
    const ch = IPC_CHANNELS.UI_RUN_CONTRIBUTION_COMMAND;
    const fn = (_e: unknown, detail: unknown) => {
      const d = detail as { commandId?: string };
      if (typeof d?.commandId === "string") {
        callback({ commandId: d.commandId });
      }
    };
    ipcRenderer.on(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  },
  getPluginRendererUiMeta: (noteType) =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_PLUGIN_RENDERER_UI_META, noteType),
  getPluginManifestUi: (pluginName) =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_PLUGIN_MANIFEST_UI, pluginName),
  wpnListWorkspaces: () =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_LIST_WORKSPACES),
  wpnListWorkspacesAndProjects: () =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_LIST_WORKSPACES_AND_PROJECTS),
  wpnGetFullTree: () => ipcRenderer.invoke(IPC_CHANNELS.WPN_GET_FULL_TREE),
  wpnCreateWorkspace: (name) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_CREATE_WORKSPACE, name),
  wpnUpdateWorkspace: (id, patch) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_UPDATE_WORKSPACE, id, patch),
  wpnDeleteWorkspace: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_DELETE_WORKSPACE, id),
  // Electron bulk delete: iterate single-item IPC under the hood. The sync-api
  // bulk endpoint is web-only; desktop does not share the same server.
  wpnDeleteWorkspaces: async (ids) => {
    const deleted: string[] = [];
    const denied: string[] = [];
    for (const id of ids) {
      try {
        await ipcRenderer.invoke(IPC_CHANNELS.WPN_DELETE_WORKSPACE, id);
        deleted.push(id);
      } catch {
        denied.push(id);
      }
    }
    return { deleted, denied, notFound: [] };
  },
  wpnListProjects: (workspaceId) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_LIST_PROJECTS, workspaceId),
  wpnCreateProject: (workspaceId, name) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_CREATE_PROJECT, workspaceId, name),
  wpnUpdateProject: (id, patch) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_UPDATE_PROJECT, id, patch),
  wpnDeleteProject: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_DELETE_PROJECT, id),
  wpnDeleteProjects: async (ids) => {
    const deleted: string[] = [];
    const denied: string[] = [];
    for (const id of ids) {
      try {
        await ipcRenderer.invoke(IPC_CHANNELS.WPN_DELETE_PROJECT, id);
        deleted.push(id);
      } catch {
        denied.push(id);
      }
    }
    return { deleted, denied, notFound: [] };
  },
  wpnListNotes: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_LIST_NOTES, projectId),
  wpnListAllNotesWithContext: () =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_LIST_ALL_NOTES_WITH_CONTEXT),
  wpnListBacklinksToNote: (targetNoteId) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_LIST_BACKLINKS_TO_NOTE, targetNoteId),
  wpnGetNote: (noteId) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_GET_NOTE, noteId),
  wpnGetExplorerState: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_GET_EXPLORER_STATE, projectId),
  wpnSetExplorerState: (projectId, expandedIds) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_SET_EXPLORER_STATE, projectId, expandedIds),
  wpnCreateNoteInProject: (projectId, payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_CREATE_NOTE_IN_PROJECT, projectId, payload),
  wpnPreviewNoteTitleVfsImpact: (noteId, newTitle) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_PREVIEW_NOTE_TITLE_VFS_IMPACT, noteId, newTitle),
  wpnPatchNote: (noteId, patch) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_PATCH_NOTE, noteId, patch),
  wpnDeleteNotes: (ids) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_DELETE_NOTES, ids),
  wpnMoveNote: (payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_MOVE_NOTE, payload),
  wpnMoveNoteCrossProject: (payload) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_MOVE_NOTE_CROSS_PROJECT, payload),
  wpnPreviewNoteMoveVfsImpact: (noteId, targetProjectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_PREVIEW_NOTE_MOVE_VFS_IMPACT, noteId, targetProjectId),
  wpnDuplicateNoteSubtree: (projectId, noteId) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_DUPLICATE_NOTE_SUBTREE, projectId, noteId),
  wpnExportWorkspaces: (workspaceIds) =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_EXPORT_WORKSPACES, workspaceIds),
  wpnImportWorkspaces: () =>
    ipcRenderer.invoke(IPC_CHANNELS.WPN_IMPORT_WORKSPACES),
  pullWorkspaceRxdbMirrorPayload: () =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_RXDB_MIRROR_PULL),
  flushWorkspaceRxdbMirrorToDisk: (payload: WorkspaceRxdbMirrorPayloadV1) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_RXDB_MIRROR_FLUSH_TO_DISK, payload),
};

contextBridge.exposeInMainWorld("Archon", api);

contextBridge.exposeInMainWorld("archonDesktop", {
  onSyncTrigger: (callback: () => void) => {
    const channel = IPC_CHANNELS.DESKTOP_SYNC_TRIGGER;
    const listener = (): void => {
      callback();
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
  onWorkspaceRxdbMirrorUpdated: (
    callback: (payload: WorkspaceRxdbMirrorPayloadV1) => void,
  ) => {
    const channel = IPC_CHANNELS.WORKSPACE_RXDB_MIRROR_UPDATED;
    const listener = (_e: unknown, raw: unknown): void => {
      if (isWorkspaceRxdbMirrorPayloadV1(raw)) {
        callback(raw);
      }
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
  onWorkspaceWpnPersisted: (callback: () => void) => {
    const channel = IPC_CHANNELS.WORKSPACE_WPN_PERSISTED;
    const listener = (): void => {
      callback();
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
});
