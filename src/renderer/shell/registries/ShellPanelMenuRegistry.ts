export type ShellPanelRegionId = "primarySidebar" | "mainArea" | "companion" | "bottomArea";

export type ShellPanelMenuItem = {
  id: string;
  title: string;
  order?: number;
  region: ShellPanelRegionId;
  /**
   * Optional: only show when the given view is open in the region.
   * If omitted, the item applies to the whole region.
   */
  viewId?: string;
  commandId: string;
  commandArgs?: Record<string, unknown>;
};

type Listener = () => void;

export class ShellPanelMenuRegistry {
  private readonly items = new Map<string, ShellPanelMenuItem>();
  private readonly listeners = new Set<Listener>();

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  registerItem(item: ShellPanelMenuItem): () => void {
    if (!item.id || !item.title || !item.region || !item.commandId) {
      throw new Error("PanelMenu item requires id/title/region/commandId");
    }
    this.items.set(item.id, item);
    this.emit();
    return () => {
      if (this.items.get(item.id) === item) {
        this.items.delete(item.id);
        this.emit();
      }
    };
  }

  registerItems(items: ShellPanelMenuItem[]): () => void {
    const disposers = items.map((it) => this.registerItem(it));
    return () => {
      for (const d of disposers) d();
    };
  }

  listFor(region: ShellPanelRegionId, viewId?: string | null): ShellPanelMenuItem[] {
    const v = viewId ?? null;
    return [...this.items.values()]
      .filter((it) => it.region === region)
      .filter((it) => (it.viewId ? it.viewId === v : true))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  }
}

