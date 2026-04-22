import { getArchon } from "../../../shared/archon-host-access";
import type { ArchonConfirmOptions } from "../../dialog/ArchonDialogProvider";
import type { UserMessage } from "./plugin-manager-types";

type Args = {
  confirm: (opts: ArchonConfirmOptions) => Promise<boolean>;
  userPluginsPath: string | null;
  setUserPluginsPath: (p: string | null) => void;
  setWorking: (w: string | null) => void;
  setMessage: (m: UserMessage) => void;
  onPluginsChanged?: () => void;
  loadPlugins: () => Promise<void>;
  refreshLoadIssues: () => Promise<void>;
  refreshCacheStats: () => Promise<void>;
};

export function createPluginManagerMaintenanceHandlers({
  confirm,
  userPluginsPath,
  setUserPluginsPath,
  setWorking,
  setMessage,
  onPluginsChanged,
  loadPlugins,
  refreshLoadIssues,
  refreshCacheStats,
}: Args) {
  const handleClearAllCaches = async () => {
    const ok = await confirm({
      title: "Clear dependency caches",
      message:
        "Remove all global plugin dependency cache data (app cache folder)? Bundles will need reinstalling.",
      confirmLabel: "Clear",
      variant: "danger",
    });
    if (!ok) {
      return;
    }
    setMessage(null);
    await getArchon().clearAllPluginDependencyCaches();
    setMessage({
      type: "success",
      text: "All plugin dependency caches cleared.",
    });
    await refreshCacheStats();
  };

  const handleResetUserPluginsDirectory = async () => {
    const displayPath =
      userPluginsPath ?? "(path unavailable — check main process logs)";
    const ok1 = await confirm({
      title: "Reset user plugins folder",
      message: `Delete the entire user plugins folder and reset to a clean state?

${displayPath}

This removes sources/, bin/, IDE metadata under that folder. Sample markdown/tiptap plugins will be re-seeded if missing. Bundled core plugins are not removed. This cannot be undone.`,
      confirmLabel: "Continue",
      variant: "danger",
    });
    if (!ok1) {
      return;
    }
    const ok2 = await confirm({
      title: "Confirm deletion",
      message: "Permanently delete that folder now?",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok2) {
      return;
    }
    setWorking("reset-user-plugins");
    setMessage(null);
    try {
      const res = await getArchon().resetUserPluginsDirectory();
      if (res.success) {
        setMessage({
          type: "success",
          text: `User plugins folder was reset.\n${res.path}`,
        });
        onPluginsChanged?.();
        await loadPlugins();
        await refreshLoadIssues();
        await refreshCacheStats();
        const again = await getArchon().getUserPluginsDirectory();
        if (again.path) {
          setUserPluginsPath(again.path);
        }
      } else {
        setMessage({
          type: "error",
          text: res.error ?? "Failed to reset user plugins folder",
        });
      }
    } catch (e) {
      setMessage({
        type: "error",
        text:
          e instanceof Error ? e.message : "Failed to reset user plugins folder",
      });
    } finally {
      setWorking(null);
    }
  };

  return { handleClearAllCaches, handleResetUserPluginsDirectory };
}
