import React from "react";
import type { CreateNoteRelation } from "@archon/ui-types";
import { ctxBtn, type ContextMenuState } from "./notes-sidebar-utils";

export interface NotesSidebarPanelContextMenuPickTypeProps {
  menu: ContextMenuState;
  setMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>;
  registeredTypes: string[];
  onCreateNote: (payload: {
    anchorId?: string;
    relation: CreateNoteRelation;
    type: string;
    content?: string;
    title?: string;
  }) => Promise<void>;
  closeMenu: () => void;
}

const NotesSidebarPanelContextMenuPickType: React.FC<
  NotesSidebarPanelContextMenuPickTypeProps
> = ({ menu, setMenu, registeredTypes, onCreateNote, closeMenu }) => (
  <>
    <button
      type="button"
      className={ctxBtn}
      onClick={() =>
        setMenu({
          ...menu,
          step: "main",
          pickRelation: undefined,
        })
      }
    >
      ← Back
    </button>
    <div className="my-1 h-px bg-border" />
    <p className="px-2.5 pb-1 text-[11px] text-muted-foreground">Note type</p>
    <div className="max-h-48 overflow-y-auto px-1">
      {registeredTypes.filter((t) => t !== "root").length === 0 ? (
        <p className="px-2 py-1 text-[11px] text-muted-foreground">
          No types loaded
        </p>
      ) : (
        registeredTypes
          .filter((t) => t !== "root")
          .map((type) => (
            <button
              key={type}
              type="button"
              className={ctxBtn}
              onClick={async () => {
                const rel = menu.pickRelation ?? "root";
                const anchorId =
                  rel === "root" ? undefined : menu.anchorId ?? undefined;
                try {
                  await onCreateNote({
                    relation: rel,
                    type,
                    anchorId,
                  });
                  closeMenu();
                } catch {
                  /* surfaced in app */
                }
              }}
            >
              {type}
            </button>
          ))
      )}
    </div>
  </>
);

export default NotesSidebarPanelContextMenuPickType;
