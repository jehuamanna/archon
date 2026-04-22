import { getArchon } from "../../shared/archon-host-access";
import React, { useEffect } from "react";
import { useArchonContributionRegistry } from "./ArchonContributionContext";

/**
 * Connects Electron main-menu IPC to {@link ArchonContributionRegistry.invokeCommand}.
 */
export function ArchonContributionMenuBridge(): null {
  const registry = useArchonContributionRegistry();

  useEffect(() => {
    const api = getArchon();
    if (!api?.onRunContributionCommand) {
      return undefined;
    }
    return api.onRunContributionCommand(({ commandId }) => {
      try {
        const r = registry.invokeCommand(commandId);
        void Promise.resolve(r).catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error("[ArchonContributionMenuBridge]", commandId, err);
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[ArchonContributionMenuBridge]", commandId, err);
      }
    });
  }, [registry]);

  return null;
}
