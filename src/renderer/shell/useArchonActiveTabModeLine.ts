import { useEffect, useState } from "react";
import { useArchonContributionRegistry } from "./ArchonContributionContext";
import { useShellRegistries } from "./registries/ShellRegistriesContext";
import type { ShellTabsRegistry } from "./registries/ShellTabsRegistry";

/**
 * Pumps the active shell tab's label into `host.left` of the mode line so
 * every view gets a base context segment (Welcome, Pitch Deck, Notes
 * Explorer, …) without each view having to wire its own contribution.
 * Per-note contributions in `NoteViewer` continue to populate `host.center`
 * and `host.right` on top of this.
 */
export function useArchonActiveTabModeLine(): void {
  const contrib = useArchonContributionRegistry();
  const registries = useShellRegistries();
  const tabs = registries.tabs;
  const [label, setLabel] = useState<string>(() => readActiveTabLabel(tabs));

  useEffect(() => {
    const update = (): void => setLabel(readActiveTabLabel(tabs));
    update();
    return tabs.subscribe(update);
  }, [tabs]);

  useEffect(() => {
    if (!label) return;
    return contrib.registerModeLineItem({
      id: "archon.host.activeTab",
      segment: "host.left",
      priority: 100,
      text: label,
      sourcePluginId: "archon.host",
    });
  }, [contrib, label]);
}

function readActiveTabLabel(tabs: ShellTabsRegistry): string {
  const active = tabs.getActiveTab();
  if (!active) return "";
  const overrideTitle =
    typeof active.title === "string" ? active.title.trim() : "";
  if (overrideTitle) return overrideTitle;
  const type = tabs.getTabType(active.tabTypeId);
  return type?.title ?? "";
}
