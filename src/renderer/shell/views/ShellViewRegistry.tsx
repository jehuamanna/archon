import React from "react";

export type ShellRegionId =
  | "primarySidebar"
  | "mainArea"
  | "companion"
  | "bottomArea";

export type ShellViewComponentProps = {
  viewId: string;
  title: string;
};

export type ShellViewDescriptor = {
  id: string;
  title: string;
  defaultRegion: ShellRegionId;
  /** React view body (no iframe). */
  component: React.ComponentType<ShellViewComponentProps>;
  capabilities?: {
    allowedCommands?: "allShellCommands" | "all" | string[];
    readContext?: boolean;
  };
};

type Listener = () => void;

export class ShellViewRegistry {
  private readonly views = new Map<string, ShellViewDescriptor>();
  private readonly listeners = new Set<Listener>();
  private openByRegion: Partial<Record<ShellRegionId, string>> = {};
  /** Bumps on every register/open/close so `useSyncExternalStore` can subscribe reliably. */
  private snapshotVersion = 0;

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** For React `useSyncExternalStore` — changes when any open view or registration changes. */
  getSnapshotVersion(): number {
    return this.snapshotVersion;
  }

  private emit(): void {
    this.snapshotVersion += 1;
    for (const l of this.listeners) l();
  }

  registerView(v: ShellViewDescriptor): () => void {
    if (!v.id || !v.title) {
      throw new Error("View must have id and title");
    }
    if (!v.component) {
      throw new Error("View must provide component");
    }
    this.views.set(v.id, v);
    this.emit();
    return () => {
      if (this.views.get(v.id) === v) {
        this.views.delete(v.id);
        this.emit();
      }
    };
  }

  listViews(): ShellViewDescriptor[] {
    return [...this.views.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  getView(id: string): ShellViewDescriptor | undefined {
    return this.views.get(id);
  }

  openView(viewId: string, regionId?: ShellRegionId): void {
    const v = this.views.get(viewId);
    if (!v) throw new Error(`Unknown view: ${viewId}`);
    const r: ShellRegionId = regionId ?? v.defaultRegion;
    this.openByRegion = { ...this.openByRegion, [r]: v.id };
    this.emit();
  }

  closeRegion(regionId: ShellRegionId): void {
    if (!this.openByRegion[regionId]) return;
    const next = { ...this.openByRegion };
    delete next[regionId];
    this.openByRegion = next;
    this.emit();
  }

  getOpenViewId(regionId: ShellRegionId): string | null {
    return this.openByRegion[regionId] ?? null;
  }
}
