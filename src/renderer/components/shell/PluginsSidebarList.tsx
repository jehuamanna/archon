import { getArchon } from "../../../shared/archon-host-access";
import React, { useEffect, useState } from "react";

export type PluginsSidebarSelection =
  | { kind: "general" }
  | { kind: "market" }
  | { kind: "plugin"; id: string };

export interface PluginsSidebarListProps {
  selection: PluginsSidebarSelection;
  onSelectGeneral: () => void;
  onSelectMarket: () => void;
  onSelectPlugin: (id: string) => void;
}

const PluginsSidebarList: React.FC<PluginsSidebarListProps> = ({
  selection,
  onSelectGeneral,
  onSelectMarket,
  onSelectPlugin,
}) => {
  const [rows, setRows] = useState<
    Awaited<ReturnType<ReturnType<typeof getArchon>["getPluginInventory"]>>
  >([]);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => {
    setErr(null);
    void getArchon()
      .getPluginInventory()
      .then(setRows)
      .catch((e) => {
        setRows([]);
        setErr(e instanceof Error ? e.message : "Failed to load plugins");
      });
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    return getArchon().onPluginsChanged(refresh);
  }, []);

  const generalActive = selection.kind === "general";
  const marketActive = selection.kind === "market";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <button
        type="button"
        onClick={onSelectGeneral}
        className={`border-sidebar-border border-b px-3 py-2.5 text-left text-[12px] transition-colors ${
          generalActive
            ? "bg-sidebar-accent font-medium text-foreground"
            : "text-sidebar-foreground/90 hover:bg-sidebar-accent/40"
        }`}
      >
        General
      </button>
      <button
        type="button"
        onClick={onSelectMarket}
        className={`border-sidebar-border border-b px-3 py-2.5 text-left text-[12px] transition-colors ${
          marketActive
            ? "bg-sidebar-accent font-medium text-foreground"
            : "text-sidebar-foreground/90 hover:bg-sidebar-accent/40"
        }`}
      >
        Market
      </button>
      <div className="border-sidebar-border border-b px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Plugins
        </span>
      </div>
      {err ? (
        <div className="border-sidebar-border border-b px-3 py-3 text-[11px] text-muted-foreground">
          {err}
        </div>
      ) : rows.length === 0 ? (
        <div className="border-sidebar-border border-b px-3 py-3 text-[11px] text-muted-foreground">
          No plugins found.
        </div>
      ) : null}
      {rows.map((r) => {
        const active =
          selection.kind === "plugin" && selection.id === r.id;
        return (
          <button
            key={r.id}
            type="button"
            title={r.id}
            onClick={() => onSelectPlugin(r.id)}
            className={`border-sidebar-border border-b px-3 py-2 pl-5 text-left text-[12px] transition-colors ${
              active
                ? "bg-sidebar-accent font-medium text-foreground"
                : "text-sidebar-foreground/90 hover:bg-sidebar-accent/40"
            }`}
          >
            <span className="block truncate font-mono">{r.id}</span>
            <span className="mt-0.5 block text-[10px] text-sidebar-foreground/55">
              {r.isBundled
                ? "Core"
                : r.enabled
                  ? r.loaded
                    ? "User · loaded"
                    : "User · not loaded"
                  : "User · disabled"}
            </span>
          </button>
        );
      })}
    </div>
  );
};

export default PluginsSidebarList;
