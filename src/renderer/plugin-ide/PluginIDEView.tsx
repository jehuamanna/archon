import React from "react";
import type { PluginIDEViewModel } from "./usePluginIDE";
import { PluginIDEViewChrome } from "./PluginIDEViewChrome";
import { PluginIDEViewOverlays } from "./PluginIDEViewOverlays";
import { PluginIDEViewPanels } from "./PluginIDEViewPanels";

export function PluginIDEView({ vm }: { vm: PluginIDEViewModel }) {
  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <PluginIDEViewChrome vm={vm} />
      <PluginIDEViewOverlays vm={vm} />
      <PluginIDEViewPanels vm={vm} />
    </div>
  );
}
