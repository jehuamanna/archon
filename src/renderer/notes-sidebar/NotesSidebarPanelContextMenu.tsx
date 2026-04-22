import { getArchon } from "../../shared/archon-host-access";
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CreateNoteRelation,
  NoteListItem,
  PasteSubtreePayload,
} from "@archon/ui-types";
import type {
  ArchonAlertOptions,
  ArchonConfirmOptions,
} from "../dialog/ArchonDialogProvider";
import { useToast } from "../toast/ToastContext";
import {
  clipboardTouchesDeleted,
  ctxBtn,
  filesystemNoteDisplayPath,
  workspaceFolderLabel,
  type ClipboardState,
  type ContextMenuState,
} from "./notes-sidebar-utils";
import NotesSidebarPanelContextMenuPickType from "./NotesSidebarPanelContextMenuPickType";
import NotesSidebarPanelContextMenuMoveTarget from "./NotesSidebarPanelContextMenuMoveTarget";

export interface NotesSidebarPanelContextMenuProps {
  menu: ContextMenuState | null;
  menuRef: React.RefObject<HTMLDivElement | null>;
  closeMenu: () => void;
  confirm: (opts: ArchonConfirmOptions) => Promise<boolean>;
  alert: (opts: ArchonAlertOptions) => Promise<void>;
  notes: NoteListItem[];
  registeredTypes: string[];
  multiSelectCount: number;
  bulkDeleteRoots: string[];
  clipboard: ClipboardState;
  setClipboard: React.Dispatch<React.SetStateAction<ClipboardState>>;
  lastTopLevelId: string | null;
  parents: Map<string, string | null>;
  setMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>;
  setSelectedNoteIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  onDeleteNotes: (ids: string[]) => Promise<void>;
  onPasteSubtree: (payload: PasteSubtreePayload) => Promise<void>;
  onCreateNote: (payload: {
    anchorId?: string;
    relation: CreateNoteRelation;
    type: string;
    content?: string;
    title?: string;
  }) => Promise<void>;
  onRevealProjectFolder?: (noteId: string) => void;
  openRename: (id: string, title: string) => void;
  workspaceLabels: Record<string, string>;
  workspaceRoots: string[];
  onMoveComplete?: () => void;
}

const NotesSidebarPanelContextMenu: React.FC<NotesSidebarPanelContextMenuProps> = ({
  menu,
  menuRef,
  closeMenu,
  confirm,
  alert,
  notes,
  registeredTypes,
  multiSelectCount,
  bulkDeleteRoots,
  clipboard,
  setClipboard,
  lastTopLevelId,
  parents,
  setMenu,
  setSelectedNoteIds,
  onDeleteNotes,
  onPasteSubtree,
  onCreateNote,
  onRevealProjectFolder,
  openRename,
  workspaceLabels,
  workspaceRoots,
  onMoveComplete,
}) => {
  const { showToast } = useToast();
  if (!menu) {
    return null;
  }
  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[100] min-w-[220px] rounded-md border border-border bg-popover py-1 shadow-md"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
    >
      {menu.step === "main" ? (
        <>
          {menu.workspaceProjectRoot ? (
            <>
              <button
                type="button"
                className={ctxBtn}
                onClick={() => {
                  const p = menu.workspaceProjectRoot;
                  closeMenu();
                  if (p) {
                    void getArchon().revealProjectFolderInExplorer(p);
                  }
                }}
              >
                Open project folder…
              </button>
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                className={ctxBtn}
                onClick={() => {
                  const p = menu.workspaceProjectRoot;
                  if (!p) {
                    return;
                  }
                  const name = workspaceFolderLabel(p, workspaceLabels);
                  closeMenu();
                  void (async () => {
                    const ok = await confirm({
                      title: "Remove from workspace",
                      message: `Remove “${name}” from this workspace?`,
                      detail:
                        "Notes and files on disk stay in the folder. You can add it again with Add folder.",
                      confirmLabel: "Remove",
                      cancelLabel: "Cancel",
                      variant: "default",
                    });
                    if (!ok) {
                      return;
                    }
                    const r = await getArchon().removeWorkspaceRoot(p, false);
                    if (!r.ok) {
                      void alert({
                        title: "Could not update workspace",
                        message: r.error,
                      });
                    }
                  })();
                }}
              >
                Remove from workspace…
              </button>
              <button
                type="button"
                className={`${ctxBtn} font-medium text-foreground/90 hover:text-foreground`}
                onClick={() => {
                  const p = menu.workspaceProjectRoot;
                  if (!p) {
                    return;
                  }
                  const name = workspaceFolderLabel(p, workspaceLabels);
                  closeMenu();
                  void (async () => {
                    const ok = await confirm({
                      title: "Move to Trash",
                      message: `Remove “${name}” from the workspace and move the folder to the Trash?`,
                      detail:
                        "The app detaches this project first, then asks the system to move the folder to Trash. You may be able to restore it from Trash depending on your OS.",
                      confirmLabel: "Move to Trash",
                      cancelLabel: "Cancel",
                      variant: "danger",
                    });
                    if (!ok) {
                      return;
                    }
                    const r = await getArchon().removeWorkspaceRoot(p, true);
                    if (!r.ok) {
                      void alert({
                        title: "Could not update workspace",
                        message: r.error,
                      });
                      return;
                    }
                    if (r.trashError) {
                      void alert({
                        title: "Removed from workspace",
                        message:
                          "The folder was removed from the workspace, but moving it to Trash failed.",
                        detail: r.trashError,
                      });
                    }
                  })();
                }}
              >
                Move to Trash and remove…
              </button>
            </>
          ) : menu.anchorId ? (
            <>
              {multiSelectCount <= 1 ? (
                <button
                  type="button"
                  className={ctxBtn}
                  onClick={() => {
                    const n = notes.find((x) => x.id === menu.anchorId);
                    if (n) {
                      openRename(n.id, n.title);
                    }
                  }}
                >
                  Rename…
                </button>
              ) : null}
              {multiSelectCount <= 1 &&
              menu.anchorId &&
              onRevealProjectFolder ? (
                <button
                  type="button"
                  className={ctxBtn}
                  onClick={() => {
                    const id = menu.anchorId;
                    closeMenu();
                    if (id) {
                      void onRevealProjectFolder(id);
                    }
                  }}
                >
                  Open project folder…
                </button>
              ) : null}
              {multiSelectCount <= 1 && menu.anchorId ? (
                <>
                  <button
                    type="button"
                    className={ctxBtn}
                    onClick={() => {
                      const id = menu.anchorId;
                      const path =
                        id &&
                        filesystemNoteDisplayPath({
                          noteId: id,
                          notes,
                          parents,
                          workspaceRoots,
                          workspaceLabels,
                        });
                      closeMenu();
                      if (!path) {
                        showToast({ severity: "error", message: "Could not copy" });
                        return;
                      }
                      void (async () => {
                        try {
                          await navigator.clipboard.writeText(path);
                        } catch {
                          showToast({ severity: "error", message: "Could not copy" });
                        }
                      })();
                    }}
                  >
                    Copy note path
                  </button>
                  <button
                    type="button"
                    className={ctxBtn}
                    onClick={() => {
                      const id = menu.anchorId;
                      closeMenu();
                      if (!id) {
                        return;
                      }
                      void (async () => {
                        try {
                          await navigator.clipboard.writeText(id);
                        } catch {
                          showToast({ severity: "error", message: "Could not copy" });
                        }
                      })();
                    }}
                  >
                    Copy note ID
                  </button>
                </>
              ) : null}
              {multiSelectCount <= 1 ? (
                <button
                  type="button"
                  className={ctxBtn}
                  onClick={() =>
                    setMenu({ ...menu, step: "pickMoveTarget" })
                  }
                >
                  Move to…
                </button>
              ) : null}
              {multiSelectCount <= 1 ? (
                <button
                  type="button"
                  className={ctxBtn}
                  onClick={() => {
                    if (menu.anchorId) {
                      setClipboard({ mode: "cut", sourceId: menu.anchorId });
                    }
                    closeMenu();
                  }}
                >
                  Cut
                </button>
              ) : null}
              {multiSelectCount <= 1 ? (
                <button
                  type="button"
                  className={ctxBtn}
                  onClick={() => {
                    if (menu.anchorId) {
                      setClipboard({ mode: "copy", sourceId: menu.anchorId });
                    }
                    closeMenu();
                  }}
                >
                  Copy
                </button>
              ) : null}
              {bulkDeleteRoots.length > 0 ? (
                <button
                  type="button"
                  className={ctxBtn}
                  onClick={() => {
                    const n = bulkDeleteRoots.length;
                    void (async () => {
                      const ok = await confirm({
                        title: "Delete notes",
                        message: `Delete ${n} note${n === 1 ? "" : "s"} and their subtrees?`,
                        confirmLabel: "Delete",
                        variant: "danger",
                      });
                      if (!ok) {
                        return;
                      }
                      closeMenu();
                      try {
                        await onDeleteNotes(bulkDeleteRoots);
                        setSelectedNoteIds(new Set());
                        setClipboard((c) =>
                          c &&
                          clipboardTouchesDeleted(
                            c.sourceId,
                            bulkDeleteRoots,
                            parents,
                          )
                            ? null
                            : c,
                        );
                      } catch {
                        /* app error state */
                      }
                    })();
                  }}
                >
                  Delete {bulkDeleteRoots.length}…
                </button>
              ) : null}
              {multiSelectCount <= 1 ? (
                <button
                  type="button"
                  className={ctxBtn}
                  onClick={() => {
                    if (!menu.anchorId) {
                      return;
                    }
                    const id = menu.anchorId;
                    void (async () => {
                      const ok = await confirm({
                        title: "Delete note",
                        message: "Delete this note and all notes under it?",
                        confirmLabel: "Delete",
                        variant: "danger",
                      });
                      if (!ok) {
                        return;
                      }
                      closeMenu();
                      try {
                        await onDeleteNotes([id]);
                        setSelectedNoteIds(new Set());
                        setClipboard((c) =>
                          c &&
                          clipboardTouchesDeleted(c.sourceId, [id], parents)
                            ? null
                            : c,
                        );
                      } catch {
                        /* app error state */
                      }
                    })();
                  }}
                >
                  Delete…
                </button>
              ) : null}
              {clipboard && multiSelectCount <= 1 ? (
                <>
                  <div className="my-1 h-px bg-border" />
                  <button
                    type="button"
                    className={ctxBtn}
                    onClick={async () => {
                      if (!clipboard || !menu.anchorId) {
                        return;
                      }
                      try {
                        await onPasteSubtree({
                          ...clipboard,
                          targetId: menu.anchorId,
                          placement: "into",
                        });
                        if (clipboard.mode === "cut") {
                          setClipboard(null);
                        }
                      } catch {
                        /* surfaced in app */
                      }
                      closeMenu();
                    }}
                  >
                    Paste as child
                  </button>
                  <button
                    type="button"
                    className={ctxBtn}
                    onClick={async () => {
                      if (!clipboard || !menu.anchorId) {
                        return;
                      }
                      try {
                        await onPasteSubtree({
                          ...clipboard,
                          targetId: menu.anchorId,
                          placement: "after",
                        });
                        if (clipboard.mode === "cut") {
                          setClipboard(null);
                        }
                      } catch {
                        /* surfaced in app */
                      }
                      closeMenu();
                    }}
                  >
                    Paste as sibling
                  </button>
                </>
              ) : null}
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                className={ctxBtn}
                onClick={() =>
                  setMenu({
                    ...menu,
                    step: "pickType",
                    pickRelation: "child",
                  })
                }
              >
                New child…
              </button>
              <button
                type="button"
                className={ctxBtn}
                onClick={() =>
                  setMenu({
                    ...menu,
                    step: "pickType",
                    pickRelation: "sibling",
                  })
                }
              >
                New sibling…
              </button>
            </>
          ) : (
            <>
              {clipboard && lastTopLevelId ? (
                <>
                  <button
                    type="button"
                    className={ctxBtn}
                    onClick={async () => {
                      if (!clipboard) {
                        return;
                      }
                      try {
                        await onPasteSubtree({
                          ...clipboard,
                          targetId: lastTopLevelId,
                          placement: "after",
                        });
                        if (clipboard.mode === "cut") {
                          setClipboard(null);
                        }
                      } catch {
                        /* surfaced in app */
                      }
                      closeMenu();
                    }}
                  >
                    Paste into workspace
                  </button>
                  <div className="my-1 h-px bg-border" />
                </>
              ) : null}
              <button
                type="button"
                className={ctxBtn}
                onClick={() =>
                  setMenu({
                    ...menu,
                    step: "pickType",
                    pickRelation: "root",
                  })
                }
              >
                New top-level note…
              </button>
            </>
          )}
        </>
      ) : menu.step === "pickMoveTarget" ? (
        <NotesSidebarPanelContextMenuMoveTarget
          noteId={menu.anchorId!}
          notes={notes}
          confirm={confirm}
          closeMenu={closeMenu}
          setMenu={setMenu}
          menu={menu}
          onMoveComplete={onMoveComplete}
        />
      ) : (
        <NotesSidebarPanelContextMenuPickType
          menu={menu}
          setMenu={setMenu}
          registeredTypes={registeredTypes}
          onCreateNote={onCreateNote}
          closeMenu={closeMenu}
        />
      )}
    </div>,
    document.body,
  );
};

export default NotesSidebarPanelContextMenu;
