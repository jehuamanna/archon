export type ShellRegionId =
  | "menuRail"
  | "sidebarPanel"
  | "mainArea"
  | "companion"
  | "bottomArea"
  | "miniBar"
  | "modeLine";

export type ShellLayoutState = {
  version: 1;
  visible: Record<ShellRegionId, boolean>;
  /** Horizontal split: sidebar / main / secondary (percentages). */
  sizes: {
    primaryPct: number;
    mainPct: number;
    secondaryPct: number;
    bottomPct: number;
  };
  /** Bottom dock tabs (later we mount terminal/output/notebook here). */
  bottomTabs: {
    active: "output" | "terminal" | "notebook";
    visible: Record<"output" | "terminal" | "notebook", boolean>;
    heightPct: number;
  };
};

export function defaultShellLayoutState(): ShellLayoutState {
  return {
    version: 1,
    visible: {
      menuRail: true,
      sidebarPanel: true,
      mainArea: true,
      companion: true,
      bottomArea: false,
      miniBar: true,
      modeLine: true,
    },
    sizes: {
      primaryPct: 18,
      mainPct: 64,
      secondaryPct: 18,
      bottomPct: 25,
    },
    bottomTabs: {
      active: "output",
      visible: { output: true, terminal: true, notebook: true },
      heightPct: 25,
    },
  };
}

export function coerceShellLayoutState(raw: unknown): ShellLayoutState {
  const d = defaultShellLayoutState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return d;
  const r = raw as Partial<ShellLayoutState>;
  if (r.version !== 1) return d;

  const vis = r.visible && typeof r.visible === "object" ? (r.visible as Record<string, unknown>) : {};
  const sizes = r.sizes && typeof r.sizes === "object" ? (r.sizes as Record<string, unknown>) : {};
  const bottom = r.bottomTabs && typeof r.bottomTabs === "object" ? (r.bottomTabs as Record<string, unknown>) : {};
  const bottomVis =
    bottom.visible && typeof bottom.visible === "object"
      ? (bottom.visible as Record<string, unknown>)
      : {};

  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  const companionVisible =
    typeof vis.companion === "boolean"
      ? vis.companion
      : typeof vis.secondaryArea === "boolean"
        ? vis.secondaryArea
        : d.visible.companion;

  return {
    version: 1,
    visible: {
      menuRail: bool(vis.menuRail, d.visible.menuRail),
      sidebarPanel: bool(vis.sidebarPanel, d.visible.sidebarPanel),
      mainArea: bool(vis.mainArea, d.visible.mainArea),
      companion: companionVisible,
      bottomArea: bool(vis.bottomArea, d.visible.bottomArea),
      miniBar: bool(vis.miniBar, d.visible.miniBar),
      modeLine: bool(vis.modeLine, d.visible.modeLine),
    },
    sizes: {
      primaryPct: num(sizes.primaryPct, d.sizes.primaryPct),
      mainPct: num(sizes.mainPct, d.sizes.mainPct),
      secondaryPct: num(sizes.secondaryPct, d.sizes.secondaryPct),
      bottomPct: num(sizes.bottomPct, d.sizes.bottomPct),
    },
    bottomTabs: {
      active:
        bottom.active === "output" || bottom.active === "terminal" || bottom.active === "notebook"
          ? bottom.active
          : d.bottomTabs.active,
      visible: {
        output: bool(bottomVis.output, d.bottomTabs.visible.output),
        terminal: bool(bottomVis.terminal, d.bottomTabs.visible.terminal),
        notebook: bool(bottomVis.notebook, d.bottomTabs.visible.notebook),
      },
      heightPct: num(bottom.heightPct, d.bottomTabs.heightPct),
    },
  };
}

