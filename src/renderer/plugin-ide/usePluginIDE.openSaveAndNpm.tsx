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

export function usePluginIDEOpenSaveAndNpm(p: ReturnType<typeof usePluginIDEWorkspaceLifecycle>) {
  const {
    activePath,
    activeTab,
    filesPanelRef,
    formatOnSave,
    npmMenuOpen,
    npmQuery,
    npmWrapRef,
    pluginFolder,
    scheduleReloadAfterSave,
    setActivePath,
    setBusy,
    setNpmLoading,
    setNpmMenuOpen,
    setNpmResults,
    setStatus,
    setTabs,
    setToolbarMenu,
    setTscDiagnostics,
    shellLayout,
    tabs,
    toolbarMenu,
    toolbarMenuRef,
    tscOnSave,
  } = p;


  useEffect(() => {
    const q = npmQuery.trim();
    if (q.length < 2) {
      setNpmResults([]);
      setNpmLoading(false);
      return;
    }
    setNpmLoading(true);
    const t = window.setTimeout(() => {
      void (async () => {
        const res = await getArchon().npmRegistrySearch(q);
        if (!res.success) {
          setNpmResults([]);
          setNpmLoading(false);
          return;
        }
        setNpmResults(res.results);
        setNpmLoading(false);
      })();
    }, NPM_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [npmQuery]);

  useEffect(() => {
    if (!npmMenuOpen) {
      return;
    }
    const onDown = (ev: MouseEvent) => {
      const el = npmWrapRef.current;
      if (el && !el.contains(ev.target as Node)) {
        setNpmMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [npmMenuOpen]);

  useEffect(() => {
    if (!toolbarMenu) {
      return;
    }
    const onDown = (ev: MouseEvent) => {
      const el = toolbarMenuRef.current;
      if (el && !el.contains(ev.target as Node)) {
        setToolbarMenu(null);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setToolbarMenu(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [toolbarMenu]);

  useEffect(() => {
    if (shellLayout) {
      return;
    }
    const collapsed = localStorage.getItem(PLUGIN_IDE_FILES_COLLAPSED_KEY) === "1";
    const id = window.setTimeout(() => {
      if (collapsed) {
        filesPanelRef.current?.collapse();
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [shellLayout]);

  const openFile = async (relativePath: string) => {
    if (relativePath.endsWith("/")) {
      setStatus("Folders cannot be opened in the editor — use the tree for context actions.");
      return;
    }
    const existing = tabs.find((t) => t.relativePath === relativePath);
    if (existing) {
      setActivePath(relativePath);
      return;
    }
    try {
      const content = await getArchon().readPluginSourceFile(
        pluginFolder,
        relativePath,
      );
      if (content === null) {
        setStatus("File not found.");
        return;
      }
      const meta = await getArchon().getPluginSourceFileMeta(
        pluginFolder,
        relativePath,
      );
      setTabs((prev) => [
        ...prev,
        {
          relativePath,
          content,
          savedContent: content,
          diskMtimeMs: meta?.mtimeMs ?? null,
        },
      ]);
      setActivePath(relativePath);
      setStatus(null);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Open failed");
    }
  };

  const markDirtyFromContent = (value: string | undefined) => {
    if (!activePath || value === undefined) {
      return;
    }
    setTabs((prev) =>
      prev.map((t) =>
        t.relativePath === activePath ? { ...t, content: value } : t,
      ),
    );
  };

  const tryPrettierFormat = useCallback(
    async (content: string, relativePath: string): Promise<string> => {
      if (!pluginFolder || !formatOnSave) {
        return content;
      }
      const lower = relativePath.toLowerCase();
      const dot = lower.lastIndexOf(".");
      const ext = dot >= 0 ? lower.slice(dot + 1) : "";
      const supported = new Set([
        "ts",
        "tsx",
        "js",
        "jsx",
        "mjs",
        "cjs",
        "json",
        "css",
        "md",
      ]);
      if (!supported.has(ext)) {
        return content;
      }
      try {
        const prettier = await import("prettier/standalone");
        const estree = await import("prettier/plugins/estree");
        const plugins: object[] = [estree];
        let parser: string;
        if (ext === "ts" || ext === "tsx") {
          plugins.push(await import("prettier/plugins/typescript"));
          parser = "typescript";
        } else if (
          ext === "js" ||
          ext === "jsx" ||
          ext === "mjs" ||
          ext === "cjs"
        ) {
          plugins.push(await import("prettier/plugins/babel"));
          parser = "babel";
        } else if (ext === "json") {
          plugins.push(await import("prettier/plugins/babel"));
          parser = "json";
        } else if (ext === "css") {
          plugins.push(await import("prettier/plugins/postcss"));
          parser = "css";
        } else {
          plugins.push(await import("prettier/plugins/markdown"));
          parser = "markdown";
        }
        const rc: Record<string, unknown> = {};
        for (const cfg of [".prettierrc.json", ".prettierrc"] as const) {
          try {
            const raw = await getArchon().readPluginSourceFile(
              pluginFolder,
              cfg,
            );
            if (raw === null) {
              continue;
            }
            Object.assign(rc, JSON.parse(raw) as Record<string, unknown>);
            break;
          } catch {
            /* try next */
          }
        }
        const out = await prettier.format(content, {
          ...rc,
          parser,
          plugins,
        } as Parameters<typeof prettier.format>[1]);
        return out;
      } catch (e) {
        clientLog({
          component: "PluginIDE",
          level: "warn",
          message: `Prettier: ${e instanceof Error ? e.message : String(e)}`,
        });
        return content;
      }
    },
    [pluginFolder, formatOnSave],
  );

  const saveActive = async (): Promise<boolean> => {
    if (!pluginFolder || !activeTab) {
      return true;
    }
    if (activeTab.content === activeTab.savedContent) {
      return true;
    }
    let toWrite = activeTab.content;
    if (formatOnSave) {
      toWrite = await tryPrettierFormat(
        activeTab.content,
        activeTab.relativePath,
      );
      if (toWrite !== activeTab.content) {
        setTabs((prev) =>
          prev.map((t) =>
            t.relativePath === activeTab.relativePath
              ? { ...t, content: toWrite }
              : t,
          ),
        );
      }
    }
    const res = await getArchon().writePluginSourceFile(
      pluginFolder,
      activeTab.relativePath,
      toWrite,
    );
    if (!res.success) {
      setStatus(res.error ?? "Save failed");
      return false;
    }
    const afterMeta = await getArchon().getPluginSourceFileMeta(
      pluginFolder,
      activeTab.relativePath,
    );
    setTabs((prev) =>
      prev.map((t) =>
        t.relativePath === activeTab.relativePath
          ? {
              ...t,
              savedContent: t.content,
              diskMtimeMs: afterMeta?.mtimeMs ?? t.diskMtimeMs,
            }
          : t,
      ),
    );
    setStatus(`Saved ${activeTab.relativePath}`);
    if (tscOnSave && pluginFolder) {
      void (async () => {
        try {
          const tr = await getArchon().runPluginTypecheck(pluginFolder);
          setTscDiagnostics(tr.diagnostics);
        } catch {
          // ignore background typecheck errors
        }
      })();
    }
    scheduleReloadAfterSave();
    return true;
  };

  const saveAllDirtyTabs = async (): Promise<boolean> => {
    if (!pluginFolder) {
      return true;
    }
    const dirty = tabs.filter((t) => t.content !== t.savedContent);
    if (dirty.length === 0) {
      setStatus("Nothing to save.");
      return true;
    }
    setBusy(true);
    setStatus(null);
    try {
      for (const t of dirty) {
        let body = t.content;
        if (formatOnSave) {
          body = await tryPrettierFormat(t.content, t.relativePath);
          if (body !== t.content) {
            setTabs((prev) =>
              prev.map((x) =>
                x.relativePath === t.relativePath ? { ...x, content: body } : x,
              ),
            );
          }
        }
        const res = await getArchon().writePluginSourceFile(
          pluginFolder,
          t.relativePath,
          body,
        );
        if (!res.success) {
          setStatus(res.error ?? `Save failed: ${t.relativePath}`);
          return false;
        }
      }
      const mtimeByRel: Record<string, number | null> = {};
      for (const t of dirty) {
        const m = await getArchon().getPluginSourceFileMeta(
          pluginFolder,
          t.relativePath,
        );
        mtimeByRel[t.relativePath] = m?.mtimeMs ?? null;
      }
      setTabs((prev) =>
        prev.map((t) => {
          if (!(t.relativePath in mtimeByRel)) {
            return t;
          }
          return {
            ...t,
            savedContent: t.content,
            diskMtimeMs:
              mtimeByRel[t.relativePath] ?? t.diskMtimeMs,
          };
        }),
      );
      setStatus(`Saved ${dirty.length} file(s).`);
      if (tscOnSave) {
        void (async () => {
          try {
            const tr = await getArchon().runPluginTypecheck(pluginFolder);
            setTscDiagnostics(tr.diagnostics);
          } catch {
            /* ignore */
          }
        })();
      }
      scheduleReloadAfterSave();
      return true;
    } finally {
      setBusy(false);
    }
  };

  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

  return {
    ...p,
    openFile,
    openFileRef,
    tryPrettierFormat,
    markDirtyFromContent,
    saveActive,
    saveAllDirtyTabs,
  };
}
