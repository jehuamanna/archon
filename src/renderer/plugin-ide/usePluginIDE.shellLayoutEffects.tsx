import { getArchon } from "../../shared/archon-host-access";
import {
  useCallback,
  useEffect,
  useMemo,
} from "react";
import {
  editor as monacoEditor,
  MarkerSeverity,
  typescript as monacoTypescript,
} from "monaco-editor";
import { createPortal } from "react-dom";
import Editor, { type OnMount } from "@monaco-editor/react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { joinFileUri } from "../../shared/file-uri";
import { clientLog } from "../logging/clientLog";
import {
  IDE_SHELL_ACTION_EVENT,
  IDE_SHELL_EXPAND_FOLDER_EVENT,
  IDE_SHELL_OPEN_FILE_EVENT,
  IDE_SHELL_PLUGIN_EVENT,
  IDE_SHELL_STATE_EVENT,
  IDE_SHELL_TREE_FS_OP_EVENT,
  IDE_SHELL_TREE_SELECTION_EVENT,
  dispatchIdeShellExpandFolder,
  type IdeShellAction,
  type IdeShellActionPayload,
  type IdeShellOpenFileDetail,
  type IdeShellStateDetail,
  type IdeShellTreeFsOpDetail,
} from "./ideShellBridge";
import { monacoBeforeMount } from "./plugin-ide-monaco";
import {
  NPM_DEBOUNCE_MS,
  NODE_MODULES_LIST_MARKER,
  PLUGIN_IDE_CUSTOM_EDITOR_KEY,
  PLUGIN_IDE_FILES_COLLAPSED_KEY,
  PLUGIN_IDE_FORMAT_ON_SAVE_KEY,
  PLUGIN_IDE_RELOAD_ON_SAVE_KEY,
  PLUGIN_IDE_TOOLBAR_MENU_PANEL,
  PLUGIN_IDE_TSC_ON_SAVE_KEY,
  basenameRel,
  formatImportedPathsForStatus,
  initialPasteDestRel,
  languageForPath,
  normalizePluginRelPath,
  readSnapshotMap,
  sampleNoteForType,
  siblingCopyRelativePath,
  writeSnapshotMap,
  type InstalledPkg,
  type NpmSearchRow,
  type OpenTab,
  type PathModalState,
  type StoredWorkspaceSnapshot,
  type TscDiagnostic,
} from "./plugin-ide-utils";
import { formatPluginSourceWithPrettier } from "./plugin-ide-prettier-format";
import type { PluginIDEProps } from "./PluginIDE.types";
import { handlePluginIdeShellAction } from "./plugin-ide-shell-action-handler";
import type { PluginIDEIdeActions } from "./plugin-ide-ide-actions.types";
import { usePluginIDEKeyboardShortcuts } from "./usePluginIDE.keyboard";
import { usePluginIDECoreState } from "./usePluginIDE.coreState";
import { usePluginIDEWorkspaceLifecycle } from "./usePluginIDE.workspaceLifecycle";
import { usePluginIDEOpenSaveAndNpm } from "./usePluginIDE.openSaveAndNpm";
import { usePluginIDEBundleDiskAndTabs } from "./usePluginIDE.bundleDiskAndTabs";
import { usePluginIDEMonacoTypecheck } from "./usePluginIDE.monacoTypecheck";
import { usePluginIDEImportPathAndClipboard } from "./usePluginIDE.importPathAndClipboard";
import { usePluginIDEDistDepsAndRename } from "./usePluginIDE.distDepsAndRename";
import { usePluginIDETreeScaffoldAndTools } from "./usePluginIDE.treeScaffoldAndTools";

export function usePluginIDEShellLayoutEffects(p: ReturnType<typeof usePluginIDETreeScaffoldAndTools>) {
  const {
    activePath,
    activeTab,
    bundleAndReload,
    bundleLocalOnly,
    busy,
    copyDistToFolder,
    copyToInternalClipboard,
    cutToInternalClipboard,
    dirtyTabCount,
    fileList,
    folderFilesCache,
    folders,
    formatOnSave,
    ideActionsRef,
    loadArchonFromParent,
    onDeletePath,
    onImportFiles,
    onImportFolderIntoWorkspace,
    onImportNewWorkspace,
    openFile,
    openFileRef,
    pasteFromInternalClipboard,
    pendingShellOpenRef,
    pluginFolder,
    pluginFolderRef,
    publishAsFile,
    reloadOnSave,
    reloadOnly,
    removeExternalRegistration,
    runInstallDependencies,
    runTreeFsOp,
    runTypecheck,
    saveActive,
    saveAllDirtyTabs,
    setFolderFilesCache,
    setFormatOnSave,
    setPluginFolder,
    setReloadOnSave,
    setTreeSelectedPaths,
    setTreeSelectionWorkspace,
    setTscOnSave,
    shellLayout,
    treeSelectedPaths,
    treeSelectionWorkspace,
    tscOnSave,
  } = p;


  useEffect(() => {
    if (!shellLayout) {
      return;
    }
    const detail: IdeShellStateDetail = {
      pluginFolder,
      folders: folders.map((name) => ({
        name,
        fileList: folderFilesCache[name] ?? null,
      })),
      fileList,
      activePath,
      treeSelectionWorkspace,
      treeSelectedPaths,
      busy,
      dirtyTabCount,
      hasActiveTab: !!activeTab,
      tscOnSave,
      formatOnSave,
      reloadOnSave,
    };
    window.dispatchEvent(
      new CustomEvent(IDE_SHELL_STATE_EVENT, { detail }),
    );
  }, [
    shellLayout,
    pluginFolder,
    folders,
    folderFilesCache,
    fileList,
    activePath,
    treeSelectionWorkspace,
    treeSelectedPaths,
    busy,
    dirtyTabCount,
    activeTab,
    tscOnSave,
    formatOnSave,
    reloadOnSave,
  ]);

  useEffect(() => {
    if (!shellLayout) {
      return;
    }
    const onTreeSel = (e: Event) => {
      const d = (e as CustomEvent<{ workspace: string; paths: string[] }>)
        .detail;
      if (d && typeof d.workspace === "string" && Array.isArray(d.paths)) {
        setTreeSelectionWorkspace(d.workspace);
        setTreeSelectedPaths(d.paths);
      }
    };
    const onTreeFs = (e: Event) => {
      const d = (e as CustomEvent<IdeShellTreeFsOpDetail>).detail;
      if (d && typeof d === "object") {
        void runTreeFsOp(d);
      }
    };
    window.addEventListener(IDE_SHELL_TREE_SELECTION_EVENT, onTreeSel);
    window.addEventListener(IDE_SHELL_TREE_FS_OP_EVENT, onTreeFs);
    return () => {
      window.removeEventListener(IDE_SHELL_TREE_SELECTION_EVENT, onTreeSel);
      window.removeEventListener(IDE_SHELL_TREE_FS_OP_EVENT, onTreeFs);
    };
  }, [shellLayout, runTreeFsOp]);

  useEffect(() => {
    if (!shellLayout) {
      return;
    }
    const onExpand = (e: Event) => {
      const name = (e as CustomEvent<string>).detail;
      if (typeof name !== "string" || !name) {
        return;
      }
      void (async () => {
        try {
          const files = await getArchon().listPluginSourceFiles(name);
          setFolderFilesCache((prev) => ({ ...prev, [name]: files }));
        } catch (err) {
          clientLog({
            component: "PluginIDE",
            level: "warn",
            message: `listPluginSourceFiles(${name}): ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      })();
    };
    window.addEventListener(IDE_SHELL_EXPAND_FOLDER_EVENT, onExpand);
    return () =>
      window.removeEventListener(IDE_SHELL_EXPAND_FOLDER_EVENT, onExpand);
  }, [shellLayout]);

  useEffect(() => {
    const pend = pendingShellOpenRef.current;
    if (!pluginFolder || pend == null) {
      return;
    }
    pendingShellOpenRef.current = null;
    queueMicrotask(() => {
      void openFileRef.current(pend);
    });
  }, [pluginFolder]);

  useEffect(() => {
    if (!shellLayout) {
      return;
    }
    const onPlugin = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id === "string") {
        setPluginFolder(id);
      }
    };
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<IdeShellOpenFileDetail>).detail;
      if (typeof d === "string") {
        void openFileRef.current(d);
        return;
      }
      if (
        d &&
        typeof d === "object" &&
        typeof d.relativePath === "string" &&
        typeof d.pluginFolder === "string"
      ) {
        if (d.pluginFolder === pluginFolderRef.current) {
          void openFileRef.current(d.relativePath);
        } else {
          pendingShellOpenRef.current = d.relativePath;
          setPluginFolder(d.pluginFolder);
        }
      }
    };
    const onAction = (e: Event) => {
      const detail = (
        e as CustomEvent<{ type: IdeShellAction } & IdeShellActionPayload>
      ).detail;
      const t = detail?.type;
      if (!t) {
        return;
      }
      const d = detail;
      const a = ideActionsRef.current;
      switch (t) {
        case "save":
          void a.saveActive();
          return;
        case "saveAll":
          void a.saveAllDirtyTabs();
          return;
        case "newFile":
          a.openNewFileModal();
          return;
        case "newFolder":
          a.openNewFolderModal();
          return;
        case "importFiles":
          void a.onImportFiles();
          return;
        case "importFolder":
          void a.onImportFolderIntoWorkspace();
          return;
        case "importNewWorkspace":
          void a.onImportNewWorkspace();
          return;
        case "delete":
          void a.onDeletePath(d.targetPaths, d.targetWorkspace);
          return;
        case "rename": {
          const tw = d.targetWorkspace;
          if (tw && tw !== pluginFolderRef.current) {
            setPluginFolder(tw);
            const p = d.targetPaths?.[0];
            queueMicrotask(() => {
              ideActionsRef.current.openRenameModal(p);
            });
          } else {
            a.openRenameModal(d.targetPaths?.[0]);
          }
          return;
        }
        case "copy":
          void a.copyToInternalClipboard(
            d.targetPaths?.length || d.targetWorkspace
              ? {
                  paths: d.targetPaths,
                  sourceWorkspace: d.targetWorkspace,
                }
              : undefined,
          );
          return;
        case "cut":
          void a.cutToInternalClipboard(
            d.targetPaths?.length || d.targetWorkspace
              ? {
                  paths: d.targetPaths,
                  sourceWorkspace: d.targetWorkspace,
                }
              : undefined,
          );
          return;
        case "paste":
          void a.pasteFromInternalClipboard(d.pasteIntoDir);
          return;
        case "copyDist":
          void a.copyDistToFolder();
          return;
        case "bundle":
          void a.bundleLocalOnly();
          return;
        case "bundleReload":
          void a.bundleAndReload();
          return;
        case "reloadRegistry":
          void a.reloadOnly();
          return;
        case "typecheck":
          void a.runTypecheck();
          return;
        case "toggleTscOnSave":
          setTscOnSave((v) => {
            const n = !v;
            if (n) {
              localStorage.setItem(PLUGIN_IDE_TSC_ON_SAVE_KEY, "1");
            } else {
              localStorage.removeItem(PLUGIN_IDE_TSC_ON_SAVE_KEY);
            }
            return n;
          });
          return;
        case "toggleFormatOnSave":
          setFormatOnSave((v) => {
            const n = !v;
            if (n) {
              localStorage.setItem(PLUGIN_IDE_FORMAT_ON_SAVE_KEY, "1");
            } else {
              localStorage.removeItem(PLUGIN_IDE_FORMAT_ON_SAVE_KEY);
            }
            return n;
          });
          return;
        case "toggleReloadOnSave":
          setReloadOnSave((v) => {
            const n = !v;
            if (n) {
              localStorage.setItem(PLUGIN_IDE_RELOAD_ON_SAVE_KEY, "1");
            } else {
              localStorage.removeItem(PLUGIN_IDE_RELOAD_ON_SAVE_KEY);
            }
            return n;
          });
          return;
        case "installDeps":
          void a.runInstallDependencies();
          return;
        case "publishAsFile":
          void a.publishAsFile();
          return;
        case "loadParent":
          void a.loadArchonFromParent();
          return;
        case "removeExternal":
          void a.removeExternalRegistration(d.targetWorkspace);
          return;
        default:
          return;
      }
    };
    window.addEventListener(IDE_SHELL_PLUGIN_EVENT, onPlugin);
    window.addEventListener(IDE_SHELL_OPEN_FILE_EVENT, onOpen);
    window.addEventListener(IDE_SHELL_ACTION_EVENT, onAction);
    return () => {
      window.removeEventListener(IDE_SHELL_PLUGIN_EVENT, onPlugin);
      window.removeEventListener(IDE_SHELL_OPEN_FILE_EVENT, onOpen);
      window.removeEventListener(IDE_SHELL_ACTION_EVENT, onAction);
    };
  }, [shellLayout]);

  return { ...p };
}
