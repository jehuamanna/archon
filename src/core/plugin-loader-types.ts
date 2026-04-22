export type PluginMode = "development" | "production";
export type PluginType = "ui" | "backend" | "hybrid";

/** Host visibility tier (orthogonal to manifest `type` ui/backend/hybrid). */
export type PluginHostTier = "system" | "core" | "user";

export type Permission =
  | "storage.read"
  | "storage.write"
  | "db.read"
  | "db.write"
  | "fs.read"
  | "fs.write"
  | "network.http"
  | "ui.panel"
  | "ui.toolbar";

export interface NetworkConfig {
  whitelist?: string[];
  requestApproval?: boolean;
  rateLimit?: {
    requestsPerMinute?: number;
    requestsPerHour?: number;
  };
}

export interface PluginManifest {
  name: string;
  version: string;
  type: PluginType;
  main: string;
  mode: PluginMode;

  displayName?: string;
  description?: string;
  author?: string;
  license?: string;
  ui?: string;
  html?: string;
  rootId?: string;
  noteTypes?: string[];
  permissions?: Permission[];
  activationEvents?: string[];
  icon?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  assets?: string[];
  workers?: string[];
  network?: NetworkConfig;
  theme?: "inherit" | "isolated";
  designSystemVersion?: string;
  deferDisplayUntilContentReady?: boolean;
  /**
   * Only honored for plugins under bundled core roots; user-installed plugins are always `user`.
   * `system` — hidden from Plugins UI and from “new note” type pickers (e.g. code editor).
   * `core` — hidden from Plugins UI; note types still appear in pickers.
   * Default for bundled plugins without this field: `core`.
   */
  hostTier?: PluginHostTier;
}

export interface ArchonAPI {
  ui: {
    registerComponent: (type: string, componentCode: string) => void;
  };
}

export interface Plugin {
  activate?: (Archon: ArchonAPI) => void;
  deactivate?: () => void;
}
