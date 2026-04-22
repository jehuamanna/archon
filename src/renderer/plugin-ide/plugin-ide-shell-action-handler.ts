import type React from "react";
import {
  PLUGIN_IDE_FORMAT_ON_SAVE_KEY,
  PLUGIN_IDE_RELOAD_ON_SAVE_KEY,
  PLUGIN_IDE_TSC_ON_SAVE_KEY,
} from "./plugin-ide-utils";
import type { IdeShellAction, IdeShellActionPayload } from "./ideShellBridge";
import type { PluginIDEIdeActions } from "./plugin-ide-ide-actions.types";

export type PluginIdeShellActionContext = {
  ideActionsRef: React.MutableRefObject<PluginIDEIdeActions>;
  pluginFolderRef: React.MutableRefObject<string>;
  setPluginFolder: React.Dispatch<React.SetStateAction<string>>;
  setTscOnSave: React.Dispatch<React.SetStateAction<boolean>>;
  setFormatOnSave: React.Dispatch<React.SetStateAction<boolean>>;
  setReloadOnSave: React.Dispatch<React.SetStateAction<boolean>>;
};

export function handlePluginIdeShellAction(
  detail: ({ type: IdeShellAction } & IdeShellActionPayload) | undefined,
  ctx: PluginIdeShellActionContext,
): void {
  const t = detail?.type;
  if (!t) {
    return;
  }
  const d = detail;
  const a = ctx.ideActionsRef.current;
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
      if (tw && tw !== ctx.pluginFolderRef.current) {
        ctx.setPluginFolder(tw);
        const p = d.targetPaths?.[0];
        queueMicrotask(() => {
          ctx.ideActionsRef.current.openRenameModal(p);
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
      ctx.setTscOnSave((v) => {
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
      ctx.setFormatOnSave((v) => {
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
      ctx.setReloadOnSave((v) => {
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
}
