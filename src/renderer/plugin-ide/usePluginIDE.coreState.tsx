import { getArchon } from "../../shared/archon-host-access";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  editor as monacoEditor,
  typescript as monacoTypescript,
} from "monaco-editor";
import {
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { useArchonDialog } from "../dialog/ArchonDialogProvider";
import { useTheme } from "../theme/ThemeContext";
import { useToast } from "../toast/ToastContext";
import {
  PLUGIN_IDE_FORMAT_ON_SAVE_KEY,
  PLUGIN_IDE_MAX_SNAPSHOT_FILE_BYTES,
  PLUGIN_IDE_RELOAD_ON_SAVE_KEY,
  PLUGIN_IDE_TSC_ON_SAVE_KEY,
  readSnapshotMap,
  writeSnapshotMap,
  type InstalledPkg,
  type NpmSearchRow,
  type OpenTab,
  type PathModalState,
  type StoredWorkspaceSnapshot,
  type TscDiagnostic,
} from "./plugin-ide-utils";
import type { PluginIDEProps } from "./PluginIDE.types";
import {
  getRegisteredTypesCached,
  getSelectableNoteTypesCached,
  invalidateArchonNoteTypesCaches,
} from "../utils/cached-archon-note-types";

export function usePluginIDECoreState(
  { onPluginsChanged, shellLayout = false, previewAssetProjectRoot = null }: PluginIDEProps,
) {
  const { resolvedDark } = useTheme();
  const monacoTheme = resolvedDark ? "vs-dark" : "vs";
  const { showToast } = useToast();
  const { confirm } = useArchonDialog();

  const [folders, setFolders] = useState<string[]>([]);
  const [folderFilesCache, setFolderFilesCache] = useState<
    Record<string, string[] | undefined>
  >({});
  const [pluginFolder, setPluginFolder] = useState<string>("");
  /** Absolute workspace as file:// so Monaco resolves imports like runtime (cache-backed virtual node_modules). */
  const [workspaceRootFileUri, setWorkspaceRootFileUri] = useState("");
  const [fileList, setFileList] = useState<string[]>([]);
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [previewType, setPreviewType] = useState<string>("");
  const [previewRev, setPreviewRev] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!status) {
      return;
    }
    const s = status.toLowerCase();
    let severity: "error" | "warning" | "info" | "log" = "info";
    if (
      s.includes("fail") ||
      /\berror\b/.test(s) ||
      s.includes("could not") ||
      s.includes("invalid") ||
      s.includes("not valid")
    ) {
      severity = "error";
    } else if (s.includes("warn")) {
      severity = "warning";
    }
    showToast({
      severity,
      message: status,
      mergeKey: `plugin-ide:${severity}`,
    });
  }, [status, showToast]);
  const [pathModal, setPathModal] = useState<PathModalState>(null);
  const filesPanelRef = useRef<ImperativePanelHandle | null>(null);
  const npmWrapRef = useRef<HTMLDivElement | null>(null);

  const [npmQuery, setNpmQuery] = useState("");
  const [npmResults, setNpmResults] = useState<NpmSearchRow[]>([]);
  const [npmLoading, setNpmLoading] = useState(false);
  const [npmMenuOpen, setNpmMenuOpen] = useState(false);
  const [toolbarMenu, setToolbarMenu] = useState<
    null | "file" | "edit" | "build"
  >(null);
  const toolbarMenuRef = useRef<HTMLDivElement | null>(null);
  const [addAsDevDep, setAddAsDevDep] = useState(false);
  const [installedPkgs, setInstalledPkgs] = useState<InstalledPkg[]>([]);
  const [tscDiagnostics, setTscDiagnostics] = useState<TscDiagnostic[]>([]);
  const [tscOnSave, setTscOnSave] = useState(
    () => localStorage.getItem(PLUGIN_IDE_TSC_ON_SAVE_KEY) === "1",
  );
  const [reloadOnSave, setReloadOnSave] = useState(
    () => localStorage.getItem(PLUGIN_IDE_RELOAD_ON_SAVE_KEY) === "1",
  );
  const [formatOnSave, setFormatOnSave] = useState(
    () => localStorage.getItem(PLUGIN_IDE_FORMAT_ON_SAVE_KEY) === "1",
  );
  const [diskConflictPath, setDiskConflictPath] = useState<string | null>(
    null,
  );
  const diskConflictPathRef = useRef<string | null>(null);
  diskConflictPathRef.current = diskConflictPath;
  const [treeSelectedPaths, setTreeSelectedPaths] = useState<string[]>([]);
  const [treeSelectionWorkspace, setTreeSelectionWorkspace] = useState("");
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [canScaffold, setCanScaffold] = useState(false);

  useEffect(() => {
    if (!previewExpanded) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPreviewExpanded(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewExpanded]);
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  const pluginFolderRef = useRef("");
  const pendingShellOpenRef = useRef<string | null>(null);
  const tabsRef = useRef<OpenTab[]>([]);
  const activePathRef = useRef<string | null>(null);
  const cursorByPathRef = useRef<
    Record<string, { lineNumber: number; column: number }>
  >({});
  const prevActivePathForCursorRef = useRef<string | null>(null);
  const reloadAfterSaveTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const pathClipboardRef = useRef<{
    sourcePluginFolder: string;
    entries: { rel: string; isDir: boolean }[];
    mode: "copy" | "cut";
  } | null>(null);
  const ideTypingsLoadedRef = useRef(false);
  const pluginDepTypingsDisposablesRef = useRef<{ dispose: () => void }[]>(
    [],
  );

  const activeTab = useMemo(
    () => tabs.find((t) => t.relativePath === activePath) ?? null,
    [tabs, activePath],
  );

  tabsRef.current = tabs;
  activePathRef.current = activePath;
  pluginFolderRef.current = pluginFolder;

  const dirtyTabCount = useMemo(
    () => tabs.filter((t) => t.content !== t.savedContent).length,
    [tabs],
  );

  const flushWorkspaceSnapshot = useCallback((pluginId: string) => {
    if (!pluginId) {
      return;
    }
    const tabsSnap: OpenTab[] = [];
    for (const t of tabsRef.current) {
      if (
        t.content.length > PLUGIN_IDE_MAX_SNAPSHOT_FILE_BYTES ||
        t.savedContent.length > PLUGIN_IDE_MAX_SNAPSHOT_FILE_BYTES
      ) {
        continue;
      }
      tabsSnap.push({ ...t });
    }
    const cursors = { ...cursorByPathRef.current };
    const ap = activePathRef.current;
    const ed = editorRef.current;
    if (ed && ap) {
      const pos = ed.getPosition();
      if (pos) {
        cursors[ap] = {
          lineNumber: pos.lineNumber,
          column: pos.column,
        };
      }
    }
    const snap: StoredWorkspaceSnapshot = {
      tabs: tabsSnap,
      activePath: ap,
      cursors,
    };
    const all = readSnapshotMap();
    all[pluginId] = snap;
    writeSnapshotMap(all);
  }, []);

  const refreshTypes = useCallback(async () => {
    const [registered, selectable] = await Promise.all([
      getRegisteredTypesCached(),
      getSelectableNoteTypesCached(),
    ]);
    const reg = new Set(Array.isArray(registered) ? registered : []);
    const raw = Array.isArray(selectable) ? selectable : [];
    const t = raw.filter((x) => x !== "root" && reg.has(x));
    setTypes(t);
    setPreviewType((cur) => (t.includes(cur) ? cur : t[0] ?? ""));
  }, []);

  const scheduleReloadAfterSave = useCallback(() => {
    if (!reloadOnSave) {
      return;
    }
    if (reloadAfterSaveTimerRef.current) {
      clearTimeout(reloadAfterSaveTimerRef.current);
    }
    reloadAfterSaveTimerRef.current = setTimeout(() => {
      reloadAfterSaveTimerRef.current = null;
      void (async () => {
        try {
          const r = await getArchon().reloadPluginRegistry();
          if (r.success) {
            setPreviewRev((x) => x + 1);
            invalidateArchonNoteTypesCaches();
            await refreshTypes();
            onPluginsChanged?.();
          }
        } catch {
          /* ignore */
        }
      })();
    }, 500);
  }, [reloadOnSave, refreshTypes, onPluginsChanged]);

  const refreshFileList = useCallback(async () => {
    if (!pluginFolder) {
      setFileList([]);
      return;
    }
    try {
      const files = await getArchon().listPluginSourceFiles(pluginFolder);
      setFileList(files);
      setFolderFilesCache((prev) => ({ ...prev, [pluginFolder]: files }));
    } catch (e) {
      setFileList([]);
      setStatus(
        e instanceof Error ? e.message : "Could not list plugin files",
      );
    }
  }, [pluginFolder]);

  /** Reload open tabs from disk when unchanged in the editor (external saves / other tools). */
  const syncCleanOpenTabsFromDisk = useCallback(async () => {
    const pf = pluginFolderRef.current;
    if (!pf) {
      return;
    }
    const replacements = new Map<
      string,
      { content: string; diskMtimeMs: number }
    >();
    for (const t of tabsRef.current) {
      if (t.content !== t.savedContent) {
        continue;
      }
      try {
        const meta = await getArchon().getPluginSourceFileMeta(
          pf,
          t.relativePath,
        );
        if (!meta) {
          continue;
        }
        if (t.diskMtimeMs !== null && meta.mtimeMs === t.diskMtimeMs) {
          continue;
        }
        const raw = await getArchon().readPluginSourceFile(pf, t.relativePath);
        if (raw === null) {
          continue;
        }
        replacements.set(t.relativePath, {
          content: raw,
          diskMtimeMs: meta.mtimeMs,
        });
      } catch {
        /* deleted or unreadable */
      }
    }
    if (replacements.size === 0) {
      return;
    }
    setTabs((prev) =>
      prev.map((tab) => {
        const r = replacements.get(tab.relativePath);
        return r
          ? {
              ...tab,
              content: r.content,
              savedContent: r.content,
              diskMtimeMs: r.diskMtimeMs,
            }
          : tab;
      }),
    );
  }, []);

  const checkDiskConflicts = useCallback(async () => {
    const pf = pluginFolderRef.current;
    if (!pf || diskConflictPathRef.current) {
      return;
    }
    for (const t of tabsRef.current) {
      if (t.content === t.savedContent) {
        continue;
      }
      if (t.diskMtimeMs == null) {
        continue;
      }
      try {
        const meta = await getArchon().getPluginSourceFileMeta(
          pf,
          t.relativePath,
        );
        if (!meta) {
          continue;
        }
        if (meta.mtimeMs > t.diskMtimeMs) {
          setDiskConflictPath(t.relativePath);
          setStatus(
            `File changed on disk: ${t.relativePath} (unsaved edits in editor).`,
          );
          return;
        }
      } catch {
        /* ignore */
      }
    }
  }, []);

  const refreshWorkspaceFolders = useCallback(async () => {
    const list = await getArchon().listPluginWorkspaceFolders();
    setFolders(list);
    setFolderFilesCache((prev) => {
      const next: Record<string, string[] | undefined> = {};
      for (const name of list) {
        if (prev[name] !== undefined) {
          next[name] = prev[name];
        }
      }
      return next;
    });
    setPluginFolder((cur) => (list.includes(cur) ? cur : list[0] ?? ""));
  }, []);

  useEffect(() => {
    void refreshWorkspaceFolders();
    void refreshTypes();
  }, [refreshTypes, refreshWorkspaceFolders]);

  useEffect(() => {
    return () => {
      if (reloadAfterSaveTimerRef.current) {
        clearTimeout(reloadAfterSaveTimerRef.current);
        reloadAfterSaveTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    void getArchon().setIdeWorkspaceWatch(pluginFolder || null);
    return () => {
      void getArchon().setIdeWorkspaceWatch(null);
    };
  }, [pluginFolder]);

  useEffect(() => {
    const off = getArchon().onIdeWorkspaceFsChanged(() => {
      void (async () => {
        await refreshFileList();
        await syncCleanOpenTabsFromDisk();
        await checkDiskConflicts();
      })();
    });
    return off;
  }, [refreshFileList, syncCleanOpenTabsFromDisk, checkDiskConflicts]);

  useEffect(() => {
    void refreshFileList();
  }, [refreshFileList]);

  useEffect(() => {
    if (!pluginFolder) {
      setCanScaffold(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const k = await getArchon().getPluginSourceEntryKind(
          pluginFolder,
          "manifest.json",
        );
        if (!cancelled) {
          setCanScaffold(k === "missing");
        }
      } catch {
        if (!cancelled) {
          setCanScaffold(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginFolder, fileList]);
  return {
    folders,
    setFolders,
    folderFilesCache,
    setFolderFilesCache,
    pluginFolder,
    setPluginFolder,
    workspaceRootFileUri,
    setWorkspaceRootFileUri,
    fileList,
    setFileList,
    tabs,
    setTabs,
    activePath,
    setActivePath,
    types,
    setTypes,
    previewType,
    setPreviewType,
    previewRev,
    setPreviewRev,
    status,
    setStatus,
    busy,
    setBusy,
    pathModal,
    setPathModal,
    filesPanelRef,
    npmWrapRef,
    npmQuery,
    setNpmQuery,
    npmResults,
    setNpmResults,
    npmLoading,
    setNpmLoading,
    npmMenuOpen,
    setNpmMenuOpen,
    toolbarMenu,
    setToolbarMenu,
    toolbarMenuRef,
    addAsDevDep,
    setAddAsDevDep,
    installedPkgs,
    setInstalledPkgs,
    tscDiagnostics,
    setTscDiagnostics,
    tscOnSave,
    setTscOnSave,
    reloadOnSave,
    setReloadOnSave,
    formatOnSave,
    setFormatOnSave,
    diskConflictPath,
    setDiskConflictPath,
    diskConflictPathRef,
    treeSelectedPaths,
    setTreeSelectedPaths,
    treeSelectionWorkspace,
    setTreeSelectionWorkspace,
    previewExpanded,
    setPreviewExpanded,
    canScaffold,
    setCanScaffold,
    editorRef,
    pluginFolderRef,
    pendingShellOpenRef,
    tabsRef,
    activePathRef,
    cursorByPathRef,
    prevActivePathForCursorRef,
    reloadAfterSaveTimerRef,
    pathClipboardRef,
    ideTypingsLoadedRef,
    pluginDepTypingsDisposablesRef,
    activeTab,
    dirtyTabCount,
    flushWorkspaceSnapshot,
    refreshTypes,
    scheduleReloadAfterSave,
    refreshFileList,
    syncCleanOpenTabsFromDisk,
    checkDiskConflicts,
    refreshWorkspaceFolders,
    resolvedDark,
    showToast,
    confirm,
    monacoTheme,
    onPluginsChanged,
    shellLayout,
    previewAssetProjectRoot,
  };
}
