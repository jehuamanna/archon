import { useEffect } from "react";
import { useArchonContributionRegistry } from "../../../ArchonContributionContext";
import { useShellLayoutStore } from "../../../layout/ShellLayoutContext";
import { useShellRegistries } from "../../../registries/ShellRegistriesContext";
import { useShellViewRegistry } from "../../../views/ShellViewContext";
import { NotificationsBadge } from "./NotificationsBadge";
import { NotificationsMainView } from "./NotificationsMainView";
import { NotificationsSidebarView } from "./NotificationsSidebarView";
import {
  NOTIFICATIONS_CMD_OPEN,
  NOTIFICATIONS_PLUGIN_ID,
  NOTIFICATIONS_TAB,
  NOTIFICATIONS_TAB_REUSE_KEY,
  NOTIFICATIONS_VIEW_MAIN,
  NOTIFICATIONS_VIEW_SIDEBAR,
} from "./notificationsConstants";

/**
 * Register the Notifications plugin. Visible to every signed-in user (no role
 * gating). Badge count on the rail reflects unread notifications.
 */
export function useRegisterNotificationsPlugin(): void {
  const regs = useShellRegistries();
  const views = useShellViewRegistry();
  const layout = useShellLayoutStore();
  const contrib = useArchonContributionRegistry();

  useEffect(() => {
    const disposers: Array<() => void> = [];

    disposers.push(
      views.registerView({
        id: NOTIFICATIONS_VIEW_SIDEBAR,
        title: "Notifications",
        defaultRegion: "primarySidebar",
        component: NotificationsSidebarView,
        capabilities: { allowedCommands: "allShellCommands", readContext: true },
      }),
      views.registerView({
        id: NOTIFICATIONS_VIEW_MAIN,
        title: "Notifications",
        defaultRegion: "mainArea",
        component: NotificationsMainView,
        capabilities: { allowedCommands: "allShellCommands", readContext: true },
      }),
    );

    disposers.push(
      regs.tabs.registerTabType({
        id: NOTIFICATIONS_TAB,
        title: "Notifications",
        order: 40,
        viewId: NOTIFICATIONS_VIEW_MAIN,
        primarySidebarViewId: NOTIFICATIONS_VIEW_SIDEBAR,
      }),
    );

    disposers.push(
      regs.menuRail.registerItem({
        id: "plugin.notifications.rail",
        title: "Notifications",
        icon: "\u{1F514}",
        order: 40,
        tabTypeId: NOTIFICATIONS_TAB,
        tabReuseKey: NOTIFICATIONS_TAB_REUSE_KEY,
        sidebarViewId: NOTIFICATIONS_VIEW_SIDEBAR,
        BadgeOverlay: NotificationsBadge,
      }),
    );

    const openNotificationsTab = (): void => {
      regs.tabs.openOrReuseTab(NOTIFICATIONS_TAB, {
        title: "Notifications",
        reuseKey: NOTIFICATIONS_TAB_REUSE_KEY,
      });
      layout.setVisible("menuRail", true);
      layout.setVisible("sidebarPanel", true);
    };

    disposers.push(
      contrib.registerCommand({
        id: NOTIFICATIONS_CMD_OPEN,
        title: "Notifications: Open",
        category: "Notifications",
        sourcePluginId: NOTIFICATIONS_PLUGIN_ID,
        doc: "Open the Notifications plugin (sidebar list + main panel).",
        api: {
          summary: "Open the Notifications panel.",
          args: [],
          exampleInvoke: {},
          returns: { type: "void", description: "Activates the notifications tab." },
        },
        handler: () => {
          openNotificationsTab();
        },
      }),
    );

    return () => {
      for (const d of disposers) d();
    };
  }, [contrib, layout, regs, views]);
}
