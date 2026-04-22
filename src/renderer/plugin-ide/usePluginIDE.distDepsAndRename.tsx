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
import { usePluginIDEImportPathAndClipboard } from "./usePluginIDE.importPathAndClipboard";

export function usePluginIDEDistDepsAndRename(p: ReturnType<typeof usePluginIDEImportPathAndClipboard>) {
  const {
    activePath,
    addAsDevDep,
    busy,
    confirm,
    onPluginsChanged,
    pluginFolder,
    refreshFileList,
    setActivePath,
    setBusy,
    setFolderFilesCache,
    setInstalledPkgs,
    setNpmMenuOpen,
    setNpmQuery,
    setPathModal,
    setStatus,
    setTabs,
    setTreeSelectedPaths,
    tabs,
    treeSelectedPaths,
    treeSelectionWorkspace,
  } = p;


  const copyDistToFolder = async () => {
    if (!pluginFolder || busy) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const cp = await getArchon().copyPluginDistToFolder(pluginFolder);
      setStatus(
        cp.success
          ? "dist/ contents copied."
          : cp.error === "Cancelled"
            ? "Copy cancelled."
            : (cp.error ?? "Copy failed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const openRenameModal = (fromPath?: string) => {
    const rawFrom =
      fromPath ??
      (treeSelectionWorkspace === pluginFolder &&
      treeSelectedPaths.length === 1
        ? treeSelectedPaths[0]
        : activePath);
    if (!pluginFolder || !rawFrom) {
      setStatus("Select a single file or folder in the tree to rename.");
      return;
    }
    const from = normalizePluginRelPath(rawFrom);
    setPathModal({ kind: "rename", from, value: from });
  };

  const addRegistryDependency = async (row: NpmSearchRow) => {
    if (!pluginFolder || busy) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      let raw: string;
      try {
        const read = await getArchon().readPluginSourceFile(
          pluginFolder,
          "package.json",
        );
        if (read === null) {
          throw new Error("missing");
        }
        raw = read;
      } catch {
        raw = JSON.stringify(
          {
            name: pluginFolder,
            version: "1.0.0",
            private: true,
            dependencies: {},
            devDependencies: {},
          },
          null,
          2,
        );
      }
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        setStatus("package.json is not valid JSON.");
        return;
      }
      const depsKey = addAsDevDep ? "devDependencies" : "dependencies";
      const block = {
        ...((j[depsKey] as Record<string, string>) ?? {}),
      };
      block[row.name] = `^${row.version}`;
      j[depsKey] = block;
      const out = `${JSON.stringify(j, null, 2)}\n`;
      const w = await getArchon().writePluginSourceFile(
        pluginFolder,
        "package.json",
        out,
      );
      if (!w.success) {
        setStatus(w.error ?? "Could not write package.json");
        return;
      }
      setNpmMenuOpen(false);
      setNpmQuery("");
      const list: InstalledPkg[] = [];
      const d = (j.dependencies as Record<string, string>) ?? {};
      const dd = (j.devDependencies as Record<string, string>) ?? {};
      for (const [name, range] of Object.entries(d)) {
        list.push({ name, range, dev: false });
      }
      for (const [name, range] of Object.entries(dd)) {
        list.push({ name, range, dev: true });
      }
      list.sort((a, b) => a.name.localeCompare(b.name));
      setInstalledPkgs(list);
      setStatus(
        `Added ${row.name}@${`^${row.version}`} to package.json — run Install dependencies when ready.`,
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "package.json update failed");
    } finally {
      setBusy(false);
    }
  };

  const runInstallDependencies = async () => {
    if (!pluginFolder || busy) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const res = await getArchon().installPluginDependencies(pluginFolder);
      if (!res.success) {
        setStatus(res.error ?? "npm install failed");
        return;
      }
      setStatus("Dependencies installed.");
      onPluginsChanged?.();
      await refreshFileList();
    } finally {
      setBusy(false);
    }
  };

  const onDeletePath = async (
    explicitPaths?: string[],
    explicitWorkspace?: string,
  ) => {
    const ws = explicitWorkspace ?? pluginFolder;
    if (!ws || busy) {
      return;
    }
    const raw =
      explicitPaths?.length
        ? explicitPaths
        : treeSelectionWorkspace === ws && treeSelectedPaths.length > 0
          ? treeSelectedPaths
          : ws === pluginFolder && activePath
            ? [activePath]
            : [];
    if (raw.length === 0) {
      setStatus("Select file(s) in the tree or open a file to delete.");
      return;
    }
    const targets = [...new Set(raw.map(normalizePluginRelPath))].sort(
      (a, b) =>
        b.split("/").length - a.split("/").length || b.localeCompare(a),
    );
    const msg =
      targets.length === 1
        ? `Delete “${targets[0]}”? This cannot be undone.`
        : `Delete ${targets.length} paths? This cannot be undone.`;
    const ok = await confirm({
      title: "Delete files",
      message: msg,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const deleted = new Set<string>();
      for (const p of targets) {
        if (
          [...deleted].some(
            (d) => p === d || p.startsWith(`${d}/`),
          )
        ) {
          continue;
        }
        const res = await getArchon().deletePluginSourcePath(ws, p);
        if (!res.success) {
          setStatus(res.error ?? `Delete failed: ${p}`);
          return;
        }
        deleted.add(p);
      }
      const delSet = deleted;
      if (ws === pluginFolder) {
        const nextTabs = tabs.filter((t) => {
          if (delSet.has(t.relativePath)) {
            return false;
          }
          return ![...delSet].some((d) => t.relativePath.startsWith(`${d}/`));
        });
        setTabs(nextTabs);
        if (
          activePath &&
          (delSet.has(activePath) ||
            [...delSet].some((d) => activePath.startsWith(`${d}/`)))
        ) {
          setActivePath(nextTabs[0]?.relativePath ?? null);
        }
      }
      if (treeSelectionWorkspace === ws) {
        setTreeSelectedPaths((prev) =>
          prev.filter(
            (p) =>
              !delSet.has(p) &&
              ![...delSet].some((d) => p.startsWith(`${d}/`)),
          ),
        );
      }
      if (ws === pluginFolder) {
        await refreshFileList();
      } else {
        try {
          const files = await getArchon().listPluginSourceFiles(ws);
          setFolderFilesCache((prev) => ({ ...prev, [ws]: files }));
        } catch {
          /* ignore */
        }
      }
      setStatus(
        deleted.size === 1
          ? `Deleted ${[...deleted][0]}`
          : `Deleted ${deleted.size} items.`,
      );
    } finally {
      setBusy(false);
    }
  };

  return {
    ...p,
    copyDistToFolder,
    openRenameModal,
    addRegistryDependency,
    runInstallDependencies,
    onDeletePath,
  };
}
