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

export function usePluginIDEMonacoTypecheck(p: ReturnType<typeof usePluginIDEBundleDiskAndTabs>) {
  const {
    applyTscMarkers,
    busy,
    editorRef,
    ideTypingsLoadedRef,
    pluginFolder,
    setBusy,
    setStatus,
    setTscDiagnostics,
  } = p;


  const handleEditorMount: OnMount = useCallback(
    (ed) => {
      editorRef.current = ed;
      if (!ideTypingsLoadedRef.current) {
        ideTypingsLoadedRef.current = true;
        void getArchon().getIdeTypings().then((res) => {
          if (!res.libs?.length) {
            return;
          }
          for (const lib of res.libs) {
            monacoTypescript.typescriptDefaults.addExtraLib(
              lib.content,
              lib.fileName,
            );
            monacoTypescript.javascriptDefaults.addExtraLib(
              lib.content,
              lib.fileName,
            );
          }
        });
      }
      requestAnimationFrame(() => {
        applyTscMarkers();
      });
    },
    [applyTscMarkers],
  );

  const runTypecheck = useCallback(async () => {
    if (!pluginFolder || busy) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const res = await getArchon().runPluginTypecheck(pluginFolder);
      setTscDiagnostics(res.diagnostics);
      const errCount = res.diagnostics.filter((d) => d.category === "error")
        .length;
      if (res.error) {
        if (res.diagnostics.length === 0) {
          clientLog({
            component: "PluginIDE",
            level: "warn",
            message: res.error,
          });
          setStatus(
            "Typecheck failed: invalid tsconfig or compiler options. Fix tsconfig.json (options like target, module, moduleResolution, jsx must be string values).",
          );
        } else {
          setStatus(res.error);
        }
      } else if (errCount > 0) {
        setStatus(`Typecheck: ${errCount} error(s). See Problems.`);
      } else {
        const hints = res.diagnostics.length;
        setStatus(
          hints > 0
            ? `Types OK (${hints} warning(s)/hint(s)).`
            : "Types OK.",
        );
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Typecheck failed");
      setTscDiagnostics([]);
    } finally {
      setBusy(false);
    }
  }, [pluginFolder, busy]);
  return {
    ...p,
    handleEditorMount,
    runTypecheck,
  };
}
