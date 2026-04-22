export type ShellKeyBinding = {
  /** Stable id for replacement/disposal. */
  id: string;
  /** Human-friendly label shown in docs/UI. */
  title: string;
  /** Optional: plugin owning this binding. */
  sourcePluginId?: string | null;
  /**
   * Key chord in a normalized string form:
   * - "alt+x"
   * - "ctrl+shift+k"
   * - "meta+alt+p"
   * - "f1"
   */
  chord: string;
  /** Command to invoke when chord matches. */
  commandId: string;
  commandArgs?: Record<string, unknown>;
  /** If true, do not trigger when focus is in inputs. Default false (shortcuts work from minibuffer too). */
  ignoreWhenInput?: boolean;
};

type Listener = () => void;

export function normalizeChord(chord: string): string {
  const raw = String(chord || "").trim().toLowerCase();
  if (!raw) return "";
  const parts = raw.split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() ?? "";
  const mods = new Set(parts);
  const orderedMods = ["ctrl", "meta", "alt", "shift"].filter((m) => mods.has(m));
  return [...orderedMods, key].join("+");
}

export function chordFromEvent(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.metaKey) mods.push("meta");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  // Alt+letter: some layouts produce a non-ASCII e.key; use physical KeyA–KeyZ.
  let keyTok: string;
  if (e.altKey && !e.ctrlKey && !e.metaKey && /^Key([A-Z])$/.test(e.code)) {
    keyTok = e.code.slice(3).toLowerCase();
  } else {
    const k = e.key;
    if (k == null || k === "") {
      keyTok = "";
    } else {
      keyTok = k.length === 1 ? k.toLowerCase() : k.toLowerCase();
    }
  }
  return normalizeChord([...mods, keyTok].join("+"));
}

export class ShellKeymapRegistry {
  private readonly bindings = new Map<string, ShellKeyBinding>();
  private readonly chordToId = new Map<string, string>();
  private readonly listeners = new Set<Listener>();

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  register(b: ShellKeyBinding): () => void {
    if (!b.id || !b.title || !b.chord || !b.commandId) {
      throw new Error("Key binding requires id/title/chord/commandId");
    }
    const merged: ShellKeyBinding = {
      sourcePluginId: null,
      ignoreWhenInput: false,
      ...b,
      chord: normalizeChord(b.chord),
    };

    const prev = this.bindings.get(merged.id);
    if (prev) {
      // Unindex previous chord for this id (if it still points to this id).
      const prevChord = normalizeChord(prev.chord);
      if (this.chordToId.get(prevChord) === merged.id) {
        this.chordToId.delete(prevChord);
      }
    }

    // Enforce chord uniqueness (last registration wins).
    const owner = this.chordToId.get(merged.chord);
    if (owner && owner !== merged.id) {
      this.bindings.delete(owner);
      this.chordToId.delete(merged.chord);
    }

    this.bindings.set(merged.id, merged);
    this.chordToId.set(merged.chord, merged.id);
    this.emit();
    return () => {
      if (this.bindings.get(merged.id) === merged) {
        this.bindings.delete(merged.id);
        if (this.chordToId.get(merged.chord) === merged.id) {
          this.chordToId.delete(merged.chord);
        }
        this.emit();
      }
    };
  }

  registerMany(bs: ShellKeyBinding[]): () => void {
    const ds = bs.map((b) => this.register(b));
    return () => ds.forEach((d) => d());
  }

  list(): ShellKeyBinding[] {
    return [...this.bindings.values()].sort((a, b) =>
      a.chord.localeCompare(b.chord) || a.id.localeCompare(b.id),
    );
  }

  /**
   * Returns the first binding matching chord, in registration order by list().
   * (We sort by chord/id; for now that's stable enough for MVP.)
   */
  match(chord: string): ShellKeyBinding | null {
    const c = normalizeChord(chord);
    if (!c) return null;
    for (const b of this.list()) {
      if (b.chord === c) return b;
    }
    return null;
  }
}

