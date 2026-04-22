import React from "react";
import type { ShellTabInstance } from "../registries/ShellTabsRegistry";
import { ShellActiveMainTabProvider } from "../ShellActiveTabContext";
import type { ShellViewDescriptor } from "./ShellViewRegistry";

/**
 * Mounts a shell view as a React subtree (no iframe).
 */
export function ShellViewHost({
  view,
  activeMainTab = undefined,
}: {
  view: ShellViewDescriptor;
  /** When provided, exposes the active main-column tab to the view subtree. */
  activeMainTab?: ShellTabInstance | null;
}): React.ReactElement {
  const C = view.component;
  const caps = view.capabilities ?? {};
  const allowedCommands =
    caps.allowedCommands === "allShellCommands" ||
    caps.allowedCommands === "all" ||
    Array.isArray(caps.allowedCommands)
      ? caps.allowedCommands
      : [];
  const inner = (
    <div
      className="h-full min-h-0 min-w-0 w-full overflow-auto bg-background"
      data-archon-view-id={view.id}
      data-archon-allowed-commands={
        typeof allowedCommands === "string"
          ? allowedCommands
          : JSON.stringify(allowedCommands)
      }
      data-archon-read-context={caps.readContext === true ? "1" : "0"}
      data-archon-shell-view="1"
    >
      <C viewId={view.id} title={view.title} />
    </div>
  );
  if (activeMainTab !== undefined) {
    return (
      <ShellActiveMainTabProvider tab={activeMainTab}>{inner}</ShellActiveMainTabProvider>
    );
  }
  return inner;
}
