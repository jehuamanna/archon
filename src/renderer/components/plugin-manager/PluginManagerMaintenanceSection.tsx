import React from "react";
import { formatBytes } from "./plugin-manager-constants";

type CacheStats = {
  root: string;
  totalBytes: number;
  plugins: { name: string; bytes: number }[];
};

type Props = {
  cacheStats: CacheStats | null;
  userPluginsPath: string | null;
  working: string | null;
  onClearAllCaches: () => void;
  onResetUserPluginsDirectory: () => void;
};

export function PluginManagerMaintenanceSection({
  cacheStats,
  userPluginsPath,
  working,
  onClearAllCaches,
  onResetUserPluginsDirectory,
}: Props): React.ReactElement {
  return (
    <>
      <div className="mt-10 pt-6 border-t border-border">
        <h3 className="text-lg font-semibold text-foreground mb-2">
          Global dependency cache (app cache)
        </h3>
        <p className="text-sm text-muted-foreground mb-3">
          Per-plugin npm installs may use a global cache under{" "}
          <code className="text-xs bg-muted px-1 rounded">
            {cacheStats?.root ?? "…/archon-cache/plugin-cache"}
          </code>
          . New installs use each plugin&apos;s workspace{" "}
          <code className="text-xs bg-muted px-1 rounded">node_modules</code>.
          Install audit lines append to{" "}
          <code className="text-xs bg-muted px-1 rounded">
            plugin-audit.jsonl
          </code>{" "}
          under app userData.
        </p>
        {cacheStats && (
          <p className="text-sm text-foreground mb-3">
            Total: <strong>{formatBytes(cacheStats.totalBytes)}</strong>
            {cacheStats.plugins.length > 0 && (
              <span className="text-muted-foreground">
                {" "}
                —{" "}
                {cacheStats.plugins
                  .filter((p) => p.bytes > 0)
                  .map((p) => `${p.name}: ${formatBytes(p.bytes)}`)
                  .join("; ")}
              </span>
            )}
          </p>
        )}
        <button
          type="button"
          onClick={onClearAllCaches}
          disabled={working !== null}
          className="archon-btn-neutral px-3 py-1 text-sm rounded font-semibold"
        >
          Clear all dependency caches
        </button>
      </div>

      <div className="mt-10 pt-6 border-t border-border">
        <h3 className="text-lg font-semibold text-foreground mb-2">
          Danger zone
        </h3>
        <p className="text-sm text-muted-foreground mb-2">
          User plugins directory (under Electron userData, typically{" "}
          <code className="text-xs bg-muted px-1 rounded">…/plugins</code>
          ):
        </p>
        <p className="text-xs font-mono break-all text-foreground mb-3 rounded border border-border bg-muted/40 p-2">
          {userPluginsPath ?? "Loading path…"}
        </p>
        <p className="text-sm text-muted-foreground mb-3">
          Deletes this entire folder, recreates it, re-seeds sample plugins, and
          reloads the registry. Use when you want a one-shot wipe of imported
          plugin sources and builds. For more options, open the Plugins tab →
          General.
        </p>
        <button
          type="button"
          onClick={() => void onResetUserPluginsDirectory()}
          disabled={working !== null}
          className="archon-btn-neutral-strong px-3 py-1.5 text-sm font-semibold rounded disabled:opacity-50"
        >
          {working === "reset-user-plugins"
            ? "Resetting…"
            : "Delete user plugins folder (reset)"}
        </button>
      </div>
    </>
  );
}
