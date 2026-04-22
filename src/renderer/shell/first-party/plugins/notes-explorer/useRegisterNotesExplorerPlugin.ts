import { useEffect } from "react";
import { useArchonContributionRegistry } from "../../../ArchonContributionContext";
import { useShellLayoutStore } from "../../../layout/ShellLayoutContext";
import { useShellRegistries } from "../../../registries/ShellRegistriesContext";
import { useShellViewRegistry } from "../../../views/ShellViewContext";
import {
  NOTES_EXPLORER_TAB,
  NOTES_EXPLORER_VIEW_MAIN,
  NOTES_EXPLORER_VIEW_SIDEBAR,
} from "../../shellWorkspaceIds";
import { NotesExplorerMainShellView } from "./NotesExplorerMainShellView";
import { NotesExplorerPanelView } from "./NotesExplorerPanelView";

export const NOTES_EXPLORER_PLUGIN_ID = "plugin.notes-explorer";

export function useRegisterNotesExplorerPlugin(): void {
  const regs = useShellRegistries();
  const views = useShellViewRegistry();
  const layout = useShellLayoutStore();
  const contrib = useArchonContributionRegistry();

  useEffect(() => {
    const disposers: Array<() => void> = [];

    disposers.push(
      views.registerView({
        id: NOTES_EXPLORER_VIEW_SIDEBAR,
        title: "Notes — explorer",
        defaultRegion: "primarySidebar",
        component: NotesExplorerPanelView,
        capabilities: { allowedCommands: "allShellCommands", readContext: true },
      }),
      views.registerView({
        id: NOTES_EXPLORER_VIEW_MAIN,
        title: "Notes",
        defaultRegion: "mainArea",
        component: NotesExplorerMainShellView,
        capabilities: { allowedCommands: "allShellCommands", readContext: true },
      }),
    );

    disposers.push(
      regs.tabs.registerTabType({
        id: NOTES_EXPLORER_TAB,
        title: "Notes",
        order: 15,
        viewId: NOTES_EXPLORER_VIEW_MAIN,
        primarySidebarViewId: NOTES_EXPLORER_VIEW_SIDEBAR,
      }),
    );

    disposers.push(
      regs.menuRail.registerItem({
        id: "plugin.notes-explorer.rail",
        title: "Notes",
        icon: "≡",
        order: 15,
        tabTypeId: NOTES_EXPLORER_TAB,
        tabReuseKey: "plugin.notes-explorer",
        sidebarViewId: NOTES_EXPLORER_VIEW_SIDEBAR,
      }),
    );

    disposers.push(
      contrib.registerCommand({
        id: "archon.notesExplorer.open",
        title: "Notes: Open explorer",
        category: "Notes",
        sourcePluginId: NOTES_EXPLORER_PLUGIN_ID,
        doc: "Opens the notes tree in the sidebar and the Notes hub in the main area.",
        api: {
          summary: "Open Notes Explorer (sidebar tree + main hub).",
          args: [],
          exampleInvoke: {},
          returns: { type: "void", description: "Updates shell tabs and views." },
        },
        handler: () => {
          regs.tabs.openOrReuseTab(NOTES_EXPLORER_TAB, {
            title: "Notes",
            reuseKey: "plugin.notes-explorer",
          });
          layout.setVisible("menuRail", true);
        },
      }),
    );

    return () => {
      for (const d of disposers) d();
    };
  }, [contrib, layout, regs, views]);
}
