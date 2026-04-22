import { useCallback, useMemo } from "react";
import { useArchonContributionRegistry } from "./ArchonContributionContext";
import { useShellLayoutStore } from "./layout/ShellLayoutContext";
import { useShellRegistries } from "./registries/ShellRegistriesContext";
import { useShellViewRegistry } from "./views/ShellViewContext";
import { openNoteInShell, type OpenNoteInShellOptions } from "./openNoteInShell";
import { runShellMenuRailAction, type ShellNavigationDeps } from "./shellRailNavigation";
import type { ShellMenuRailItem } from "./registries/ShellMenuRailRegistry";

export function useShellNavigation(): {
  deps: ShellNavigationDeps;
  openFromRailItem: (item: ShellMenuRailItem) => void;
  openNoteById: (noteId: string, opts?: OpenNoteInShellOptions) => void;
  invokeCommand: (commandId: string, args?: Record<string, unknown>) => unknown;
} {
  const regs = useShellRegistries();
  const views = useShellViewRegistry();
  const layout = useShellLayoutStore();
  const contrib = useArchonContributionRegistry();

  const deps = useMemo<ShellNavigationDeps>(
    () => ({ tabs: regs.tabs, views, layout, menuRail: regs.menuRail }),
    [regs.tabs, views, layout, regs.menuRail],
  );

  const invokeCommand = useCallback(
    (commandId: string, args?: Record<string, unknown>) =>
      contrib.invokeCommand(commandId, args),
    [contrib],
  );

  const openFromRailItem = useCallback(
    (item: ShellMenuRailItem) => {
      runShellMenuRailAction(item, deps, invokeCommand);
    },
    [deps, invokeCommand],
  );

  const openNoteById = useCallback(
    (noteId: string, opts?: OpenNoteInShellOptions) => {
      openNoteInShell(noteId, deps, opts);
    },
    [deps],
  );

  return { deps, openFromRailItem, openNoteById, invokeCommand };
}
