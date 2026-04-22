import { getArchon } from "../../../shared/archon-host-access";
import React from "react";
import type {
  PluginInventoryRow,
  PluginUiMeta,
  UserMessage,
} from "./plugin-manager-types";

type Props = {
  embedded: boolean;
  selectedPluginIdProp: string | null | undefined;
  idsForCards: string[];
  invFor: (id: string) => PluginInventoryRow | undefined;
  pluginUiMeta: Record<string, PluginUiMeta | null>;
  working: string | null;
  loadPlugins: () => Promise<void>;
  onPluginsChanged?: () => void;
  setMessage: (m: UserMessage) => void;
  onUninstall: (pluginName: string) => void;
};

export function PluginManagerPluginRows({
  embedded,
  selectedPluginIdProp,
  idsForCards,
  invFor,
  pluginUiMeta,
  working,
  loadPlugins,
  onPluginsChanged,
  setMessage,
  onUninstall,
}: Props): React.ReactElement {
  return (
    <div>
      {!embedded ? (
        <h3 className="text-lg font-semibold text-foreground mb-3">
          Installed Plugins
        </h3>
      ) : (
        <h3 className="text-lg font-semibold text-foreground mb-3">
          Plugin detail
        </h3>
      )}

      {embedded && selectedPluginIdProp === null ? (
        <div className="text-muted-foreground py-8 text-[12px]">
          Select a plugin in the left list to view details and actions.
        </div>
      ) : idsForCards.length === 0 ? (
        <div className="text-muted-foreground text-center py-8">
          No plugins installed yet. Import a plugin to get started!
        </div>
      ) : (
        <div className="space-y-2">
          {idsForCards.map((plugin) => (
            <div
              key={plugin}
              className="flex flex-col gap-3 p-4 bg-muted/40 rounded-lg border border-border"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="font-medium text-foreground">{plugin}</h4>
                    {invFor(plugin)?.isBundled ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/80">
                        Core
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {invFor(plugin)?.loaded
                      ? "Loaded"
                      : invFor(plugin)?.enabled === false
                        ? "Disabled"
                        : "Not loaded"}
                  </p>
                  {pluginUiMeta[plugin]?.designSystemWarning ? (
                    <p className="mt-1 text-xs text-foreground/85">
                      {pluginUiMeta[plugin]!.designSystemWarning}
                    </p>
                  ) : null}
                  {pluginUiMeta[plugin]?.theme === "isolated" ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      UI theme: isolated (host tokens not injected)
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => onUninstall(plugin)}
                    disabled={working !== null}
                    className="rounded border border-border bg-muted/50 px-3 py-1 text-sm font-medium text-foreground hover:bg-muted"
                  >
                    Uninstall
                  </button>
                  {invFor(plugin)?.canToggle ? (
                    <button
                      type="button"
                      disabled={working !== null}
                      onClick={async () => {
                        const enabled = invFor(plugin)?.enabled !== false;
                        const r = await getArchon().setPluginEnabled(
                          plugin,
                          !enabled,
                        );
                        if (r.success) {
                          await loadPlugins();
                          onPluginsChanged?.();
                        } else {
                          setMessage({
                            type: "error",
                            text: r.error ?? "Could not update plugin",
                          });
                        }
                      }}
                      className="rounded border border-border bg-muted/50 px-3 py-1 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      {invFor(plugin)?.enabled === false ? "Enable" : "Disable"}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
