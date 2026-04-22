import type { ArchonContributionRegistry } from "./archon-contribution-registry";
import type { ShellLayoutStore } from "./layout/ShellLayoutStore";
import type { ShellRegionId } from "./layout/ShellLayoutState";
import type { ShellViewRegistry } from "./views/ShellViewRegistry";
import type { ShellRegistries } from "./registries/ShellRegistriesContext";
import type { ShellKeyBinding } from "./registries/ShellKeymapRegistry";

/** Same object assigned to `window.archon.shell` and injected as `archon.shell` in JS notebooks. */
export function buildArchonShellApi(opts: {
  registry: ArchonContributionRegistry;
  layout: ShellLayoutStore;
  views?: ShellViewRegistry;
  registries?: ShellRegistries;
}) {
  const { registry, layout } = opts;

  return {
    layout: {
      get: () => layout.get(),
      setVisible: (regionId: ShellRegionId, visible: boolean) =>
        layout.setVisible(regionId, Boolean(visible)),
      toggle: (regionId: ShellRegionId) => layout.toggle(regionId),
      apply: (patch: Partial<ReturnType<typeof layout.get>>) =>
        layout.patch((cur) => ({ ...cur, ...(patch as object) })),
    },
    commands: {
      list: () => registry.listCommands(),
      invoke: (commandId: string, args?: Record<string, unknown>) =>
        registry.invokeCommand(String(commandId), args),
    },
    views: opts.views
      ? {
          list: () => opts.views!.listViews(),
          register: (v: Parameters<ShellViewRegistry["registerView"]>[0]) =>
            opts.views!.registerView(v),
          open: (viewId: string, regionId?: Parameters<ShellViewRegistry["openView"]>[1]) =>
            opts.views!.openView(viewId, regionId),
          closeRegion: (regionId: Parameters<ShellViewRegistry["closeRegion"]>[0]) =>
            opts.views!.closeRegion(regionId),
        }
      : undefined,
    appMenu: opts.registries
      ? {
          list: () => opts.registries!.appMenu.list(),
          registerItems: (items: Parameters<ShellRegistries["appMenu"]["registerItems"]>[0]) =>
            opts.registries!.appMenu.registerItems(items),
        }
      : undefined,
    menuRail: opts.registries
      ? {
          list: () => opts.registries!.menuRail.list(),
          registerItem: (item: Parameters<ShellRegistries["menuRail"]["registerItem"]>[0]) =>
            opts.registries!.menuRail.registerItem(item),
        }
      : undefined,
    keymap: opts.registries
      ? {
          list: () => opts.registries!.keymap.list(),
          register: (b: ShellKeyBinding) => opts.registries!.keymap.register(b),
        }
      : undefined,
    panelMenu: opts.registries
      ? {
          listFor: (
            region: Parameters<ShellRegistries["panelMenu"]["listFor"]>[0],
            viewId?: Parameters<ShellRegistries["panelMenu"]["listFor"]>[1],
          ) => opts.registries!.panelMenu.listFor(region, viewId),
          registerItem: (item: Parameters<ShellRegistries["panelMenu"]["registerItem"]>[0]) =>
            opts.registries!.panelMenu.registerItem(item),
        }
      : undefined,
    tabs: opts.registries
      ? {
          listTypes: () => opts.registries!.tabs.listTabTypes(),
          registerType: (t: Parameters<ShellRegistries["tabs"]["registerTabType"]>[0]) =>
            opts.registries!.tabs.registerTabType(t),
          open: (tabTypeId: string, title?: string, state?: unknown, reuseKey?: string) =>
            opts.registries!.tabs.openTab(String(tabTypeId), title, state, reuseKey),
          openOrReuse: (
            tabTypeId: string,
            o?: { title?: string; state?: unknown; reuseKey?: string },
          ) => opts.registries!.tabs.openOrReuseTab(String(tabTypeId), o),
          reorder: (fromIndex: number, toIndex: number) =>
            opts.registries!.tabs.reorderTabs(fromIndex, toIndex),
          listOpen: () => opts.registries!.tabs.listOpenTabs(),
          getActive: () => opts.registries!.tabs.getActiveTab(),
          setActive: (instanceId: string) => opts.registries!.tabs.setActiveTab(String(instanceId)),
          close: (instanceId: string) => opts.registries!.tabs.closeTab(String(instanceId)),
        }
      : undefined,
  };
}

export type ArchonDevtoolsShellApi = ReturnType<typeof buildArchonShellApi>;

export function exposeDevtoolsShellApi(opts: {
  registry: ArchonContributionRegistry;
  layout: ShellLayoutStore;
  views?: ShellViewRegistry;
  registries?: ShellRegistries;
}): void {
  if (typeof window === "undefined") return;

  window.archon = window.archon ?? {};
  const shell = buildArchonShellApi(opts);
  window.archon.shell = shell;
  window.archon.devtools = shell;
}

