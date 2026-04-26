import type React from "react";
import type { ShellRegionId } from "../views/ShellViewRegistry";

export type ShellMenuRailItem = {
  id: string;
  title: string;
  order?: number;
  /** Optional icon (emoji/string); real icons can come later. */
  icon?: string;
  /**
   * Optional React component rendered as a small overlay on the rail button
   * (e.g. unread-count badge). Returning `null` renders nothing. The component
   * manages its own reactivity (e.g. via Redux selectors).
   */
  BadgeOverlay?: React.ComponentType;
  /**
   * Runs a custom handler (palette, complex flows). If set, takes precedence over
   * {@link tabTypeId} / {@link openViewId}.
   */
  commandId?: string;
  commandArgs?: Record<string, unknown>;
  /**
   * Opens a **new tab instance** and syncs the main area to that tab’s `viewId`.
   * Optional {@link sidebarViewId} / {@link secondaryViewId} open companion panels.
   */
  tabTypeId?: string;
  /** Passed to `openOrReuseTab` so repeated rail clicks focus one tab (optional). */
  tabReuseKey?: string;
  /** Show chrome regions when opening this tab (e.g. JS notebook without a sidebar view id). */
  expandChrome?: {
    menuRail?: boolean;
    sidebarPanel?: boolean;
    companion?: boolean;
  };
  /**
   * Hide chrome regions when opening this tab. Runs after `expandChrome`.
   * Use for tabs whose main area is self-contained and shouldn't bring the
   * sidebar / companion along (e.g. the Welcome view).
   */
  collapseChrome?: {
    sidebarPanel?: boolean;
    companion?: boolean;
  };
  sidebarViewId?: string;
  secondaryViewId?: string;
  /** Legacy: open a single view without opening a tab (prefer {@link tabTypeId}). */
  openViewId?: string;
  /** Where to open the view (default: sidebar panel). */
  openViewRegion?: ShellRegionId;
  /**
   * Where to render the icon in the activity bar. `top` (default) groups
   * with the primary navigation; `bottom` pins below the separator with
   * utilities like Admin and Notifications.
   */
  placement?: "top" | "bottom";
};

type Listener = () => void;

export class ShellMenuRailRegistry {
  private readonly items = new Map<string, ShellMenuRailItem>();
  private readonly listeners = new Set<Listener>();

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  registerItem(item: ShellMenuRailItem): () => void {
    if (!item.id || !item.title) throw new Error("MenuRailItem requires id/title");
    this.items.set(item.id, item);
    this.emit();
    return () => {
      if (this.items.get(item.id) === item) {
        this.items.delete(item.id);
        this.emit();
      }
    };
  }

  list(): ShellMenuRailItem[] {
    return [...this.items.values()].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
    );
  }
}

