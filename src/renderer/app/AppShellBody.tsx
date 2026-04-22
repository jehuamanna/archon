import React from "react";
import NotesSidebarPanel from "../components/NotesSidebarPanel";
import PluginsSidebarList, {
  type PluginsSidebarSelection,
} from "../components/shell/PluginsSidebarList";
import EditorTabSidebar from "../components/shell/EditorTabSidebar";
import type { SettingsCategory } from "../components/SettingsView";
import type { PrimaryTab } from "../components/shell/PrimarySidebarShell";
import type {
  CreateNoteRelation,
  NoteListItem,
  NoteMovePlacement,
  PasteSubtreePayload,
} from "@archon/ui-types";
export type AppShellBodyProps = {
  primaryTab: PrimaryTab;
  projectRoot: string | null | undefined;
  notesList: NoteListItem[];
  registeredTypes: string[];
  currentNoteId: string | undefined;
  rootsList: string[];
  workspaceLabels: Record<string, string>;
  assetFsTick: number;
  settingsCategory: SettingsCategory;
  setSettingsCategory: (c: SettingsCategory) => void;
  pluginsShell: PluginsSidebarSelection;
  setPluginsShell: React.Dispatch<React.SetStateAction<PluginsSidebarSelection>>;
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
  onPasteSubtree: (p: PasteSubtreePayload) => Promise<void>;
  onAddWorkspaceFolder: () => void;
  onRevealProjectFolder: (id: string) => void;
  onRefreshWorkspace: () => void;
  /** Reload notes list + current note from main (e.g. after DnD detects stale ids). */
  onResyncNotes: () => void;
  onSwapWorkspaceBlock: (payload: {
    blockIndex: number;
    direction: "up" | "down";
  }) => Promise<void>;
  onCommitWorkspaceFolderLabel: (
    rootPath: string,
    label: string | null,
  ) => Promise<void>;
  onOpenProjectFolder: () => void;
  onOpenProjectAsset: (
    projectRoot: string,
    relativePath: string,
  ) => void;
};

const settingsNavBtn = (
  cat: SettingsCategory,
  label: string,
  settingsCategory: SettingsCategory,
  setSettingsCategory: (c: SettingsCategory) => void,
) => {
  const active = settingsCategory === cat;
  return (
    <button
      key={cat}
      type="button"
      className={`w-full border-sidebar-border border-b px-3 py-2.5 text-left text-[12px] transition-colors ${
        active
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-sidebar-foreground/85 hover:bg-sidebar-accent/40"
      }`}
      onClick={() => setSettingsCategory(cat)}
    >
      {label}
    </button>
  );
};

export function AppShellBody(props: AppShellBodyProps): React.ReactNode {
  const {
    primaryTab,
    projectRoot,
    notesList,
    registeredTypes,
    currentNoteId,
    rootsList,
    workspaceLabels,
    assetFsTick,
    settingsCategory,
    setSettingsCategory,
    pluginsShell,
    setPluginsShell,
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
    onSwapWorkspaceBlock,
    onCommitWorkspaceFolderLabel,
    onOpenProjectFolder,
    onOpenProjectAsset,
  } = props;

  if (primaryTab === "notes") {
    if (projectRoot === undefined) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center p-3">
          <div className="text-[11px] text-muted-foreground">Loading…</div>
        </div>
      );
    }
    if (!projectRoot) {
      return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          <p className="text-[12px] leading-snug text-muted-foreground">
            Open a project folder to load notes (
            <span className="font-mono text-[11px]">data/archon-workspace.json</span>)
            and browse files under{" "}
            <span className="font-mono text-[11px]">assets/</span>.
          </p>
          <button
            type="button"
            className="rounded-md border border-border bg-background px-3 py-2 text-left text-[12px] font-medium hover:bg-muted/60"
            onClick={() => void onOpenProjectFolder()}
          >
            Open project…
          </button>
        </div>
      );
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden">
          <NotesSidebarPanel
            notes={notesList}
            registeredTypes={registeredTypes}
            currentNoteId={currentNoteId}
            onNoteSelect={onNoteSelect}
            onCreateNote={onCreateNote}
            onRenameNote={onRenameNote}
            onMoveNote={onMoveNote}
            onMoveNotesBulk={onMoveNotesBulk}
            onDeleteNotes={onDeleteNotes}
            onPasteSubtree={onPasteSubtree}
            onAddWorkspaceFolder={onAddWorkspaceFolder}
            onRevealProjectFolder={onRevealProjectFolder}
            onRefreshWorkspace={onRefreshWorkspace}
            onResyncNotes={onResyncNotes}
            workspaceRoots={rootsList}
            workspaceLabels={workspaceLabels}
            onSwapWorkspaceBlock={onSwapWorkspaceBlock}
            onCommitWorkspaceFolderLabel={onCommitWorkspaceFolderLabel}
            onOpenProjectAsset={onOpenProjectAsset}
            assetFsTick={assetFsTick}
          />
        </div>
      </div>
    );
  }
  if (primaryTab === "editor") {
    return (
      <div className="min-h-0 flex-1 overflow-hidden">
        <EditorTabSidebar />
      </div>
    );
  }
  if (primaryTab === "settings") {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {settingsNavBtn("appearance", "Appearance", settingsCategory, setSettingsCategory)}
        {settingsNavBtn("debug", "Debug", settingsCategory, setSettingsCategory)}
        {settingsNavBtn(
          "keyboard",
          "Keyboard shortcuts",
          settingsCategory,
          setSettingsCategory,
        )}
      </div>
    );
  }
  return (
    <PluginsSidebarList
      selection={pluginsShell}
      onSelectGeneral={() => setPluginsShell({ kind: "general" })}
      onSelectMarket={() => setPluginsShell({ kind: "market" })}
      onSelectPlugin={(id) => setPluginsShell({ kind: "plugin", id })}
    />
  );
}
