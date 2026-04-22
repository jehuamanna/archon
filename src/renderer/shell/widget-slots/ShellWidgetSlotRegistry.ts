import type { ComponentType } from "react";

/** Named surfaces for optional plugin widget chrome (in addition to ShellViewRegistry views). */
export type ShellWidgetSlotId =
  | "rail"
  | "primarySidebarChrome"
  | "mainAreaChrome"
  | "companionChrome"
  | "bottomAreaChrome"
  | "noteEditorChrome";

export type ShellWidgetSlotProps = {
  slotId: ShellWidgetSlotId;
};

export type ShellWidgetContribution = {
  id: string;
  pluginId: string;
  slotId: ShellWidgetSlotId;
  order: number;
  component: ComponentType<ShellWidgetSlotProps>;
};

type Listener = () => void;

/**
 * Secondary registry for small React widgets mounted beside core shell chrome.
 * Primary navigation still uses {@link ShellViewRegistry} (one view per region).
 */
export class ShellWidgetSlotRegistry {
  private readonly bySlot = new Map<ShellWidgetSlotId, ShellWidgetContribution[]>();
  private readonly listeners = new Set<Listener>();

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /**
   * @returns disposer
   */
  register(contribution: ShellWidgetContribution): () => void {
    const { slotId } = contribution;
    const list = this.bySlot.get(slotId)?.slice() ?? [];
    const next = [...list.filter((c) => c.id !== contribution.id), contribution].sort(
      (a, b) => a.order - b.order || a.id.localeCompare(b.id),
    );
    this.bySlot.set(slotId, next);
    this.emit();
    return () => {
      const cur = this.bySlot.get(slotId);
      if (!cur) return;
      const filtered = cur.filter((c) => c.id !== contribution.id);
      if (filtered.length === 0) this.bySlot.delete(slotId);
      else this.bySlot.set(slotId, filtered);
      this.emit();
    };
  }

  list(slotId: ShellWidgetSlotId): ShellWidgetContribution[] {
    return [...(this.bySlot.get(slotId) ?? [])];
  }
}
