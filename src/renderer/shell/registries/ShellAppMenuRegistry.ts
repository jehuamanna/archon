export type ShellAppMenuItem = {
  id: string;
  title: string;
  order?: number;
  children?: ShellAppMenuItem[];
  commandId?: string;
  args?: Record<string, unknown>;
};

type Listener = () => void;

export class ShellAppMenuRegistry {
  private items: ShellAppMenuItem[] = [];
  private readonly listeners = new Set<Listener>();

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  list(): ShellAppMenuItem[] {
    const sortItems = (xs: ShellAppMenuItem[]): ShellAppMenuItem[] =>
      xs
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
        .map((x) => ({
          ...x,
          children: x.children ? sortItems(x.children) : undefined,
        }));
    return sortItems(this.items);
  }

  registerItems(items: ShellAppMenuItem[]): () => void {
    const prev = this.items;
    this.items = [...prev, ...items];
    this.emit();
    return () => {
      this.items = this.items.filter((x) => !items.includes(x));
      this.emit();
    };
  }
}

