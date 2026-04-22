import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  ArchonContributionRegistry,
  type CommandContribution,
  type ModeLineContribution,
  type ModeLineSegmentId,
} from "./archon-contribution-registry";
import { ArchonContributionMenuBridge } from "./ArchonContributionMenuBridge";
import { registerArchonCoreContributions } from "./registerArchonCoreContributions";
import { useShellLayoutStore } from "./layout/ShellLayoutContext";
import { exposeDevtoolsShellApi } from "./devtoolsShellExpose";
import { useShellViewRegistry } from "./views/ShellViewContext";
import { ShellViewCommandContributions } from "./views/ShellViewCommandContributions";
import { useShellRegistries } from "./registries/ShellRegistriesContext";
import { postContextUpdateToFrames, type ShellContext } from "./views/shell-iframe-rpc";

const RegistryContext = createContext<ArchonContributionRegistry | null>(null);

export function ArchonContributionProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const registry = useMemo(() => new ArchonContributionRegistry(), []);
  const layoutStore = useShellLayoutStore();
  const viewRegistry = useShellViewRegistry();
  const registries = useShellRegistries();
  const lastCtxRef = React.useRef<ShellContext>({ primary: null });

  // Broadcast a minimal context snapshot (legacy hook for embeds; shell views are React).
  useEffect(() => {
    const unsub = registries.tabs.subscribe(() => {
      const a = registries.tabs.getActiveTab();
      const next: ShellContext = {
        primary: a
          ? {
              tabTypeId: a.tabTypeId,
              instanceId: a.instanceId,
              title: a.title,
            }
          : null,
      };
      lastCtxRef.current = next;
      postContextUpdateToFrames(next);
    });
    // Emit once on mount.
    const a = registries.tabs.getActiveTab();
    lastCtxRef.current = {
      primary: a
        ? { tabTypeId: a.tabTypeId, instanceId: a.instanceId, title: a.title }
        : null,
    };
    postContextUpdateToFrames(lastCtxRef.current);
    return unsub;
  }, [registries]);

  useEffect(() => {
    const disposers = registerArchonCoreContributions(registry, registries);
    return () => {
      for (const d of disposers) {
        d();
      }
    };
  }, [registry]);

  useLayoutEffect(() => {
    exposeDevtoolsShellApi({
      registry,
      layout: layoutStore,
      views: viewRegistry,
      registries,
    });
  }, [registry, layoutStore, viewRegistry, registries]);

  return (
    <RegistryContext.Provider value={registry}>
      {children}
      <ShellViewCommandContributions />
      <ArchonContributionMenuBridge />
    </RegistryContext.Provider>
  );
}

export function useArchonContributionRegistry(): ArchonContributionRegistry {
  const r = useContext(RegistryContext);
  if (!r) {
    throw new Error("useArchonContributionRegistry requires ArchonContributionProvider");
  }
  return r;
}

/** Returns null when outside ArchonContributionProvider (safe for components that may render in minimal contexts). */
export function useArchonContributionRegistryMaybe(): ArchonContributionRegistry | null {
  return useContext(RegistryContext);
}

/** Re-renders when the registry changes. */
export function useArchonCommands(): CommandContribution[] {
  const registry = useArchonContributionRegistry();
  useSyncExternalStore(
    (onChange) => registry.subscribe(onChange),
    () => registry.getSnapshotVersion(),
    () => 0,
  );
  return registry.listCommands();
}

export function useArchonModeLineSegment(
  segment: ModeLineSegmentId,
): ModeLineContribution[] {
  const registry = useArchonContributionRegistry();
  useSyncExternalStore(
    (onChange) => registry.subscribe(onChange),
    () => registry.getSnapshotVersion(),
    () => 0,
  );
  return registry.listModeLineForSegment(segment);
}
