import React from "react";
import type { Note } from "@archon/ui-types";
import NoteViewer from "../components/NoteViewer";
import AssetPreview from "../components/AssetPreview";
import PluginManager from "../components/PluginManager";
import PluginIDE from "../components/PluginIDE";
import SettingsView, {
  type SettingsCategory,
} from "../components/SettingsView";
import PluginPanelGeneral from "../components/PluginPanelGeneral";
import PluginPanelMarketplace from "../components/PluginPanelMarketplace";
import type { PrimaryTab } from "../components/shell/PrimarySidebarShell";
import type { PluginsSidebarSelection } from "../components/shell/PluginsSidebarList";
import type { NotesMainPane } from "./app-shell-types";

export type AppShellMainColumnProps = {
  primaryTab: PrimaryTab;
  projectRoot: string | null | undefined;
  notesMainPane: NotesMainPane;
  detailLoading: boolean;
  currentNote: Note | null;
  assetProjectRootForNote: string | null;
  /** First workspace folder for Plugin IDE preview `archon-asset` URLs (`?root=`). */
  idePreviewAssetProjectRoot: string | null;
  settingsCategory: SettingsCategory;
  pluginsShell: PluginsSidebarSelection;
  onOpenProjectFolder: () => void;
  onRenameNote: (id: string, title: string) => void | Promise<void>;
  onPluginsChanged: () => void;
};

export function AppShellMainColumn(props: AppShellMainColumnProps): React.ReactNode {
  const {
    primaryTab,
    projectRoot,
    notesMainPane,
    detailLoading,
    currentNote,
    assetProjectRootForNote,
    idePreviewAssetProjectRoot,
    settingsCategory,
    pluginsShell,
    onOpenProjectFolder,
    onRenameNote,
    onPluginsChanged,
  } = props;

  if (primaryTab === "notes") {
    if (projectRoot === undefined) {
      return (
        <div className="flex h-full items-center justify-center p-8">
          <div className="text-[12px] text-muted-foreground">Loading…</div>
        </div>
      );
    }
    if (!projectRoot) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
          <p className="max-w-md text-center text-[13px] text-muted-foreground">
            Choose a folder for this workspace. Notes and workspace state live under{" "}
            <span className="font-mono text-[12px]">data/</span> (JSON); put
            attachments and other files in{" "}
            <span className="font-mono text-[12px]">assets/</span>.
          </p>
          <button
            type="button"
            className="rounded-md border border-border bg-background px-4 py-2 text-[13px] font-medium hover:bg-muted/60"
            onClick={() => void onOpenProjectFolder()}
          >
            Open project…
          </button>
        </div>
      );
    }
    if (notesMainPane.kind === "asset") {
      return (
        <AssetPreview
          relativePath={notesMainPane.relativePath}
          projectRoot={notesMainPane.projectRoot}
        />
      );
    }
    if (detailLoading && !currentNote) {
      return (
        <div className="flex h-full items-center justify-center p-8">
          <div className="text-[12px] text-muted-foreground">Loading…</div>
        </div>
      );
    }
    if (currentNote) {
      return (
        <NoteViewer
          note={currentNote}
          assetProjectRoot={assetProjectRootForNote}
          onTitleCommit={(title) => onRenameNote(currentNote.id, title)}
        />
      );
    }
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-[12px] text-muted-foreground">
          No note selected
        </div>
      </div>
    );
  }
  if (primaryTab === "editor") {
    return (
      <PluginIDE
        shellLayout
        onPluginsChanged={onPluginsChanged}
        previewAssetProjectRoot={idePreviewAssetProjectRoot}
      />
    );
  }
  if (primaryTab === "settings") {
    return <SettingsView category={settingsCategory} />;
  }
  if (pluginsShell.kind === "general") {
    return <PluginPanelGeneral onPluginsChanged={onPluginsChanged} />;
  }
  if (pluginsShell.kind === "market") {
    return <PluginPanelMarketplace onPluginsChanged={onPluginsChanged} />;
  }
  return (
    <PluginManager
      onPluginsChanged={onPluginsChanged}
      selectedPluginId={pluginsShell.id}
    />
  );
}
