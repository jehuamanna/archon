import {
  applyDocumentationDeepLinkToTab,
} from "./first-party/plugins/documentation/documentationShellHash";
import { SHELL_TAB_WELCOME_TYPE_ID } from "./first-party/shellWorkspaceIds";
import type { ShellMenuRailItem, ShellMenuRailRegistry } from "./registries/ShellMenuRailRegistry";
import type { ShellTabsRegistry } from "./registries/ShellTabsRegistry";
import {
  WELCOME_SHELL_URL_COMMANDS,
  type ShellWelcomeTabState,
  type WelcomeShellUrlSegment,
} from "./shellWelcomeUrlRoutes";
import { parseEphemeralShellTabInstanceId } from "./shellTabInstanceParse";
import type { ShellViewRegistry } from "./views/ShellViewRegistry";
import type { ShellLayoutStore } from "./layout/ShellLayoutStore";

export type ShellNavigationDeps = {
  tabs: ShellTabsRegistry;
  views: ShellViewRegistry;
  layout: ShellLayoutStore;
  menuRail: ShellMenuRailRegistry;
};

/**
 * Single implementation for menu rail clicks (and mirrors command handlers where needed).
 */
export function runShellMenuRailAction(
  item: ShellMenuRailItem,
  deps: ShellNavigationDeps,
  invokeCommand: (commandId: string, args?: Record<string, unknown>) => unknown,
): void {
  if (item.commandId) {
    void Promise.resolve(invokeCommand(item.commandId, item.commandArgs));
    return;
  }
  if (item.tabTypeId) {
    const inst = deps.tabs.openOrReuseTab(item.tabTypeId, {
      title: item.title,
      reuseKey: item.tabReuseKey ?? `rail:${item.id}`,
    });
    const mainViewId = deps.tabs.resolveViewForInstance(inst.instanceId);
    if (mainViewId) {
      deps.views.openView(mainViewId, "mainArea");
    }
    const ex = item.expandChrome;
    if (ex?.menuRail) deps.layout.setVisible("menuRail", true);
    if (ex?.sidebarPanel) deps.layout.setVisible("sidebarPanel", true);
    if (ex?.companion) deps.layout.setVisible("companion", true);
    if (item.sidebarViewId) {
      deps.views.openView(item.sidebarViewId, "primarySidebar");
      deps.layout.setVisible("menuRail", true);
      deps.layout.setVisible("sidebarPanel", true);
    }
    if (item.secondaryViewId) {
      deps.views.openView(item.secondaryViewId, "companion");
      deps.layout.setVisible("companion", true);
    }
    const cx = item.collapseChrome;
    if (cx?.sidebarPanel) deps.layout.setVisible("sidebarPanel", false);
    if (cx?.companion) deps.layout.setVisible("companion", false);
    return;
  }
  if (item.openViewId) {
    deps.views.openView(item.openViewId, item.openViewRegion ?? "primarySidebar");
    deps.layout.setVisible("menuRail", true);
    deps.layout.setVisible("sidebarPanel", true);
  }
}

/**
 * Focus or open a tab type from a URL hash (exact instance id, ephemeral id, or bare `tabTypeId`).
 * Uses the menu rail item when present so `reuseKey` and sidebar/companion match a rail click.
 */
/**
 * Apply `#/welcome` or `#/welcome/<segment>`: focus welcome tab, optionally run the mapped command.
 * Keeps `#/welcome/notes-explorer` in sync when that command leaves the welcome tab active.
 */
export function applyShellWelcomeHash(
  segment: "" | WelcomeShellUrlSegment,
  deps: ShellNavigationDeps,
  invokeCommand: (commandId: string, args?: Record<string, unknown>) => unknown,
): void {
  const inst = deps.tabs.openOrReuseTab(SHELL_TAB_WELCOME_TYPE_ID, {
    title: "Welcome",
    reuseKey: "shell:welcome",
  });
  const prev = (inst.state ?? {}) as ShellWelcomeTabState & Record<string, unknown>;
  const next: ShellWelcomeTabState & Record<string, unknown> = { ...prev };
  if (segment === "notes-explorer") {
    next.welcomeHashSegment = "notes-explorer";
  } else {
    delete next.welcomeHashSegment;
  }
  deps.tabs.updateTabPresentation(inst.instanceId, { state: next });
  deps.tabs.setActiveTab(inst.instanceId);
  const mainViewId = deps.tabs.resolveViewForInstance(inst.instanceId);
  if (mainViewId) {
    deps.views.openView(mainViewId, "mainArea");
  }
  if (!segment) return;
  const commandId = WELCOME_SHELL_URL_COMMANDS[segment];
  void Promise.resolve(invokeCommand(commandId)).catch((err: unknown) => {
    console.error("[applyShellWelcomeHash] command failed:", commandId, err);
  });
}

export function openShellTabTypeForDeepLink(
  tabTypeId: string,
  deps: ShellNavigationDeps,
  invokeCommand: (commandId: string, args?: Record<string, unknown>) => unknown,
): boolean {
  const type = deps.tabs.getTabType(tabTypeId);
  if (!type) return false;
  const item = deps.menuRail.list().find((i) => i.tabTypeId === tabTypeId);
  if (item?.tabTypeId) {
    runShellMenuRailAction(item, deps, invokeCommand);
    return true;
  }
  const inst = deps.tabs.openOrReuseTab(tabTypeId, {
    title: type.title,
    reuseKey: `deeplink:${tabTypeId}`,
  });
  const mainViewId = deps.tabs.resolveViewForInstance(inst.instanceId);
  if (mainViewId) {
    deps.views.openView(mainViewId, "mainArea");
  }
  return true;
}

/**
 * Apply `#/t/<instanceOrType>` after navigation: existing instance, ephemeral id from a shared link, or bare `tabTypeId`.
 * Optional `documentationSegments` are the path after the tab id (Documentation hub: `h`, `c/…`, `n/…`).
 */
export function applyShellTabFromUrlHash(
  instanceIdFromHash: string,
  deps: ShellNavigationDeps,
  invokeCommand: (commandId: string, args?: Record<string, unknown>) => unknown,
  documentationSegments: string[],
): boolean {
  const tabs = deps.tabs;
  const trimmed = instanceIdFromHash.trim();
  if (!trimmed) return false;

  const existing = tabs.listOpenTabs().find((i) => i.instanceId === trimmed);
  if (existing) {
    tabs.setActiveTab(existing.instanceId);
    applyDocumentationDeepLinkToTab(tabs, existing.instanceId, documentationSegments);
    return true;
  }

  const fromEphemeral = parseEphemeralShellTabInstanceId(trimmed);
  let tabTypeId: string | null = null;
  if (fromEphemeral && tabs.getTabType(fromEphemeral)) {
    tabTypeId = fromEphemeral;
  } else if (tabs.getTabType(trimmed)) {
    tabTypeId = trimmed;
  }
  if (!tabTypeId) return false;
  const opened = openShellTabTypeForDeepLink(tabTypeId, deps, invokeCommand);
  if (!opened) return false;
  const active = tabs.getActiveTab();
  if (active) {
    applyDocumentationDeepLinkToTab(tabs, active.instanceId, documentationSegments);
  }
  return true;
}
