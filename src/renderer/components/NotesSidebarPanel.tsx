import React from "react";
import type {
  CreateNoteRelation,
  NoteListItem,
  NoteMovePlacement,
  PasteSubtreePayload,
} from "@archon/ui-types";
import { useArchonDialog } from "../dialog/ArchonDialogProvider";
import NotesSidebarPanelContextMenu from "../notes-sidebar/NotesSidebarPanelContextMenu";
import NotesSidebarPanelRenameModal from "../notes-sidebar/NotesSidebarPanelRenameModal";
import NotesSidebarPanelWorkspaceBody from "../notes-sidebar/NotesSidebarPanelWorkspaceBody";
import { useNotesSidebarPanelCore } from "../notes-sidebar/useNotesSidebarPanelCore";
import { useVfsDependentTitleRenameChoice } from "../shell/wpn/vfsDependentTitleRenameChoice";

export interface NotesSidebarPanelProps {
  notes: NoteListItem[];
  registeredTypes: string[];
  currentNoteId?: string;
  onNoteSelect: (noteId: string) => void;
  onCreateNote: (payload: {
    anchorId?: string;
    relation: CreateNoteRelation;
    type: string;
    content?: string;
    title?: string;
  }) => Promise<void>;
  onRenameNote: (id: string, title: string, options?: { updateVfsDependentLinks?: boolean }) => Promise<void>;
  onMoveNote: (payload: {
    draggedId: string;
    targetId: string;
    placement: NoteMovePlacement;
  }) => Promise<void>;
  onMoveNotesBulk: (payload: {
    ids: string[];
    targetId: string;
    placement: NoteMovePlacement;
  }) => Promise<void>;
  onDeleteNotes: (ids: string[]) => Promise<void>;
  onPasteSubtree: (payload: PasteSubtreePayload) => Promise<void>;
  onAddWorkspaceFolder?: () => void;
  onRevealProjectFolder?: (noteId: string) => void;
  onRefreshWorkspace?: () => void;
  onResyncNotes: () => void;
  workspaceRoots: string[];
  workspaceLabels: Record<string, string>;
  onSwapWorkspaceBlock: (payload: {
    blockIndex: number;
    direction: "up" | "down";
  }) => Promise<void>;
  onCommitWorkspaceFolderLabel: (
    rootPath: string,
    label: string | null,
  ) => Promise<void>;
  onOpenProjectAsset: (projectRoot: string, relativePath: string) => void;
  assetFsTick?: number;
  prefixNoteTitleWithType?: boolean;
}

const NotesSidebarPanel: React.FC<NotesSidebarPanelProps> = ({
  notes,
  registeredTypes,
  currentNoteId,
  onNoteSelect,
  onCreateNote,
  onRenameNote,
  onMoveNote,
  onMoveNotesBulk,
  onDeleteNotes,
  onPasteSubtree,
  onAddWorkspaceFolder,
  onRevealProjectFolder,
  onRefreshWorkspace,
  onResyncNotes,
  workspaceRoots,
  workspaceLabels,
  onSwapWorkspaceBlock,
  onCommitWorkspaceFolderLabel,
  onOpenProjectAsset,
  assetFsTick = 0,
  prefixNoteTitleWithType = false,
}) => {
  const { confirm, alert } = useArchonDialog();
  const vfsRenameChoice = useVfsDependentTitleRenameChoice();
  const core = useNotesSidebarPanelCore({
    notes,
    registeredTypes,
    currentNoteId,
    onNoteSelect,
    onRenameNote,
    onMoveNote,
    onMoveNotesBulk,
    workspaceRoots,
    vfsRenamePrompt: vfsRenameChoice.prompt,
  });

  return (
    <div className="flex h-full min-h-0 min-w-0 w-full flex-col bg-sidebar text-sidebar-foreground">
      {vfsRenameChoice.portal}
      <NotesSidebarPanelContextMenu
        menu={core.menu}
        menuRef={core.menuRef}
        closeMenu={core.closeMenu}
        confirm={confirm}
        alert={alert}
        notes={core.notes}
        registeredTypes={core.registeredTypes}
        multiSelectCount={core.multiSelectCount}
        bulkDeleteRoots={core.bulkDeleteRoots}
        clipboard={core.clipboard}
        setClipboard={core.setClipboard}
        lastTopLevelId={core.lastTopLevelId}
        parents={core.parents}
        setMenu={core.setMenu}
        setSelectedNoteIds={core.setSelectedNoteIds}
        onDeleteNotes={onDeleteNotes}
        onPasteSubtree={onPasteSubtree}
        onCreateNote={onCreateNote}
        onRevealProjectFolder={onRevealProjectFolder}
        openRename={core.openRename}
        workspaceLabels={workspaceLabels}
        workspaceRoots={workspaceRoots}
        onMoveComplete={onResyncNotes}
      />
      <NotesSidebarPanelRenameModal
        renameTarget={core.renameTarget}
        renameDraft={core.renameDraft}
        setRenameDraft={core.setRenameDraft}
        setRenameTarget={core.setRenameTarget}
        submitRename={core.submitRename}
      />
      <NotesSidebarPanelWorkspaceBody
        notes={core.notes}
        onRefreshWorkspace={onRefreshWorkspace}
        onResyncNotes={onResyncNotes}
        workspaceLabels={workspaceLabels}
        onSwapWorkspaceBlock={onSwapWorkspaceBlock}
        onCommitWorkspaceFolderLabel={onCommitWorkspaceFolderLabel}
        onAddWorkspaceFolder={onAddWorkspaceFolder}
        selectedNoteIds={core.selectedNoteIds}
        setSelectedNoteIds={core.setSelectedNoteIds}
        setMenu={core.setMenu}
        workspaceSections={core.workspaceSections}
        workspaceSectionExpanded={core.workspaceSectionExpanded}
        toggleWorkspaceSection={core.toggleWorkspaceSection}
        assetFsTick={assetFsTick}
        onOpenProjectAsset={onOpenProjectAsset}
        prefixNoteTitleWithType={prefixNoteTitleWithType}
        currentNoteId={core.currentNoteId}
        collapsedIds={core.collapsedIds}
        draggingId={core.draggingId}
        draggingBulkCount={core.draggingBulkCount}
        dropHint={core.dropHint}
        setDropHint={core.setDropHint}
        hasChildrenMap={core.hasChildrenMap}
        draggingRef={core.draggingRef}
        draggingIdsRef={core.draggingIdsRef}
        setDraggingId={core.setDraggingId}
        setDraggingBulkCount={core.setDraggingBulkCount}
        placementFromPointer={core.placementFromPointer}
        dropAllowedOne={core.dropAllowedOne}
        dropAllowedMany={core.dropAllowedMany}
        idsToDragForRow={core.idsToDragForRow}
        onMoveNote={onMoveNote}
        onMoveNotesBulk={onMoveNotesBulk}
        handleRowClick={core.handleRowClick}
        onNoteSelect={onNoteSelect}
        getTypeBadgeClass={core.getTypeBadgeClass}
        toggleCollapsed={core.toggleCollapsed}
        padForSectionNote={core.padForSectionNote}
        clipboard={core.clipboard}
        registeredTypes={registeredTypes}
        workspaceRoots={workspaceRoots}
        onCreateNote={onCreateNote}
      />
    </div>
  );
};

export default NotesSidebarPanel;
