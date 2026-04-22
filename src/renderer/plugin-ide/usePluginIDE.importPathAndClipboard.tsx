import { getArchon } from "../../shared/archon-host-access";
import {
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

export function usePluginIDEImportPathAndClipboard(p: ReturnType<typeof usePluginIDEMonacoTypecheck>) {
  const {
    activePath,
    busy,
    confirm,
    onPluginsChanged,
    openFile,
    pathClipboardRef,
    pathModal,
    pluginFolder,
    refreshFileList,
    refreshTypes,
    refreshWorkspaceFolders,
    setActivePath,
    setBusy,
    setPathModal,
    setPluginFolder,
    setPreviewRev,
    setStatus,
    setTabs,
    treeSelectedPaths,
    treeSelectionWorkspace,
  } = p;


  const submitPathModal = async () => {
    if (!pathModal || !pluginFolder || busy) {
      return;
    }
    const raw = pathModal.value.trim().replace(/\\/g, "/");
    if (!raw) {
      setStatus("Path is required.");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      if (pathModal.kind === "rename") {
        const toRel = raw.replace(/\/+$/, "");
        if (toRel === pathModal.from) {
          setPathModal(null);
          return;
        }
        const res = await getArchon().renamePluginSourcePath(
          pluginFolder,
          pathModal.from,
          toRel,
        );
        if (!res.success) {
          setStatus(res.error ?? "Rename failed");
          return;
        }
        const renamedMeta = await getArchon().getPluginSourceFileMeta(
          pluginFolder,
          toRel,
        );
        setTabs((prev) =>
          prev.map((t) =>
            t.relativePath === pathModal.from
              ? {
                  ...t,
                  relativePath: toRel,
                  diskMtimeMs: renamedMeta?.mtimeMs ?? t.diskMtimeMs,
                }
              : t,
          ),
        );
        setActivePath((ap) => (ap === pathModal.from ? toRel : ap));
        setPathModal(null);
        await refreshFileList();
        setStatus(`Renamed to ${toRel}`);
      } else if (pathModal.kind === "newFile") {
        const res = await getArchon().createPluginSourceFile(
          pluginFolder,
          raw,
          "",
        );
        if (!res.success) {
          setStatus(res.error ?? "Create failed");
          return;
        }
        setPathModal(null);
        await refreshFileList();
        await openFile(raw);
        setStatus(`Created ${raw}`);
      } else {
        const normalized = raw.replace(/\/+$/, "");
        const res = await getArchon().mkdirPluginSource(
          pluginFolder,
          normalized,
        );
        if (!res.success) {
          setStatus(res.error ?? "Create folder failed");
          return;
        }
        setPathModal(null);
        await refreshFileList();
        setStatus(`Created folder ${normalized}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const onImportFiles = async () => {
    if (!pluginFolder || busy) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const paths = await getArchon().selectImportFiles();
      if (!paths?.length) {
        return;
      }
      const res = await getArchon().importFilesIntoWorkspace(
        pluginFolder,
        paths,
        "",
      );
      if (!res.success) {
        setStatus(res.error ?? "Import failed");
        return;
      }
      await refreshFileList();
      setStatus(
        `Imported ${res.imported?.length ?? 0} file(s) under plugin root.${formatImportedPathsForStatus(res.imported)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const onImportFolderIntoWorkspace = useCallback(async () => {
    if (!pluginFolder || busy) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const dir = await getArchon().selectImportDirectory();
      if (!dir) {
        return;
      }
      const res = await getArchon().importDirectoryIntoWorkspace(
        pluginFolder,
        dir,
        "",
      );
      if (!res.success) {
        setStatus(res.error ?? "Import failed");
        return;
      }
      await refreshFileList();
      setStatus(
        `Imported ${res.imported?.length ?? 0} file(s) from folder under plugin root.${formatImportedPathsForStatus(res.imported)}`,
      );
    } finally {
      setBusy(false);
    }
  }, [pluginFolder, busy, refreshFileList]);

  const onImportNewWorkspace = useCallback(async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const dir = await getArchon().selectImportDirectory();
      if (!dir) {
        return;
      }
      const res = await getArchon().importDirectoryAsNewWorkspace(dir);
      if (!res.success) {
        setStatus(res.error ?? "Import failed");
        return;
      }
      await refreshWorkspaceFolders();
      if (res.folderName) {
        setPluginFolder(res.folderName);
        dispatchIdeShellExpandFolder(res.folderName);
      }
      const reload = await getArchon().reloadPluginRegistry();
      if (!reload.success) {
        setStatus(
          `Workspace "${res.folderName}" imported, but registry reload failed: ${reload.error ?? "unknown"}.`,
        );
        return;
      }
      setPreviewRev((r) => r + 1);
      await refreshTypes();
      onPluginsChanged?.();
      setStatus(
        `Registered plugin "${res.folderName}" in place (not copied to sources/). npm install runs in that folder.`,
      );
    } finally {
      setBusy(false);
    }
  }, [busy, refreshWorkspaceFolders, refreshTypes, onPluginsChanged]);

  const onImportFolder = useCallback(async () => {
    if (busy) {
      return;
    }
    if (pluginFolder) {
      await onImportFolderIntoWorkspace();
    } else {
      await onImportNewWorkspace();
    }
  }, [busy, pluginFolder, onImportFolderIntoWorkspace, onImportNewWorkspace]);

  const loadArchonFromParent = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const res = await getArchon().loadArchonPluginsFromParent();
      if (res.cancelled) {
        return;
      }
      await refreshWorkspaceFolders();
      const parts: string[] = [];
      if (res.added?.length) {
        parts.push(`Registered: ${res.added.join(", ")}`);
      }
      if (res.warnings?.length) {
        parts.push(...res.warnings);
      }
      if (res.errors?.length) {
        parts.push(`Errors: ${res.errors.join("; ")}`);
      }
      if (parts.length) {
        setStatus(parts.join(" · "));
      } else if (!res.success) {
        setStatus("No plugins found under parent (need .archonplugin + manifest.json).");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Load failed");
    } finally {
      setBusy(false);
    }
  };

  const removeExternalRegistration = async (explicitId?: string) => {
    const id = explicitId ?? pluginFolder;
    if (!id || busy) {
      return;
    }
    const ok = await confirm({
      title: "Remove workspace registration",
      message: `Remove “${id}” from the IDE workspace list? (Does not delete files on disk. Plugins under sources/ must be disabled in Plugin Manager.)`,
      confirmLabel: "Remove",
      variant: "default",
    });
    if (!ok) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const r = await getArchon().removeExternalPluginWorkspace(id);
      if (!r.success) {
        setStatus(r.error ?? "Remove failed");
        return;
      }
      if (id === pluginFolder) {
        setTabs([]);
        setActivePath(null);
      }
      await refreshWorkspaceFolders();
      setStatus(`Removed workspace registration for ${id}.`);
    } finally {
      setBusy(false);
    }
  };

  const copyToInternalClipboard = async (opts?: {
    paths?: string[];
    sourceWorkspace?: string;
  }) => {
    if (busy) {
      return;
    }
    const srcWs = opts?.sourceWorkspace ?? pluginFolder;
    if (!srcWs) {
      return;
    }
    const paths =
      opts?.paths ??
      (treeSelectionWorkspace === pluginFolder && treeSelectedPaths.length > 0
        ? treeSelectedPaths
        : activePath
          ? [activePath]
          : []);
    if (paths.length === 0) {
      setStatus("Select file(s) in the tree or open a file to copy.");
      return;
    }
    setBusy(true);
    try {
      const entries: { rel: string; isDir: boolean }[] = [];
      for (const rel of paths) {
        const nrel = normalizePluginRelPath(rel);
        const kind = await getArchon().getPluginSourceEntryKind(srcWs, nrel);
        if (kind === "missing") {
          setStatus(`Cannot copy: ${nrel} not found.`);
          return;
        }
        entries.push({ rel: nrel, isDir: kind === "dir" });
      }
      pathClipboardRef.current = {
        sourcePluginFolder: srcWs,
        entries,
        mode: "copy",
      };
      setStatus(
        entries.length === 1
          ? `Copied ${entries[0].rel} (${entries[0].isDir ? "folder" : "file"}) — use Paste.`
          : `Copied ${entries.length} items — use Paste.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const cutToInternalClipboard = async (opts?: {
    paths?: string[];
    sourceWorkspace?: string;
  }) => {
    if (busy) {
      return;
    }
    const srcWs = opts?.sourceWorkspace ?? pluginFolder;
    if (!srcWs) {
      return;
    }
    const paths =
      opts?.paths ??
      (treeSelectionWorkspace === pluginFolder && treeSelectedPaths.length > 0
        ? treeSelectedPaths
        : activePath
          ? [activePath]
          : []);
    if (paths.length === 0) {
      setStatus("Select file(s) in the tree or open a file to cut.");
      return;
    }
    setBusy(true);
    try {
      const entries: { rel: string; isDir: boolean }[] = [];
      for (const rel of paths) {
        const nrel = normalizePluginRelPath(rel);
        const kind = await getArchon().getPluginSourceEntryKind(srcWs, nrel);
        if (kind === "missing") {
          setStatus(`Cannot cut: ${nrel} not found.`);
          return;
        }
        entries.push({ rel: nrel, isDir: kind === "dir" });
      }
      pathClipboardRef.current = {
        sourcePluginFolder: srcWs,
        entries,
        mode: "cut",
      };
      setStatus(
        entries.length === 1
          ? `Cut ${entries[0].rel} (${entries[0].isDir ? "folder" : "file"}) — use Paste to move.`
          : `Cut ${entries.length} items — use Paste to move.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const pasteFromInternalClipboard = async (pasteIntoDir?: string) => {
    if (!pluginFolder || busy) {
      return;
    }
    const clip = pathClipboardRef.current;
    if (!clip?.entries.length) {
      setStatus("Nothing to paste (Copy or Cut first).");
      return;
    }
    const isCut = clip.mode === "cut";
    const srcFolder = clip.sourcePluginFolder;
    setBusy(true);
    try {
      const movedMap = new Map<string, string>();
      const lastNonDirs: string[] = [];
      for (const ent of clip.entries) {
        let destRel = initialPasteDestRel(
          ent.rel,
          ent.isDir,
          pasteIntoDir,
        );
        let attempt = 0;
        let res = isCut
          ? await getArchon().movePluginSourceBetweenWorkspaces(
              srcFolder,
              ent.rel,
              pluginFolder,
              destRel,
            )
          : srcFolder === pluginFolder
            ? await getArchon().copyPluginSourceWithinWorkspace(
                pluginFolder,
                ent.rel,
                destRel,
              )
            : await getArchon().copyPluginSourceBetweenWorkspaces(
                srcFolder,
                ent.rel,
                pluginFolder,
                destRel,
              );
        while (!res.success && attempt < 12) {
          attempt += 1;
          destRel = siblingCopyRelativePath(destRel, ent.isDir);
          res = isCut
            ? await getArchon().movePluginSourceBetweenWorkspaces(
                srcFolder,
                ent.rel,
                pluginFolder,
                destRel,
              )
            : srcFolder === pluginFolder
              ? await getArchon().copyPluginSourceWithinWorkspace(
                  pluginFolder,
                  ent.rel,
                  destRel,
                )
              : await getArchon().copyPluginSourceBetweenWorkspaces(
                  srcFolder,
                  ent.rel,
                  pluginFolder,
                  destRel,
                );
        }
        if (!res.success) {
          setStatus(res.error ?? `Paste failed for ${ent.rel}`);
          return;
        }
        movedMap.set(ent.rel, destRel);
        if (!ent.isDir) {
          lastNonDirs.push(destRel);
        }
      }
      await refreshFileList();
      if (isCut && srcFolder === pluginFolder) {
        const metas = await Promise.all(
          [...movedMap.entries()].map(async ([from, to]) => {
            const m = await getArchon().getPluginSourceFileMeta(
              pluginFolder,
              to,
            );
            return { from, to, mtime: m?.mtimeMs ?? null };
          }),
        );
        setTabs((prev) =>
          prev.map((t) => {
            const row = metas.find((x) => x.from === t.relativePath);
            return row
              ? {
                  ...t,
                  relativePath: row.to,
                  diskMtimeMs: row.mtime ?? t.diskMtimeMs,
                }
              : t;
          }),
        );
        setActivePath((ap) => {
          const row = metas.find((x) => x.from === ap);
          return row ? row.to : ap;
        });
      }
      const openTarget = lastNonDirs[lastNonDirs.length - 1];
      if (openTarget) {
        await openFile(openTarget);
      }
      if (isCut) {
        pathClipboardRef.current = null;
        setStatus(
          movedMap.size === 1
            ? `Moved to ${[...movedMap.values()][0]}`
            : `Moved ${movedMap.size} items.`,
        );
      } else {
        setStatus(
          movedMap.size === 1
            ? `Duplicated to ${[...movedMap.values()][0]}`
            : `Duplicated ${movedMap.size} items.`,
        );
      }
    } finally {
      setBusy(false);
    }
  };
  return {
    ...p,
    submitPathModal,
    onImportFiles,
    onImportFolderIntoWorkspace,
    onImportNewWorkspace,
    onImportFolder,
    loadArchonFromParent,
    removeExternalRegistration,
    copyToInternalClipboard,
    cutToInternalClipboard,
    pasteFromInternalClipboard,
  };
}
