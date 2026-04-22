import type { Note, NoteRenderer } from "../shared/plugin-api";
import { isHostDisabledNoteType } from "./host-disabled-note-types";
import type { PluginHostTier } from "./plugin-loader-types";

export type PluginThemeMode = "inherit" | "isolated";

export interface PluginRenderer {
  pluginName: string;
  render: (note: Note) => string | Promise<string>;
  onMessage?: (message: unknown) => void;
  /** Iframe UI: inherit host CSS variables vs isolated styling */
  theme?: PluginThemeMode;
  designSystemVersion?: string;
  /** When true, host overlay until iframe posts `content_ready`. */
  deferDisplayUntilContentReady?: boolean;
}

export class Registry {
  private renderers: Map<string, PluginRenderer> = new Map();
  /** Note type string → host tier from the plugin that registered the renderer. */
  private typeHostTier: Map<string, PluginHostTier> = new Map();

  registerRenderer(
    pluginName: string,
    type: string,
    renderer: NoteRenderer,
    uiMeta?: {
      theme?: PluginThemeMode;
      designSystemVersion?: string;
      deferDisplayUntilContentReady?: boolean;
      hostTier?: PluginHostTier;
    },
  ): void {
    if (isHostDisabledNoteType(type)) {
      return;
    }
    this.renderers.set(type, {
      pluginName,
      render: renderer.render,
      onMessage: renderer.onMessage,
      theme: uiMeta?.theme ?? "inherit",
      designSystemVersion: uiMeta?.designSystemVersion,
      deferDisplayUntilContentReady: uiMeta?.deferDisplayUntilContentReady,
    });
    this.typeHostTier.set(type, uiMeta?.hostTier ?? "user");
    console.log(
      `[Registry] Registered renderer: ${type} (plugin: ${pluginName})`,
    );
  }

  unregisterRenderer(pluginName: string, type: string): void {
    const renderer = this.renderers.get(type);
    if (renderer && renderer.pluginName === pluginName) {
      this.renderers.delete(type);
      this.typeHostTier.delete(type);
      console.log(`[Registry] Unregistered renderer: ${type}`);
    }
  }

  getRenderer(type: string): PluginRenderer | null {
    if (isHostDisabledNoteType(type)) {
      return null;
    }
    const direct = this.renderers.get(type);
    if (direct) {
      return direct;
    }
    /** Workspace home notes use `root`; same UI as markdown (markdown plugin may only register `markdown`). */
    if (type === "root") {
      return this.renderers.get("markdown") ?? null;
    }
    return null;
  }

  getRegisteredTypes(): string[] {
    const types = new Set([...this.renderers.keys()]);
    if (types.has("markdown") && !types.has("root")) {
      types.add("root");
    }
    return [...types]
      .filter((t) => !isHostDisabledNoteType(t))
      .sort();
  }

  /**
   * Types the user may pick when creating a note (excludes `system` plugins, e.g. code editor).
   */
  getSelectableNoteTypes(): string[] {
    return this.getRegisteredTypes().filter(
      (t) => this.typeHostTier.get(t) !== "system",
    );
  }

  clear(): void {
    this.renderers.clear();
    this.typeHostTier.clear();
  }
}

export const registry = new Registry();
