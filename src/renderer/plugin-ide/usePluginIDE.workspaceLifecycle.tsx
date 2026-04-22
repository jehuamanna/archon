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
import { usePluginIDECoreState } from "./usePluginIDE.coreState";

export function usePluginIDEWorkspaceLifecycle(p: ReturnType<typeof usePluginIDECoreState>) {
  const {
    activePath,
    cursorByPathRef,
    editorRef,
    flushWorkspaceSnapshot,
    pluginDepTypingsDisposablesRef,
    pluginFolder,
    prevActivePathForCursorRef,
    setActivePath,
    setDiskConflictPath,
    setInstalledPkgs,
    setTabs,
    setTreeSelectedPaths,
    setTreeSelectionWorkspace,
    setWorkspaceRootFileUri,
    tabs,
    workspaceRootFileUri,
  } = p;


  useEffect(() => {
    const id = pluginFolder;
    return () => {
      if (id) {
        flushWorkspaceSnapshot(id);
      }
    };
  }, [pluginFolder, flushWorkspaceSnapshot]);

  useEffect(() => {
    setDiskConflictPath(null);
    setTreeSelectedPaths([]);
    setTreeSelectionWorkspace("");
    if (!pluginFolder) {
      setTabs([]);
      setActivePath(null);
      cursorByPathRef.current = {};
      prevActivePathForCursorRef.current = null;
      return;
    }
    const snap = readSnapshotMap()[pluginFolder];
    if (!snap?.tabs?.length) {
      setTabs([]);
      setActivePath(null);
      cursorByPathRef.current = {};
      prevActivePathForCursorRef.current = null;
    } else {
      const normalized: OpenTab[] = snap.tabs.map((t) => ({
        relativePath: t.relativePath,
        content: t.content,
        savedContent: t.savedContent,
        diskMtimeMs:
          typeof (t as OpenTab).diskMtimeMs === "number"
            ? (t as OpenTab).diskMtimeMs
            : null,
      }));
      setTabs(normalized);
      const ap =
        snap.activePath &&
        normalized.some((t) => t.relativePath === snap.activePath)
          ? snap.activePath
          : (normalized[0]?.relativePath ?? null);
      setActivePath(ap);
      cursorByPathRef.current = { ...snap.cursors };
      prevActivePathForCursorRef.current = ap;
      const pf = pluginFolder;
      void (async () => {
        const metas = await Promise.all(
          normalized.map(async (t) => {
            const m = await getArchon().getPluginSourceFileMeta(
              pf,
              t.relativePath,
            );
            return { rel: t.relativePath, mtime: m?.mtimeMs ?? null };
          }),
        );
        setTabs((prev) =>
          prev.map((t) => {
            if (t.diskMtimeMs != null) {
              return t;
            }
            const row = metas.find((x) => x.rel === t.relativePath);
            return row ? { ...t, diskMtimeMs: row.mtime } : t;
          }),
        );
      })();
    }
  }, [pluginFolder]);

  useEffect(() => {
    const prev = prevActivePathForCursorRef.current;
    if (prev && editorRef.current) {
      const pos = editorRef.current.getPosition();
      if (pos) {
        cursorByPathRef.current[prev] = {
          lineNumber: pos.lineNumber,
          column: pos.column,
        };
      }
    }
    prevActivePathForCursorRef.current = activePath;
  }, [activePath]);

  useEffect(() => {
    if (!activePath) {
      return;
    }
    const pos = cursorByPathRef.current[activePath];
    if (!pos) {
      return;
    }
    let cancelled = false;
    const outer = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (cancelled) {
          return;
        }
        const ed = editorRef.current;
        if (!ed) {
          return;
        }
        ed.setPosition({
          lineNumber: pos.lineNumber,
          column: pos.column,
        });
        ed.revealPositionInCenter({
          lineNumber: pos.lineNumber,
          column: pos.column,
        });
        delete cursorByPathRef.current[activePath];
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(outer);
    };
  }, [activePath, workspaceRootFileUri]);

  useEffect(() => {
    let cancelled = false;
    const disposePluginDepTypings = () => {
      for (const d of pluginDepTypingsDisposablesRef.current) {
        d.dispose();
      }
      pluginDepTypingsDisposablesRef.current = [];
    };

    disposePluginDepTypings();
    setWorkspaceRootFileUri("");

    if (!pluginFolder) {
      return () => {
        cancelled = true;
        disposePluginDepTypings();
      };
    }

    void getArchon().getIdePluginTypings(pluginFolder).then((res) => {
      if (cancelled || !res) {
        return;
      }
      setWorkspaceRootFileUri(res.workspaceRootFileUri);
      for (const lib of res.libs) {
        const t = monacoTypescript.typescriptDefaults.addExtraLib(
          lib.content,
          lib.fileName,
        );
        const j = monacoTypescript.javascriptDefaults.addExtraLib(
          lib.content,
          lib.fileName,
        );
        pluginDepTypingsDisposablesRef.current.push(t, j);
      }
    });

    return () => {
      cancelled = true;
      disposePluginDepTypings();
    };
  }, [pluginFolder]);

  useEffect(() => {
    if (!pluginFolder) {
      setInstalledPkgs([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const raw = await getArchon().readPluginSourceFile(
          pluginFolder,
          "package.json",
        );
        if (raw === null) {
          if (!cancelled) {
            setInstalledPkgs([]);
          }
          return;
        }
        const j = JSON.parse(raw) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const list: InstalledPkg[] = [];
        for (const [name, range] of Object.entries(
          j.dependencies ?? {},
        )) {
          list.push({ name, range, dev: false });
        }
        for (const [name, range] of Object.entries(
          j.devDependencies ?? {},
        )) {
          list.push({ name, range, dev: true });
        }
        list.sort((a, b) => a.name.localeCompare(b.name));
        if (!cancelled) {
          setInstalledPkgs(list);
        }
      } catch {
        if (!cancelled) {
          setInstalledPkgs([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginFolder]);
  return { ...p };
}
