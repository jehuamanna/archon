import React from "react";
import { createPortal } from "react-dom";
import { dispatchIdeShellPlugin } from "../../plugin-ide/ideShellBridge";
import { fireIdeShellAction } from "./editor-tab-sidebar-actions";
import {
  menuItem,
  menuPortalPanel,
  WORKSPACE_TITLE_CTX_PATH,
  type TreeCtxMenu,
} from "./editor-tab-sidebar-constants";
import { fsRelFromTreePath } from "./editor-tab-sidebar-tree";

type Props = {
  ctxMenu: TreeCtxMenu | null;
  ctxPortalRef: React.RefObject<HTMLDivElement | null>;
  busy: boolean;
  setCtxMenu: (m: TreeCtxMenu | null) => void;
};

export function EditorTabCtxMenuPortal({
  ctxMenu,
  ctxPortalRef,
  busy,
  setCtxMenu,
}: Props): React.ReactNode {
  if (!ctxMenu) {
    return null;
  }
  return createPortal(
    <div
      ref={ctxPortalRef}
      role="menu"
      className={menuPortalPanel}
      style={{ top: ctxMenu.top, left: ctxMenu.left }}
    >
      {ctxMenu.path === WORKSPACE_TITLE_CTX_PATH ? (
        <>
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            disabled={busy}
            onClick={() => {
              dispatchIdeShellPlugin(ctxMenu.workspace);
              setCtxMenu(null);
            }}
          >
            Open this workspace
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            disabled={busy}
            onClick={() => {
              fireIdeShellAction("importNewWorkspace");
              setCtxMenu(null);
            }}
          >
            Add plugin workspace…
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${menuItem} text-foreground/90 hover:bg-muted`}
            disabled={busy}
            onClick={() => {
              fireIdeShellAction("removeExternal", {
                targetWorkspace: ctxMenu.workspace,
              });
              setCtxMenu(null);
            }}
          >
            Remove from IDE list
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            disabled={busy}
            onClick={() => {
              fireIdeShellAction("copy", {
                targetPaths: [fsRelFromTreePath(ctxMenu.path)],
                targetWorkspace: ctxMenu.workspace,
              });
              setCtxMenu(null);
            }}
          >
            Copy
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            disabled={busy}
            onClick={() => {
              fireIdeShellAction("cut", {
                targetPaths: [fsRelFromTreePath(ctxMenu.path)],
                targetWorkspace: ctxMenu.workspace,
              });
              setCtxMenu(null);
            }}
          >
            Cut
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            disabled={busy}
            onClick={() => {
              fireIdeShellAction("rename", {
                targetPaths: [fsRelFromTreePath(ctxMenu.path)],
                targetWorkspace: ctxMenu.workspace,
              });
              setCtxMenu(null);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${menuItem} font-medium text-foreground/90 hover:bg-muted`}
            disabled={busy}
            onClick={() => {
              fireIdeShellAction("delete", {
                targetPaths: [fsRelFromTreePath(ctxMenu.path)],
                targetWorkspace: ctxMenu.workspace,
              });
              setCtxMenu(null);
            }}
          >
            Delete
          </button>
          {ctxMenu.isDir ? (
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              disabled={busy}
              onClick={() => {
                fireIdeShellAction("paste", {
                  pasteIntoDir: fsRelFromTreePath(ctxMenu.path),
                });
                setCtxMenu(null);
              }}
            >
              Paste into folder
            </button>
          ) : null}
        </>
      )}
    </div>,
    document.body,
  );
}
