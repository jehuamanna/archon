import { getArchon } from "../../../src/shared/archon-host-access";
import type { ComponentType } from "react";
import { useEffect, useMemo } from "react";
import type { ArchonRendererApi } from "../../../src/shared/archon-renderer-api";
import type { PluginHostCapabilities, MediatedFetch } from "../../../src/shared/plugin-host-capabilities";
import type { PluginBundleManifestEntry, PluginBundleIndex } from "../../../src/shared/plugin-bundle-manifest";

export type { PluginHostCapabilities, MediatedFetch };
export type { PluginBundleManifestEntry, PluginBundleIndex };

/** Host shell widget slot ids (see `ShellWidgetSlotRegistry` in the app). */
export type ShellSlotId =
  | "rail"
  | "primarySidebarChrome"
  | "mainAreaChrome"
  | "companionChrome"
  | "bottomAreaChrome"
  | "noteEditorChrome";

/** Declarative command metadata (host registers into ArchonContributionRegistry). */
export type PluginCommandContribution = {
  id: string;
  title: string;
  category?: string;
  doc?: string | null;
  sourcePluginId?: string | null;
};

/**
 * Declarative plugin module (trusted bundle or SES-evaluated CJS).
 * UI slots map to shell regions / note surface; non-UI fields describe commands and note types.
 */
export type PluginModuleDefinition = {
  id: string;
  version?: string;
  slots?: Partial<Record<ShellSlotId, ComponentType<Record<string, unknown>>>>;
  commands?: PluginCommandContribution[];
  /** Note type strings this plugin contributes (registry integration is host-specific). */
  noteTypes?: string[];
};

export function definePlugin(def: PluginModuleDefinition): PluginModuleDefinition {
  return def;
}

/** Full `getArchon()` for first-party React plugins (no iframe sandbox). */
export function useHostArchon(): ArchonRendererApi {
  return useMemo(() => {
    if (typeof window === "undefined") {
      throw new Error("useHostArchon requires a browser environment");
    }
    return getArchon();
  }, []);
}

/** Note payload sent with host `render` / `update` messages (legacy iframe protocol). */
export interface NotePayload {
  id: string;
  type: string;
  title: string;
  content: string;
  metadata?: unknown;
}

export type HostToPluginMessage =
  | { type: "render" | "update"; payload?: NotePayload }
  | { type: "hydrate_plugin_ui"; payload?: { v: number; state: unknown } };

/**
 * @deprecated Legacy iframe bridge — use {@link useHostArchon} and React hosts.
 */
export interface ArchonIframeApi {
  postMessage: (data: unknown) => void;
  postPluginUiState?: (state: unknown) => void;
  notifyDisplayReady?: () => void;
  saveNoteContent?: (content: string) => void;
  onMessage: ((msg: HostToPluginMessage) => void) | null;
}

declare global {
  interface Window {
    /** Full API; iframe bridge historically used a narrower shape. */
    Archon: ArchonRendererApi;
  }
}

/**
 * @deprecated Legacy iframe helper.
 */
export function getArchonIframeApi(): ArchonIframeApi | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return getArchon() as unknown as ArchonIframeApi;
}

/**
 * @deprecated Legacy iframe bridge. Methods are no-ops against the modern `ArchonRendererApi` contract
 * and are kept only so old plugin bundles don't throw at import time.
 */
export function useArchonIframeApi(): {
  postMessage: (data: unknown) => void;
  postPluginUiState: (state: unknown) => void;
  notifyDisplayReady: () => void;
  saveNoteContent: (content: string) => void;
} {
  return useMemo(
    () => ({
      postMessage: (data: unknown) => {
        const api = getArchon() as unknown as { postMessage?: (data: unknown) => void } | undefined;
        api?.postMessage?.(data);
      },
      postPluginUiState: (state: unknown) => {
        const api = getArchon() as unknown as { postPluginUiState?: (s: unknown) => void } | undefined;
        api?.postPluginUiState?.(state);
      },
      notifyDisplayReady: () => {
        const api = getArchon() as unknown as { notifyDisplayReady?: () => void } | undefined;
        api?.notifyDisplayReady?.();
      },
      saveNoteContent: (content: string) => {
        const api = getArchon() as unknown as { saveNoteContent?: (c: string) => void } | undefined;
        api?.saveNoteContent?.(content);
      },
    }),
    [],
  );
}

export interface UseArchonHostMessagesOptions {
  onHydratePluginUi?: (state: unknown) => void;
  onNotePayload?: (payload: NotePayload) => void;
}

/**
 * @deprecated Legacy iframe protocol — prefer direct React props / hooks.
 */
export function useArchonHostMessages(options: UseArchonHostMessagesOptions): void {
  const { onHydratePluginUi, onNotePayload } = options;

  useEffect(() => {
    const iframeApi = getArchon() as unknown as ArchonIframeApi;
    iframeApi.onMessage = (message: HostToPluginMessage) => {
      if (message.type === "hydrate_plugin_ui") {
        const p = message.payload;
        if (p && typeof p === "object" && "state" in p) {
          onHydratePluginUi?.(p.state);
        }
        return;
      }
      if (message.type === "update" || message.type === "render") {
        const payload = message.payload;
        if (payload) {
          onNotePayload?.(payload);
        }
      }
    };
    return () => {
      iframeApi.onMessage = null;
    };
  }, [onHydratePluginUi, onNotePayload]);
}

export interface UseNotifyDisplayReadyOptions {
  enabled?: boolean;
}

/**
 * @deprecated Legacy iframe display gate.
 */
export function useNotifyDisplayReady(options?: UseNotifyDisplayReadyOptions): void {
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        (getArchon() as unknown as ArchonIframeApi)?.notifyDisplayReady?.();
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [enabled]);
}
