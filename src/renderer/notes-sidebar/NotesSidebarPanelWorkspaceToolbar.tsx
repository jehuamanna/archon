import React from "react";
import SectionLabel from "./SectionLabel";

export interface NotesSidebarPanelWorkspaceToolbarProps {
  onRefreshWorkspace?: () => void;
  onAddWorkspaceFolder?: () => void;
  selectedNoteIds: Set<string>;
  setSelectedNoteIds: React.Dispatch<React.SetStateAction<Set<string>>>;
}

const NotesSidebarPanelWorkspaceToolbar: React.FC<
  NotesSidebarPanelWorkspaceToolbarProps
> = ({
  onRefreshWorkspace,
  onAddWorkspaceFolder,
  selectedNoteIds,
  setSelectedNoteIds,
}) => (
  <div className="mb-1 flex items-center justify-between gap-2 px-1">
    <SectionLabel>Notes</SectionLabel>
    <div className="flex min-w-0 shrink-0 items-center gap-1">
      {onRefreshWorkspace ? (
        <button
          type="button"
          className="rounded-sm border border-sidebar-border bg-sidebar-accent/40 px-1.5 py-0.5 text-[10px] font-medium text-sidebar-foreground/90 shadow-sm hover:bg-sidebar-accent"
          title="Reload notes from all open project folders"
          onClick={onRefreshWorkspace}
        >
          Refresh
        </button>
      ) : null}
      {onAddWorkspaceFolder ? (
        <button
          type="button"
          className="rounded-sm border border-sidebar-border bg-sidebar-accent/40 px-1.5 py-0.5 text-[10px] font-medium text-sidebar-foreground/90 shadow-sm hover:bg-sidebar-accent"
          title="Add another project folder and merge its notes here"
          onClick={onAddWorkspaceFolder}
        >
          Add folder
        </button>
      ) : null}
      {selectedNoteIds.size > 1 ? (
        <button
          type="button"
          className="rounded-sm px-1.5 py-0.5 text-[10px] font-medium text-sidebar-foreground/60 underline-offset-2 hover:text-sidebar-foreground hover:underline"
          onClick={() => setSelectedNoteIds(new Set())}
        >
          Clear ({selectedNoteIds.size})
        </button>
      ) : !onAddWorkspaceFolder && !onRefreshWorkspace ? (
        <span className="w-px shrink-0" aria-hidden />
      ) : null}
    </div>
  </div>
);

export default NotesSidebarPanelWorkspaceToolbar;
