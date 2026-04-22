import React from "react";
import { PluginManagerAlerts } from "./plugin-manager/PluginManagerAlerts";
import { PluginManagerMaintenanceSection } from "./plugin-manager/PluginManagerMaintenanceSection";
import { PluginManagerPluginRows } from "./plugin-manager/PluginManagerPluginRows";
import { usePluginManager } from "./plugin-manager/usePluginManager";

interface PluginManagerProps {
  onPluginsChanged?: () => void;
  /**
   * `undefined` — standalone manager (full list in-page).
   * `null` — embedded in shell: no plugin selected yet.
   * string — embedded: show detail for this id only.
   */
  selectedPluginId?: string | null;
}

const PluginManager: React.FC<PluginManagerProps> = ({
  onPluginsChanged,
  selectedPluginId: selectedPluginIdProp,
}) => {
  const pm = usePluginManager({
    onPluginsChanged,
    selectedPluginIdProp,
  });

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {!pm.embedded ? (
        <header className="border-b border-border px-4 py-3">
          <h2 className="text-[13px] font-semibold text-foreground">
            Plugin Manager
          </h2>
          <p className="mt-2 text-[12px] text-muted-foreground">
            Manage your Archon plugins
          </p>
        </header>
      ) : null}

      <div className="flex-1 overflow-auto px-4 py-4">
        <PluginManagerAlerts
          message={pm.message}
          loadIssues={pm.loadIssues}
          showProgress={pm.showProgress}
          progressLines={pm.progressLines}
          onToggleProgress={() => pm.setShowProgress((s) => !s)}
        />

        <div className="mb-6 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void pm.handleImport()}
            disabled={pm.importing}
            className="archon-btn-neutral rounded-lg px-4 py-2 font-semibold disabled:cursor-not-allowed"
          >
            {pm.importing
              ? "Importing..."
              : "Import plugin (.archonplugin / .zip)"}
          </button>
          <button
            type="button"
            onClick={() => void pm.handleReloadRegistry()}
            disabled={pm.working !== null}
            className="rounded-lg border border-border bg-muted/50 px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-50"
          >
            Refresh plugins
          </button>
        </div>

        <PluginManagerPluginRows
          embedded={pm.embedded}
          selectedPluginIdProp={pm.selectedPluginIdProp}
          idsForCards={pm.idsForCards}
          invFor={pm.invFor}
          pluginUiMeta={pm.pluginUiMeta}
          working={pm.working}
          loadPlugins={() => pm.loadPlugins()}
          onPluginsChanged={pm.onPluginsChanged}
          setMessage={pm.setMessage}
          onUninstall={pm.handleUninstall}
        />

        {!pm.embedded ? (
          <PluginManagerMaintenanceSection
            cacheStats={pm.cacheStats}
            userPluginsPath={pm.userPluginsPath}
            working={pm.working}
            onClearAllCaches={() => void pm.handleClearAllCaches()}
            onResetUserPluginsDirectory={pm.handleResetUserPluginsDirectory}
          />
        ) : null}
      </div>
    </div>
  );
};

export default PluginManager;
