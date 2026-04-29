import { useEffect } from "react";
import { useArchonContributionRegistry } from "../../../ArchonContributionContext";
import { useShellLayoutStore } from "../../../layout/ShellLayoutContext";
import { useShellRegistries } from "../../../registries/ShellRegistriesContext";
import { useShellViewRegistry } from "../../../views/ShellViewContext";
import { AdminCompanionView } from "./AdminCompanionView";
import { AdminMainView } from "./AdminMainView";
import { AdminSidebarView } from "./AdminSidebarView";
import {
  ADMIN_CMD_OPEN,
  ADMIN_CMD_OPEN_PROJECT_SHARES,
  ADMIN_CMD_OPEN_WORKSPACE_SHARES,
  ADMIN_PLUGIN_ID,
  ADMIN_TAB,
  ADMIN_TAB_REUSE_KEY,
  ADMIN_VIEW_COMPANION,
  ADMIN_VIEW_MAIN,
  ADMIN_VIEW_SIDEBAR,
} from "./adminConstants";
import { adminSelectionStore } from "./adminSelectionStore";

export function useRegisterAdminPlugin(): void {
  const regs = useShellRegistries();
  const views = useShellViewRegistry();
  const layout = useShellLayoutStore();
  const contrib = useArchonContributionRegistry();

  useEffect(() => {
    const disposers: Array<() => void> = [];

    disposers.push(
      views.registerView({
        id: ADMIN_VIEW_SIDEBAR,
        title: "Admin — navigation",
        defaultRegion: "primarySidebar",
        component: AdminSidebarView,
        capabilities: { allowedCommands: "allShellCommands", readContext: true },
      }),
      views.registerView({
        id: ADMIN_VIEW_MAIN,
        title: "Admin",
        defaultRegion: "mainArea",
        component: AdminMainView,
        capabilities: { allowedCommands: "allShellCommands", readContext: true },
      }),
      views.registerView({
        id: ADMIN_VIEW_COMPANION,
        title: "Admin — details",
        defaultRegion: "companion",
        component: AdminCompanionView,
        capabilities: { allowedCommands: "allShellCommands", readContext: true },
      }),
    );

    disposers.push(
      regs.tabs.registerTabType({
        id: ADMIN_TAB,
        title: "Admin",
        order: 30,
        viewId: ADMIN_VIEW_MAIN,
        primarySidebarViewId: ADMIN_VIEW_SIDEBAR,
        secondaryViewId: ADMIN_VIEW_COMPANION,
      }),
    );

    disposers.push(
      regs.menuRail.registerItem({
        id: "plugin.admin.rail",
        title: "Admin",
        icon: "⚙",
        order: 30,
        placement: "bottom",
        tabTypeId: ADMIN_TAB,
        tabReuseKey: ADMIN_TAB_REUSE_KEY,
        sidebarViewId: ADMIN_VIEW_SIDEBAR,
        secondaryViewId: ADMIN_VIEW_COMPANION,
      }),
    );

    const openAdminTab = (): void => {
      regs.tabs.openOrReuseTab(ADMIN_TAB, {
        title: "Admin",
        reuseKey: ADMIN_TAB_REUSE_KEY,
      });
      layout.setVisible("menuRail", true);
      layout.setVisible("sidebarPanel", true);
    };

    disposers.push(
      contrib.registerCommand({
        id: ADMIN_CMD_OPEN,
        title: "Admin: Open console",
        category: "Admin",
        sourcePluginId: ADMIN_PLUGIN_ID,
        doc: "Opens the Admin plugin (sidebar tree + main panel + companion details).",
        api: {
          summary: "Open the Admin console.",
          args: [],
          exampleInvoke: {},
          returns: { type: "void", description: "Activates the admin tab." },
        },
        handler: () => {
          openAdminTab();
        },
      }),
    );

    // Pre-migration deep-link commands that opened workspace-share /
    // project-share panels. Spaces + workspaces were dropped with the
    // org/team migration and project access flows through `team_projects`
    // grants, managed inline in `TeamsPanel`. Both commands now redirect
    // to the org-level Teams view so the explorer's "Manage shares"
    // affordances continue to land somewhere sensible while the explorer
    // is itself ported (slice 5). The id constants are still exported so
    // the WpnExplorerPanelView call sites compile until they're removed.
    disposers.push(
      contrib.registerCommand({
        id: ADMIN_CMD_OPEN_WORKSPACE_SHARES,
        title: "Admin: Open workspace shares (redirected)",
        category: "Admin",
        sourcePluginId: ADMIN_PLUGIN_ID,
        doc: "Vestigial — redirects to the Teams panel. Workspace shares no longer exist; project access is managed via team_projects grants.",
        api: {
          summary: "Redirects to Admin → Teams.",
          args: [],
          exampleInvoke: {},
          returns: { type: "void", description: "Activates the Teams admin view." },
        },
        handler: () => {
          adminSelectionStore.setSelection({ kind: "org-teams" });
          adminSelectionStore.setCompanionFocus({ kind: "none" });
          openAdminTab();
        },
      }),
    );

    disposers.push(
      contrib.registerCommand({
        id: ADMIN_CMD_OPEN_PROJECT_SHARES,
        title: "Admin: Open project shares (redirected)",
        category: "Admin",
        sourcePluginId: ADMIN_PLUGIN_ID,
        doc: "Vestigial — redirects to the Teams panel. Project access is managed via team_projects grants under each team.",
        api: {
          summary: "Redirects to Admin → Teams.",
          args: [],
          exampleInvoke: {},
          returns: { type: "void", description: "Activates the Teams admin view." },
        },
        handler: () => {
          adminSelectionStore.setSelection({ kind: "org-teams" });
          adminSelectionStore.setCompanionFocus({ kind: "none" });
          openAdminTab();
        },
      }),
    );

    return () => {
      for (const d of disposers) d();
    };
  }, [contrib, layout, regs, views]);
}
