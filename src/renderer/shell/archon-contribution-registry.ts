/** In-app contribution registry (commands + mode line). Mirrors architecture: palette/mini bar + stacked segments. */

import type { ComponentType } from "react";
import type { Note } from "@archon/ui-types";

/** Props for React editors mounted by {@link NoteTypeReactRenderer}. */
export type NoteTypeReactEditorProps = {
  note: Note;
  persistToNotesStore?: boolean;
  assetProjectRoot?: string | null;
};

export type CommandHandler = (
  args?: Record<string, unknown>,
) => void | Promise<void>;

/** Single argument field for docs + JSON Schema generation. */
export type CommandArgDefinition = {
  name: string;
  /** Human-readable type (shown in tables); also mapped to JSON Schema when `schema` is omitted. */
  type: string;
  required?: boolean;
  description?: string;
  default?: unknown;
  example?: unknown;
  /** Optional JSON Schema fragment merged for this property (e.g. `enum`, `pattern`). */
  schema?: Record<string, unknown>;
};

export type CommandReturnSpec = {
  type: string;
  description?: string;
};

/**
 * Structured API contract for Documentation and tooling.
 * Namespace / shortName default from `id` (`a.b.c` → `a.b` + `c`).
 */
export type CommandApiContract = {
  namespace?: string;
  shortName?: string;
  /** One-line contract summary (defaults to `title`). */
  summary?: string;
  /** Long-form details (shown with prose `doc`). */
  details?: string;
  args?: CommandArgDefinition[];
  /** Full JSON Schema for the invoke args object (optional; else derived from `args`). */
  argsJsonSchema?: Record<string, unknown>;
  returns?: CommandReturnSpec;
  /** Example `args` object for `invokeCommand(id, args)`. */
  exampleInvoke?: Record<string, unknown> | null;
};

export type CommandContribution = {
  id: string;
  title: string;
  category?: string;
  sourcePluginId?: string | null;
  disambiguation?: string;
  /** Include in command palette (default true). */
  palette?: boolean;
  /** Expose to mini-bar style completion (default true). */
  miniBar?: boolean;
  doc?: string | null;
  /** Machine-readable contract for generated docs (namespace, args, JSON Schema, examples). */
  api?: CommandApiContract;
  handler: CommandHandler;
};

export type ModeLineSegmentId =
  | "host.left"
  | "host.center"
  | "host.right"
  | "plugin.primary"
  | "plugin.secondary";

export type ModeLineContribution = {
  id: string;
  segment: ModeLineSegmentId;
  priority: number;
  text: string;
  sourcePluginId?: string | null;
  transient?: boolean;
};

type Listener = () => void;

export class ArchonContributionRegistry {
  private readonly commands = new Map<string, CommandContribution>();
  private readonly modeLine = new Map<string, ModeLineContribution>();
  private readonly noteTypeReactEditors = new Map<string, ComponentType<NoteTypeReactEditorProps>>();
  private readonly mdxComponents = new Map<string, ComponentType<Record<string, unknown>>>();
  private readonly listeners = new Set<Listener>();
  private snapshotVersion = 0;

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  getSnapshotVersion(): number {
    return this.snapshotVersion;
  }

  private emit(): void {
    this.snapshotVersion += 1;
    for (const l of this.listeners) {
      l();
    }
  }

  /** Replace if same id; returns dispose. */
  registerCommand(c: CommandContribution): () => void {
    const merged: CommandContribution = {
      palette: true,
      miniBar: true,
      sourcePluginId: "archon.plugin",
      ...c,
    };
    const { id } = merged;
    this.commands.set(id, merged);
    this.emit();
    return () => {
      if (this.commands.get(id) === merged) {
        this.commands.delete(id);
        this.emit();
      }
    };
  }

  /**
   * Register a React editor for a note `type` (e.g. system `markdown` plugin).
   * Later registrations replace earlier ones for the same type.
   */
  registerNoteTypeReactEditor(
    noteType: string,
    component: ComponentType<NoteTypeReactEditorProps>,
  ): () => void {
    this.noteTypeReactEditors.set(noteType, component);
    this.emit();
    return () => {
      if (this.noteTypeReactEditors.get(noteType) === component) {
        this.noteTypeReactEditors.delete(noteType);
        this.emit();
      }
    };
  }

  getNoteTypeReactEditor(
    noteType: string,
  ): ComponentType<NoteTypeReactEditorProps> | undefined {
    return this.noteTypeReactEditors.get(noteType);
  }

  /**
   * Register a React component as an MDX JSX tag available inside MDX notes.
   * The `name` is the JSX tag name (PascalCase, e.g. "MyWidget").
   * Later registrations replace earlier ones for the same name.
   * Built-in host components cannot be overridden (validation is in MdxRenderer).
   * Returns a dispose function that removes the registration.
   */
  registerMdxComponent(
    name: string,
    component: ComponentType<Record<string, unknown>>,
  ): () => void {
    this.mdxComponents.set(name, component);
    this.emit();
    return () => {
      if (this.mdxComponents.get(name) === component) {
        this.mdxComponents.delete(name);
        this.emit();
      }
    };
  }

  /** Returns a snapshot of all plugin-registered MDX components keyed by tag name. */
  getMdxComponents(): Record<string, ComponentType<Record<string, unknown>>> {
    return Object.fromEntries(this.mdxComponents.entries());
  }

  registerModeLineItem(c: ModeLineContribution): () => void {
    const { id } = c;
    this.modeLine.set(id, c);
    this.emit();
    return () => {
      if (this.modeLine.get(id) === c) {
        this.modeLine.delete(id);
        this.emit();
      }
    };
  }

  listCommands(): CommandContribution[] {
    return [...this.commands.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  listModeLineForSegment(segment: ModeLineSegmentId): ModeLineContribution[] {
    return [...this.modeLine.values()]
      .filter((m) => m.segment === segment)
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          (a.sourcePluginId ?? "").localeCompare(b.sourcePluginId ?? "") ||
          a.id.localeCompare(b.id),
      );
  }

  getCommand(id: string): CommandContribution | undefined {
    return this.commands.get(id);
  }

  invokeCommand(
    id: string,
    args?: Record<string, unknown>,
  ): void | Promise<void> {
    const cmd = this.commands.get(id);
    if (!cmd) {
      throw new Error(`Unknown command: ${id}`);
    }
    return cmd.handler(args);
  }
}
