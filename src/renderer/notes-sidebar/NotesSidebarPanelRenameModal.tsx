import React from "react";
import { createPortal } from "react-dom";
import { InlineSingleLineEditable } from "../components/InlineSingleLineEditable";

export interface NotesSidebarPanelRenameModalProps {
  renameTarget: { id: string; title: string } | null;
  renameDraft: string;
  setRenameDraft: React.Dispatch<React.SetStateAction<string>>;
  setRenameTarget: React.Dispatch<
    React.SetStateAction<{ id: string; title: string } | null>
  >;
  submitRename: () => Promise<void>;
}

const NotesSidebarPanelRenameModal: React.FC<
  NotesSidebarPanelRenameModalProps
> = ({
  renameTarget,
  renameDraft,
  setRenameDraft,
  setRenameTarget,
  submitRename,
}) => {
  if (!renameTarget) {
    return null;
  }
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Rename note"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setRenameTarget(null);
        }
      }}
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg">
        <p className="text-[13px] font-medium text-foreground">Rename note</p>
        <InlineSingleLineEditable
          key={renameTarget.id}
          className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="New note title"
          value={renameDraft}
          onChange={setRenameDraft}
          onCommit={() => void submitRename()}
          onCancel={() => setRenameTarget(null)}
          commitOnBlur={false}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-muted/60"
            onClick={() => setRenameTarget(null)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="archon-btn-neutral rounded-md px-3 py-1.5 text-[12px] font-semibold"
            disabled={!renameDraft.trim()}
            onClick={() => void submitRename()}
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default NotesSidebarPanelRenameModal;
