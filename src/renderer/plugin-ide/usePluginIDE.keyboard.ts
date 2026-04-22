import { useEffect, type MutableRefObject } from "react";
import type { PluginIDEIdeActions } from "./plugin-ide-ide-actions.types";

export function usePluginIDEKeyboardShortcuts(
  ideActionsRef: MutableRefObject<PluginIDEIdeActions>,
): void {
  useEffect(() => {
    const shortcutSurfaceOk = (ev: KeyboardEvent): boolean => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) {
        return true;
      }
      if (t.closest(".monaco-editor")) {
        return true;
      }
      const tag = t.tagName;
      return tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT";
    };

    const onKey = (ev: KeyboardEvent) => {
      const a = ideActionsRef.current;
      if (ev.key === "F2") {
        if (!shortcutSurfaceOk(ev)) {
          return;
        }
        ev.preventDefault();
        a.openRenameModal();
        return;
      }
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        if (ev.shiftKey) {
          void a.saveAllDirtyTabs();
        } else {
          void a.saveActive();
        }
        return;
      }
      if (!mod || !ev.shiftKey) {
        return;
      }
      if (!shortcutSurfaceOk(ev)) {
        return;
      }
      const k = ev.key.toLowerCase();
      const stop = (): void => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      if (k === "t") {
        stop();
        void a.runTypecheck();
      } else if (k === "b") {
        stop();
        void a.bundleLocalOnly();
      } else if (k === "l") {
        stop();
        void a.reloadOnly();
      } else if (k === "e") {
        stop();
        void a.bundleAndReload();
      } else if (k === "o") {
        stop();
        void a.onImportFiles();
      } else if (k === "n") {
        stop();
        a.openNewFileModal();
      } else if (k === "p") {
        stop();
        void a.loadArchonFromParent();
      } else if (k === "d") {
        stop();
        void a.copyDistToFolder();
      } else if (k === "c") {
        stop();
        void a.copyToInternalClipboard();
      } else if (k === "x") {
        stop();
        void a.cutToInternalClipboard();
      } else if (k === "v") {
        stop();
        void a.pasteFromInternalClipboard();
      } else if (k === "m") {
        stop();
        a.openRenameModal();
      } else if (k === "i") {
        stop();
        void a.runInstallDependencies();
      } else if (k === "delete" || k === "backspace") {
        stop();
        void a.onDeletePath();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ideActionsRef]);
}
