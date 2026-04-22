import React from "react";
import { createPortal } from "react-dom";
import type { IdeShellStateDetail } from "../../plugin-ide/ideShellBridge";
import { fireIdeShellAction } from "./editor-tab-sidebar-actions";
import { menuItem, menuPortalPanel } from "./editor-tab-sidebar-constants";

type Props = {
  menu: "file" | "edit" | "build" | null;
  menuPos: { top: number; left: number } | null;
  menuPortalRef: React.RefObject<HTMLDivElement | null>;
  state: IdeShellStateDetail;
  pf: string;
  busy: boolean;
  hasOpen: boolean;
  dirty: number;
  canPathOp: boolean;
  canRename: boolean;
  setMenu: (m: "file" | "edit" | "build" | null) => void;
};

export function EditorTabMenuPortal({
  menu,
  menuPos,
  menuPortalRef,
  state,
  pf,
  busy,
  hasOpen,
  dirty,
  canPathOp,
  canRename,
  setMenu,
}: Props): React.ReactNode {
  if (!menu || !menuPos) {
    return null;
  }
  return createPortal(
    <div
      ref={menuPortalRef}
      role="menu"
      className={menuPortalPanel}
      style={{
        top: menuPos.top,
        left: menuPos.left,
      }}
    >
      {menu === "file" ? (
        <>
          <button
            type="button"
            role="menuitem"
            disabled={!hasOpen || busy}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("save");
            }}
          >
            Save
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!pf || busy || dirty === 0}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("saveAll");
            }}
          >
            Save all
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!pf || busy}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("newFile");
            }}
          >
            New file
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!pf || busy}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("newFolder");
            }}
          >
            New folder
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!pf || busy}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("importFiles");
            }}
          >
            Import file(s)
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!pf || busy}
            className={menuItem}
            title="Copy files from a chosen folder into the current plugin root"
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("importFolder");
            }}
          >
            Import folder into plugin…
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            className={menuItem}
            title="Pick a plugin folder on disk and register it as another workspace"
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("importNewWorkspace");
            }}
          >
            Add plugin workspace…
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canPathOp}
            className={`${menuItem} font-medium text-foreground/90 hover:bg-muted`}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("delete");
            }}
          >
            Delete
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canRename}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("rename");
            }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canPathOp}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("copy");
            }}
          >
            Copy
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canPathOp}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("cut");
            }}
          >
            Cut
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!pf || busy}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("paste");
            }}
          >
            Paste
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!pf || busy}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("copyDist");
            }}
          >
            Copy dist…
          </button>
        </>
      ) : null}
      {menu === "edit" ? (
        <>
          <button
            type="button"
            role="menuitem"
            disabled={!pf || busy}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("typecheck");
            }}
          >
            Check types (TS)
          </button>
          <div
            className="my-1 border-t border-border"
            role="separator"
            aria-hidden
          />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={state.tscOnSave}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("toggleTscOnSave");
            }}
          >
            {state.tscOnSave ? "✓ " : ""}
            Typecheck on save
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={state.formatOnSave}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("toggleFormatOnSave");
            }}
          >
            {state.formatOnSave ? "✓ " : ""}
            Format on save (Prettier)
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={state.reloadOnSave}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("toggleReloadOnSave");
            }}
          >
            {state.reloadOnSave ? "✓ " : ""}
            Reload registry on save
          </button>
        </>
      ) : null}
      {menu === "build" ? (
        <>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("loadParent");
            }}
          >
            Load parent (.archonplugin)
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!pf || busy}
            className={`${menuItem} text-foreground/90 hover:bg-muted`}
            title="Only removes plugins registered via “Load parent” or “Add plugin workspace”. Plugins under userData sources/ stay in the manager."
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("removeExternal");
            }}
          >
            Remove from IDE list
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!pf || busy}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("bundle");
            }}
          >
            Bundle
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!pf || busy}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("bundleReload");
            }}
          >
            Bundle &amp; reload
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("reloadRegistry");
            }}
          >
            Reload registry
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!pf || busy}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("installDeps");
            }}
          >
            Install dependencies
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!pf || busy}
            className={menuItem}
            onClick={() => {
              setMenu(null);
              fireIdeShellAction("publishAsFile");
            }}
          >
            Publish as file…
          </button>
        </>
      ) : null}
    </div>,
    document.body,
  );
}
