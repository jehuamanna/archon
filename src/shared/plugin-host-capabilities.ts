import type { ArchonRendererApi } from "./archon-renderer-api";

/**
 * Narrow capability surface exposed to plugin sandboxes (SES compartments) and
 * documented for plugin authors. Full renderer API: {@link ArchonRendererApi}.
 */
export type MediatedFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type PluginHostCapabilities = {
  /** API version for compatibility checks between host and plugin bundles. */
  readonly apiVersion: string;
  /** Project / note operations — backed by IPC (Electron) or HTTP (web). */
  readonly archon: ArchonRendererApi;
  /** Network: prefer this over raw fetch inside sandboxes; host may enforce policy. */
  readonly fetch: MediatedFetch;
};
