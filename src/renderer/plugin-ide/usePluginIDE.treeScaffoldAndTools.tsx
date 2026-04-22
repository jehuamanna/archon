import { getArchon } from "../../shared/archon-host-access";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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

export function usePluginIDETreeScaffoldAndTools(p: ReturnType<typeof usePluginIDEDistDepsAndRename>) {
  const {
    bundleAndReload,
    bundleLocalOnly,
    busy,
    canScaffold,
    copyDistToFolder,
    copyToInternalClipboard,
    cutToInternalClipboard,
    loadArchonFromParent,
    onDeletePath,
    onImportFiles,
    onImportFolder,
    onImportFolderIntoWorkspace,
    onImportNewWorkspace,
    openFileRef,
    openRenameModal,
    pasteFromInternalClipboard,
    pluginFolder,
    pluginFolderRef,
    previewType,
    publishAsFile,
    refreshFileList,
    refreshWorkspaceFolders,
    reloadOnly,
    removeExternalRegistration,
    runInstallDependencies,
    runTypecheck,
    saveActive,
    saveAllDirtyTabs,
    setBusy,
    setCanScaffold,
    setFolderFilesCache,
    setPathModal,
    setStatus,
  } = p;

  const runTreeFsOp = useCallback(
    async (d: IdeShellTreeFsOpDetail) => {
      const fromRel = normalizePluginRelPath(d.fromRel);
      const toDirNorm = d.toDirRel
        ? normalizePluginRelPath(d.toDirRel)
        : "";
      const isDup = d.kind === "dndCopy";
      let destRel = toDirNorm
        ? `${toDirNorm}/${basenameRel(fromRel)}`
        : basenameRel(fromRel);
      let attempt = 0;
      setBusy(true);
      setStatus(null);
      try {
        let res = isDup
          ? d.fromPlugin === d.toPlugin
            ? await getArchon().copyPluginSourceWithinWorkspace(
                d.toPlugin,
                fromRel,
                destRel,
              )
            : await getArchon().copyPluginSourceBetweenWorkspaces(
                d.fromPlugin,
                fromRel,
                d.toPlugin,
                destRel,
              )
          : await getArchon().movePluginSourceBetweenWorkspaces(
              d.fromPlugin,
              fromRel,
              d.toPlugin,
              destRel,
            );
        while (!res.success && attempt < 16) {
          attempt += 1;
          destRel = siblingCopyRelativePath(destRel, d.fromIsDir);
          res = isDup
            ? d.fromPlugin === d.toPlugin
              ? await getArchon().copyPluginSourceWithinWorkspace(
                  d.toPlugin,
                  fromRel,
                  destRel,
                )
              : await getArchon().copyPluginSourceBetweenWorkspaces(
                  d.fromPlugin,
                  fromRel,
                  d.toPlugin,
                  destRel,
                )
            : await getArchon().movePluginSourceBetweenWorkspaces(
                d.fromPlugin,
                fromRel,
                d.toPlugin,
                destRel,
              );
        }
        if (!res.success) {
          setStatus(res.error ?? "Drag and drop failed");
          return;
        }
        if (d.toPlugin === pluginFolderRef.current) {
          await refreshFileList();
        }
        try {
          const files = await getArchon().listPluginSourceFiles(d.toPlugin);
          setFolderFilesCache((prev) => ({ ...prev, [d.toPlugin]: files }));
        } catch {
          /* ignore */
        }
        if (
          d.toPlugin === pluginFolderRef.current &&
          !d.fromIsDir &&
          isDup
        ) {
          await openFileRef.current(destRel);
        }
        setStatus(
          isDup ? `Duplicated to ${destRel}` : `Moved to ${destRel}`,
        );
      } finally {
        setBusy(false);
      }
    },
    [refreshFileList],
  );

  const runScaffold = useCallback(async () => {
    if (!pluginFolder || busy) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const r = await getArchon().scaffoldPluginWorkspace(pluginFolder);
      if (!r.success) {
        setStatus(r.error ?? "Scaffold failed");
        return;
      }
      setCanScaffold(false);
      await refreshFileList();
      await refreshWorkspaceFolders();
      setStatus(
        "Plugin scaffolded — run Install dependencies, then bundle & reload.",
      );
    } finally {
      setBusy(false);
    }
  }, [pluginFolder, busy, refreshFileList, refreshWorkspaceFolders]);

  const runExternalEditorChoice = useCallback(
    async (v: string) => {
      if (!pluginFolder || !v) {
        return;
      }
      if (v === "reveal") {
        const r = await getArchon().revealPluginWorkspaceInFileManager(
          pluginFolder,
        );
        setStatus(
          r.success
            ? "Opened folder in file manager."
            : (r.error ?? "Reveal failed"),
        );
        return;
      }
      if (v === "custom") {
        const prev = localStorage.getItem(PLUGIN_IDE_CUSTOM_EDITOR_KEY) ?? "";
        const cmd = window.prompt(
          "Shell command to run in the plugin folder (e.g. myeditor)",
          prev,
        );
        if (!cmd?.trim()) {
          return;
        }
        localStorage.setItem(PLUGIN_IDE_CUSTOM_EDITOR_KEY, cmd.trim());
        const r = await getArchon().openPluginWorkspaceInEditor({
          editor: "custom",
          customBin: cmd.trim(),
          pluginName: pluginFolder,
        });
        setStatus(
          r.success ? `Launched: ${cmd.trim()}` : (r.error ?? "Launch failed"),
        );
        return;
      }
      const r = await getArchon().openPluginWorkspaceInEditor({
        editor: v,
        pluginName: pluginFolder,
      });
      setStatus(
        r.success ? `Opened folder in ${v}.` : (r.error ?? "Launch failed"),
      );
    },
    [pluginFolder],
  );

  const workspaceToolsControls = (
    <>
      {canScaffold ? (
        <button
          type="button"
          disabled={busy}
          className="rounded-sm border border-border bg-muted/40 px-2 py-1 text-[11px] text-foreground hover:bg-muted disabled:opacity-50"
          onClick={() => void runScaffold()}
        >
          Initialize plugin
        </button>
      ) : null}
      <select
        className="max-w-[12rem] rounded-sm border border-input bg-background px-2 py-1 text-[11px]"
        disabled={!pluginFolder || busy}
        aria-label="Open plugin folder in external app"
        defaultValue=""
        onChange={(e) => {
          const v = e.target.value;
          e.target.value = "";
          void runExternalEditorChoice(v);
        }}
      >
        <option value="">Open folder in…</option>
        <option value="vscode">VS Code</option>
        <option value="cursor">Cursor</option>
        <option value="windsurf">Windsurf</option>
        <option value="anigravity">Antigravity</option>
        <option value="custom">Custom command…</option>
        <option value="reveal">File manager</option>
      </select>
      <button
        type="button"
        className="rounded-sm border border-input bg-background px-2 py-1 text-[11px] hover:bg-muted/50"
        disabled={busy}
        title="Electron DevTools for this window (inspect host + plugin iframe)"
        onClick={() => void getArchon().toggleDeveloperTools()}
      >
        DevTools
      </button>
    </>
  );

  const previewNote = useMemo(
    () => (previewType ? sampleNoteForType(previewType) : null),
    [previewType],
  );

  const ideActionsRef = useRef<PluginIDEIdeActions>({
    saveActive,
    saveAllDirtyTabs,
    runTypecheck,
    bundleLocalOnly,
    bundleAndReload,
    publishAsFile,
    reloadOnly,
    onImportFiles,
    onImportFolder,
    onImportFolderIntoWorkspace,
    onImportNewWorkspace,
    loadArchonFromParent,
    removeExternalRegistration,
    copyDistToFolder,
    copyToInternalClipboard,
    cutToInternalClipboard,
    pasteFromInternalClipboard,
    openRenameModal,
    runInstallDependencies,
    onDeletePath,
    openNewFileModal: () =>
      setPathModal({ kind: "newFile", value: "newfile.js" }),
    openNewFolderModal: () =>
      setPathModal({ kind: "newFolder", value: "lib" }),
  });
  ideActionsRef.current = {
    saveActive,
    saveAllDirtyTabs,
    runTypecheck,
    bundleLocalOnly,
    bundleAndReload,
    publishAsFile,
    reloadOnly,
    onImportFiles,
    onImportFolder,
    onImportFolderIntoWorkspace,
    onImportNewWorkspace,
    loadArchonFromParent,
    removeExternalRegistration,
    copyDistToFolder,
    copyToInternalClipboard,
    cutToInternalClipboard,
    pasteFromInternalClipboard,
    openRenameModal,
    runInstallDependencies,
    onDeletePath,
    openNewFileModal: () =>
      setPathModal({ kind: "newFile", value: "newfile.js" }),
    openNewFolderModal: () =>
      setPathModal({ kind: "newFolder", value: "lib" }),
  };
  return {
    ...p,
    runTreeFsOp,
    runScaffold,
    runExternalEditorChoice,
    workspaceToolsControls,
    previewNote,
    ideActionsRef,
  };
}
