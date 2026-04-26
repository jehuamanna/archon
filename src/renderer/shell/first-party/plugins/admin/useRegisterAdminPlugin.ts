import { useEffect } from "react";
import type { ResourceVisibility } from "../../../../auth/auth-client";
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

function coerceVisibility(v: unknown): ResourceVisibility {
  if (v === "public" || v === "private" || v === "shared") return v;
  return "public";
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asNullableString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

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

    disposers.push(
      contrib.registerCommand({
        id: ADMIN_CMD_OPEN_WORKSPACE_SHARES,
        title: "Admin: Open workspace shares",
        category: "Admin",
        sourcePluginId: ADMIN_PLUGIN_ID,
        doc: "Opens the Admin plugin focused on a workspace's shares panel.",
        api: {
          summary: "Open Admin → Workspace shares.",
          args: [
            { name: "workspaceId", type: "string", required: true },
            { name: "spaceId", type: "string | null" },
            { name: "initialVisibility", type: "'public'|'private'|'shared'" },
            { name: "workspaceName", type: "string" },
            { name: "creatorUserId", type: "string | null" },
          ],
          exampleInvoke: {
            workspaceId: "ws_…",
            spaceId: "sp_…",
            initialVisibility: "public",
          },
          returns: { type: "void", description: "Activates the admin tab and selects the workspace." },
        },
        handler: (args) => {
          const workspaceId = asString(args?.workspaceId);
          if (!workspaceId) return;
          adminSelectionStore.setSelection({
            kind: "workspace-shares",
            workspaceId,
            spaceId: asNullableString(args?.spaceId),
            initialVisibility: coerceVisibility(args?.initialVisibility),
            workspaceName: asString(args?.workspaceName),
            creatorUserId: asNullableString(args?.creatorUserId),
          });
          adminSelectionStore.setCompanionFocus({ kind: "none" });
          openAdminTab();
        },
      }),
    );

    disposers.push(
      contrib.registerCommand({
        id: ADMIN_CMD_OPEN_PROJECT_SHARES,
        title: "Admin: Open project shares",
        category: "Admin",
        sourcePluginId: ADMIN_PLUGIN_ID,
        doc: "Opens the Admin plugin focused on a project's shares panel.",
        api: {
          summary: "Open Admin → Project shares.",
          args: [
            { name: "projectId", type: "string", required: true },
            { name: "spaceId", type: "string | null" },
            { name: "initialVisibility", type: "'public'|'private'|'shared'" },
            { name: "projectName", type: "string" },
            { name: "creatorUserId", type: "string | null" },
          ],
          exampleInvoke: {
            projectId: "pr_…",
            spaceId: "sp_…",
            initialVisibility: "public",
          },
          returns: { type: "void", description: "Activates the admin tab and selects the project." },
        },
        handler: (args) => {
          const projectId = asString(args?.projectId);
          if (!projectId) return;
          adminSelectionStore.setSelection({
            kind: "project-shares",
            projectId,
            spaceId: asNullableString(args?.spaceId),
            initialVisibility: coerceVisibility(args?.initialVisibility),
            projectName: asString(args?.projectName),
            creatorUserId: asNullableString(args?.creatorUserId),
          });
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
