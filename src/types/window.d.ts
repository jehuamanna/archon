import type { ArchonDevtoolsShellApi } from "../renderer/shell/devtoolsShellExpose";
import type { ArchonRendererApi } from "../shared/archon-renderer-api";
import type { WorkspaceRxdbMirrorPayloadV1 } from "../shared/workspace-rxdb-mirror-payload";

/** `window.archon.shell` / `window.archon.devtools` (devtools is an alias when the shell API is mounted). */
type ArchonWindowGlobal = {
  shell?: ArchonDevtoolsShellApi;
  devtools?: ArchonDevtoolsShellApi;
};

/** Preload `contextBridge` API for `@archon/platform` DesktopHost (sync nudge from main). */
type ArchonDesktopBridge = {
  onSyncTrigger: (callback: () => void) => () => void;
  /** After main `WorkspaceStore.persist` (MCP, in-app WPN writes). */
  onWorkspaceWpnPersisted?: (callback: () => void) => () => void;
  onWorkspaceRxdbMirrorUpdated?: (
    callback: (payload: WorkspaceRxdbMirrorPayloadV1) => void,
  ) => () => void;
};

declare global {
  interface Window {
    Archon: ArchonRendererApi;
    archonDesktop?: ArchonDesktopBridge;
    /**
     * Host-injected namespace (shell devtools API, notebook helpers, etc.).
     * Intersection with `Record` allows extra keys without widening `shell`/`devtools` to `unknown`.
     */
    archon?: ArchonWindowGlobal & Record<string, unknown>;
    /** Set in plugin sandbox HTML; pdf.js worker URL (`archon-pdf-worker:`). */
    __ARCHON_PDFJS_WORKER_SRC__?: string;
    /** Base URL of the headless HTTP API (no trailing slash); from query, localStorage, or the web API bar. */
    __ARCHON_WEB_API_BASE__?: string;
    /** Base URL of the Fastify Mongo sync API (`@archon/sync-api`), no trailing slash. */
    __ARCHON_SYNC_API_BASE__?: string;
    /**
     * When true (or `NEXT_PUBLIC_ARCHON_WPN_USE_SYNC_API=1`), `window.Archon` WPN calls use the sync API
     * (`/wpn/*` on sync base + cloud JWT) instead of headless `/api/v1/wpn/*`.
     */
    __ARCHON_WPN_USE_SYNC_API__?: boolean;
    /**
     * Electron only: per-window WPN backend from `webPreferences.additionalArguments`
     * (`--archon-electron-wpn-backend=file|cloud`). Preload exposes this for the renderer.
     */
    __ARCHON_ELECTRON_WPN_BACKEND__?: "file" | "cloud";
  }
}

export {};
