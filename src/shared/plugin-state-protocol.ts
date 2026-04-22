/**
 * Versioned contract for plugin iframe ↔ host UI state sync.
 * See claude-docs/architecture/notes.md
 */

/** Bump when snapshot shape or semantics change incompatibly. */
export const PLUGIN_UI_PROTOCOL_VERSION = 1 as const;

/** Reject snapshots larger than this (UTF-8 JSON byte length, approximate). */
export const MAX_PLUGIN_UI_PAYLOAD_BYTES = 512_000;

/** Key inside Note.metadata where the last persisted UI snapshot is stored. */
export const PLUGIN_UI_METADATA_KEY = "pluginUiState" as const;

export type PluginUiProtocolVersion = typeof PLUGIN_UI_PROTOCOL_VERSION;

/** Iframe → host: full replace of persisted plugin UI state for this note. */
export type PluginUiSnapshotMessage = {
  type: "plugin_ui_snapshot";
  v: PluginUiProtocolVersion;
  state: unknown;
};

/** Host → iframe: apply persisted state after load (optional; note in RENDER also carries metadata). */
export type HydratePluginUiMessage = {
  type: "hydrate_plugin_ui";
  v: PluginUiProtocolVersion;
  state: unknown;
};

export function isPluginUiSnapshotMessage(
  data: unknown,
): data is PluginUiSnapshotMessage {
  if (!data || typeof data !== "object") {
    return false;
  }
  const d = data as Record<string, unknown>;
  return (
    d.type === "plugin_ui_snapshot" &&
    d.v === PLUGIN_UI_PROTOCOL_VERSION &&
    "state" in d
  );
}

/** Returns error message or null if OK. */
export function validatePluginUiStateSize(state: unknown): string | null {
  try {
    const json = JSON.stringify(state);
    if (json.length > MAX_PLUGIN_UI_PAYLOAD_BYTES) {
      return `Plugin UI state exceeds max size (${MAX_PLUGIN_UI_PAYLOAD_BYTES} bytes)`;
    }
  } catch {
    return "Plugin UI state is not JSON-serializable";
  }
  return null;
}
