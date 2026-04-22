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

export function usePluginIDEBundleDiskAndTabs(p: ReturnType<typeof usePluginIDEOpenSaveAndNpm>) {
  const {
    activePath,
    activeTab,
    confirm,
    diskConflictPath,
    editorRef,
    onPluginsChanged,
    pluginFolder,
    refreshTypes,
    saveActive,
    setActivePath,
    setBusy,
    setDiskConflictPath,
    setPreviewRev,
    setStatus,
    setTabs,
    setTscDiagnostics,
    tabs,
    tscDiagnostics,
  } = p;


  const closeTab = (rel: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const tab = tabs.find((t) => t.relativePath === rel);
    void (async () => {
      if (tab && tab.content !== tab.savedContent) {
        const ok = await confirm({
          title: "Discard changes",
          message: `Discard unsaved changes in ${rel}?`,
          confirmLabel: "Discard",
          variant: "danger",
        });
        if (!ok) {
          return;
        }
      }
      const next = tabs.filter((t) => t.relativePath !== rel);
      setTabs(next);
      setActivePath((cur) => {
        if (cur === rel) {
          return next[0]?.relativePath ?? null;
        }
        return cur;
      });
      if (diskConflictPath === rel) {
        setDiskConflictPath(null);
      }
    })();
  };

  const resolveDiskConflictReload = async () => {
    const rel = diskConflictPath;
    const pf = pluginFolder;
    if (!rel || !pf) {
      return;
    }
    setBusy(true);
    try {
      const content = await getArchon().readPluginSourceFile(pf, rel);
      if (content === null) {
        setStatus("File not found on disk.");
        return;
      }
      const meta = await getArchon().getPluginSourceFileMeta(pf, rel);
      setTabs((prev) =>
        prev.map((t) =>
          t.relativePath === rel
            ? {
                ...t,
                content,
                savedContent: content,
                diskMtimeMs: meta?.mtimeMs ?? null,
              }
            : t,
        ),
      );
      setDiskConflictPath(null);
      setStatus(`Reloaded ${rel} from disk.`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Reload from disk failed");
    } finally {
      setBusy(false);
    }
  };

  const resolveDiskConflictKeepMine = async () => {
    const rel = diskConflictPath;
    const pf = pluginFolder;
    if (!rel || !pf) {
      return;
    }
    const meta = await getArchon().getPluginSourceFileMeta(pf, rel);
    setTabs((prev) =>
      prev.map((t) =>
        t.relativePath === rel
          ? { ...t, diskMtimeMs: meta?.mtimeMs ?? t.diskMtimeMs }
          : t,
      ),
    );
    setDiskConflictPath(null);
    setStatus(`Keeping editor version of ${rel}; disk baseline updated.`);
  };

  const bundleLocalOnly = async () => {
    if (!pluginFolder) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      if (activeTab && activeTab.content !== activeTab.savedContent) {
        const ok = await saveActive();
        if (!ok) {
          return;
        }
      }
      const bundle = await getArchon().bundlePluginLocal(pluginFolder);
      if (!bundle.success) {
        setStatus(bundle.error ?? "Bundle failed");
        return;
      }
      setStatus("Bundle OK (dist/ updated).");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  };

  const bundleAndReload = async () => {
    if (!pluginFolder) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      if (activeTab && activeTab.content !== activeTab.savedContent) {
        const ok = await saveActive();
        if (!ok) {
          setBusy(false);
          return;
        }
      }
      const installRes = await getArchon().installPluginDependencies(
        pluginFolder,
      );
      if (!installRes.success) {
        setStatus(installRes.error ?? "npm install failed");
        setBusy(false);
        return;
      }
      const bundle = await getArchon().bundlePluginLocal(pluginFolder);
      if (!bundle.success) {
        setStatus(bundle.error ?? "Bundle failed");
        setBusy(false);
        return;
      }
      const reload = await getArchon().reloadPluginRegistry();
      if (!reload.success) {
        setStatus(reload.error ?? "Reload failed");
        setBusy(false);
        return;
      }
      setPreviewRev((r) => r + 1);
      await refreshTypes();
      onPluginsChanged?.();
      setStatus(
        "Bundled and registry reloaded. Use File → Copy dist… to export dist/ elsewhere.",
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  };

  const publishAsFile = async () => {
    if (!pluginFolder) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      if (activeTab && activeTab.content !== activeTab.savedContent) {
        const ok = await saveActive();
        if (!ok) {
          return;
        }
      }
      const res = await getArchon().publishPluginAsFile(pluginFolder);
      if (!res.success) {
        setStatus(res.error ?? "Publish failed");
        return;
      }
      setStatus(
        res.path ? `Published: ${res.path}` : "Published plugin package.",
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Publish failed");
    } finally {
      setBusy(false);
    }
  };

  const reloadOnly = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const reload = await getArchon().reloadPluginRegistry();
      if (!reload.success) {
        setStatus(reload.error ?? "Reload failed");
        return;
      }
      setPreviewRev((r) => r + 1);
      await refreshTypes();
      onPluginsChanged?.();
      setStatus("Registry reloaded.");
    } finally {
      setBusy(false);
    }
  };

  const applyTscMarkers = useCallback(() => {
    const ed = editorRef.current;
    if (!ed || !activePath) {
      return;
    }
    const model = ed.getModel();
    if (!model) {
      return;
    }
    const rel = activePath.replace(/\\/g, "/");
    const markers = tscDiagnostics
      .filter((d) => d.relativePath === rel)
      .map((d) => ({
        startLineNumber: d.line,
        startColumn: d.column,
        endLineNumber: d.line,
        endColumn: d.column + 1,
        message:
          d.code != null ? `[TS${d.code}] ${d.message}` : d.message,
        severity:
          d.category === "error"
            ? MarkerSeverity.Error
            : d.category === "warning"
              ? MarkerSeverity.Warning
              : MarkerSeverity.Info,
      }));
    monacoEditor.setModelMarkers(model, "tsc", markers);
  }, [activePath, tscDiagnostics]);

  useEffect(() => {
    setTscDiagnostics([]);
  }, [pluginFolder]);

  useEffect(() => {
    applyTscMarkers();
  }, [applyTscMarkers]);
  return {
    ...p,
    closeTab,
    resolveDiskConflictReload,
    resolveDiskConflictKeepMine,
    bundleLocalOnly,
    bundleAndReload,
    publishAsFile,
    reloadOnly,
    applyTscMarkers,
  };
}
