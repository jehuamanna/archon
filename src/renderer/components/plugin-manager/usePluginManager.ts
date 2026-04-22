import { getArchon } from "../../../shared/archon-host-access";
import { useState, useEffect, useCallback } from "react";
import { useArchonDialog } from "../../dialog/ArchonDialogProvider";
import { MAX_PROGRESS_LINES } from "./plugin-manager-constants";
import { createPluginManagerMaintenanceHandlers } from "./plugin-manager-maintenance-handlers";
import type { PluginInventoryRow, PluginUiMeta, UserMessage } from "./plugin-manager-types";
import {
  getPluginCacheStats,
  getPluginInventory,
  getPluginLoadIssues,
  getPluginManifestUi,
  getUserPluginsDirectory,
  listInstalledPlugins,
  reloadPluginRegistry,
  uninstallPluginFromBin,
} from "../../domain/pluginsService";

export type UsePluginManagerOptions = {
  onPluginsChanged?: () => void;
  selectedPluginIdProp: string | null | undefined;
};

export function usePluginManager({
  onPluginsChanged,
  selectedPluginIdProp,
}: UsePluginManagerOptions) {
  const { confirm } = useArchonDialog();
  const embedded = selectedPluginIdProp !== undefined;
  const [plugins, setPlugins] = useState<string[]>([]);
  const [inventory, setInventory] = useState<PluginInventoryRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [cacheStats, setCacheStats] = useState<{
    root: string;
    totalBytes: number;
    plugins: { name: string; bytes: number }[];
  } | null>(null);
  const [message, setMessage] = useState<UserMessage>(null);
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [showProgress, setShowProgress] = useState(false);
  const [loadIssues, setLoadIssues] = useState<
    { folder: string; error: string }[]
  >([]);
  const [pluginUiMeta, setPluginUiMeta] = useState<
    Record<string, PluginUiMeta | null>
  >({});
  const [userPluginsPath, setUserPluginsPath] = useState<string | null>(null);

  const pushProgress = useCallback((line: string) => {
    setProgressLines((prev) => {
      const next = [...prev, line];
      if (next.length > MAX_PROGRESS_LINES) {
        return next.slice(-MAX_PROGRESS_LINES);
      }
      return next;
    });
  }, []);

  const loadPlugins = async () => {
    const [installed, inv] = await Promise.all([
      listInstalledPlugins(),
      getPluginInventory(),
    ]);
    setPlugins(installed);
    setInventory(inv);
    const meta: Record<string, PluginUiMeta | null> = {};
    const ids = new Set([...installed, ...inv.map((r) => r.id)]);
    for (const p of ids) {
      try {
        meta[p] = await getPluginManifestUi(p);
      } catch {
        meta[p] = null;
      }
    }
    setPluginUiMeta(meta);
  };

  const refreshLoadIssues = useCallback(async () => {
    const issues = await getPluginLoadIssues();
    setLoadIssues(issues);
  }, []);

  const refreshCacheStats = useCallback(async () => {
    const stats = await getPluginCacheStats();
    setCacheStats(stats);
  }, []);

  useEffect(() => {
    loadPlugins();
    refreshCacheStats();
    refreshLoadIssues();
  }, [refreshCacheStats, refreshLoadIssues]);

  useEffect(() => {
    void getUserPluginsDirectory().then((res) => {
      if (res.path) {
        setUserPluginsPath(res.path);
      }
    });
  }, []);

  useEffect(() => {
    return getArchon().onPluginProgress((p) => {
      const tag = p.pluginName ? `[${p.pluginName}] ` : "";
      pushProgress(`${p.op}/${p.phase}: ${tag}${p.message}`);
    });
  }, [pushProgress]);

  const handleImport = async () => {
    try {
      setImporting(true);
      setMessage(null);

      const zipPath = await getArchon().selectZipFile();
      if (!zipPath) {
        setImporting(false);
        return;
      }

      const pre = await getArchon().validatePluginZip(zipPath);
      if (!pre.valid) {
        setMessage({
          type: "error",
          text: `Validation failed:\n${pre.errors.join("\n")}`,
        });
        setImporting(false);
        return;
      }
      if (pre.warnings.length > 0) {
        setMessage({
          type: "info",
          text: `Warnings:\n${pre.warnings.join("\n")}`,
        });
      }

      const result = await getArchon().importPlugin(zipPath);

      if (result.success) {
        const w =
          result.warnings?.length && result.warnings.length > 0
            ? `\nWarnings:\n${result.warnings.join("\n")}`
            : "";
        setMessage({
          type: "success",
          text: `Plugin imported successfully!${w}`,
        });
        await loadPlugins();
        await refreshLoadIssues();
        if (onPluginsChanged) {
          onPluginsChanged();
        }
      } else {
        setMessage({
          type: "error",
          text: result.error || "Failed to import plugin",
        });
      }
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setImporting(false);
    }
  };

  const handleReloadRegistry = async () => {
    setMessage(null);
    try {
      const r = await reloadPluginRegistry();
      if (r.success) {
        setMessage({ type: "success", text: "Plugins refreshed." });
        onPluginsChanged?.();
        await loadPlugins();
      } else {
        setMessage({
          type: "error",
          text: r.error ?? "Reload failed",
        });
      }
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Reload failed",
      });
    }
  };

  const handleUninstall = async (pluginName: string) => {
    const ok = await confirm({
      title: "Uninstall from bin",
      message: `Remove the bundled copy of "${pluginName}" from bin/? Plugin sources under sources/ stay on disk.`,
      confirmLabel: "Remove",
      variant: "danger",
    });
    if (!ok) {
      return;
    }

    try {
      const result = await uninstallPluginFromBin(pluginName);

      if (result.success) {
        setMessage({
          type: "success",
          text: `Removed ${pluginName} from bin/. Sources preserved; app will use sources if present.`,
        });
        await loadPlugins();
        await refreshLoadIssues();
        if (onPluginsChanged) {
          onPluginsChanged();
        }
      } else {
        setMessage({
          type: "error",
          text: result.error || "Failed to uninstall plugin",
        });
      }
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  const idsForCards =
    embedded && selectedPluginIdProp !== null
      ? [selectedPluginIdProp]
      : embedded && selectedPluginIdProp === null
        ? []
        : plugins;

  const invFor = (id: string): PluginInventoryRow | undefined =>
    inventory.find((r) => r.id === id);

  const { handleClearAllCaches, handleResetUserPluginsDirectory } =
    createPluginManagerMaintenanceHandlers({
      confirm,
      userPluginsPath,
      setUserPluginsPath,
      setWorking,
      setMessage,
      onPluginsChanged,
      loadPlugins,
      refreshLoadIssues,
      refreshCacheStats,
    });

  return {
    embedded,
    selectedPluginIdProp,
    importing,
    working,
    cacheStats,
    message,
    progressLines,
    showProgress,
    setShowProgress,
    loadIssues,
    pluginUiMeta,
    userPluginsPath,
    idsForCards,
    invFor,
    setMessage,
    handleImport,
    handleClearAllCaches,
    handleResetUserPluginsDirectory,
    handleReloadRegistry,
    handleUninstall,
    loadPlugins,
    onPluginsChanged,
  };
}
