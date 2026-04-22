import { getArchon } from "../../shared/archon-host-access";
import type { PluginInventoryItem } from "@archon/ui-types";

export async function listInstalledPlugins(): Promise<string[]> {
  return getArchon().getInstalledPlugins();
}

export async function getPluginInventory(): Promise<PluginInventoryItem[]> {
  return getArchon().getPluginInventory();
}

export async function reloadPluginRegistry(): Promise<{
  success: boolean;
  error?: string;
}> {
  return getArchon().reloadPluginRegistry();
}

export async function setPluginEnabled(
  pluginId: string,
  enabled: boolean,
): Promise<{ success: boolean; error?: string }> {
  return getArchon().setPluginEnabled(pluginId, enabled);
}

export async function uninstallPluginFromBin(
  pluginId: string,
): Promise<{ success: boolean; error?: string }> {
  return getArchon().uninstallPlugin(pluginId);
}

export async function getPluginLoadIssues(): Promise<
  { folder: string; error: string }[]
> {
  return getArchon().getPluginLoadIssues();
}

export async function getPluginCacheStats(): Promise<{
  root: string;
  totalBytes: number;
  plugins: { name: string; bytes: number }[];
}> {
  return getArchon().getPluginCacheStats();
}

export async function getUserPluginsDirectory(): Promise<{
  path: string;
  error?: string;
}> {
  return getArchon().getUserPluginsDirectory();
}

export async function getPluginManifestUi(pluginId: string): Promise<{
  theme: "inherit" | "isolated";
  designSystemVersion?: string;
  designSystemWarning: string | null;
} | null> {
  return getArchon().getPluginManifestUi(pluginId);
}

