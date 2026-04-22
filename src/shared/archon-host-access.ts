import type { ArchonRendererApi } from "./archon-renderer-api";
import { wpnTrace } from "./wpn-debug-trace";

/**
 * Electron `contextBridge.exposeInMainWorld("Archon", …)` makes `window.Archon` non-writable.
 * Optional IndexedDB scratch (merged API) is held here; {@link getArchon} / {@link archonDelegatingProxy}
 * forward to the overlay when set, otherwise to `window.Archon`.
 */
let electronIdbScratchOverlay: ArchonRendererApi | null = null;

/** Electron cloud WPN window: merged API (HTTP WPN + host IPC for plugins/files). */
let electronCloudWpnOverlay: ArchonRendererApi | null = null;

/** ADR-016: local RxDB mirror read overlay (file vault + `ARCHON_LOCAL_RXDB_WPN`). */
let electronWorkspaceRxdbOverlay: ArchonRendererApi | null = null;

export function setElectronIdbScratchOverlay(api: ArchonRendererApi | null): void {
  electronIdbScratchOverlay = api;
}

export function setElectronCloudWpnOverlay(api: ArchonRendererApi | null): void {
  electronCloudWpnOverlay = api;
}

export function setElectronWorkspaceRxdbOverlay(api: ArchonRendererApi | null): void {
  electronWorkspaceRxdbOverlay = api;
}

function activeArchonImpl(): ArchonRendererApi {
  if (typeof window === "undefined") {
    throw new Error("Archon: window is not available");
  }
  const bridged = window.Archon;
  if (!bridged) {
    throw new Error("Archon: window.Archon is missing — install preload or web shim before use");
  }
  return (
    electronCloudWpnOverlay ??
    electronIdbScratchOverlay ??
    electronWorkspaceRxdbOverlay ??
    bridged
  );
}

/**
 * Prefer this over `window.Archon` in the renderer so Electron IDB scratch can supply a merged API
 * without reassigning `window.Archon`.
 */
export function getArchon(): ArchonRendererApi {
  return archonDelegatingProxy;
}

/** Stable reference for Redux `createArchonPlatformDeps({ notes: archonDelegatingProxy })`. */
function overlayLabel(impl: ArchonRendererApi): string {
  if (electronCloudWpnOverlay && impl === electronCloudWpnOverlay) return "cloud";
  if (electronIdbScratchOverlay && impl === electronIdbScratchOverlay) return "idb";
  if (electronWorkspaceRxdbOverlay && impl === electronWorkspaceRxdbOverlay) return "rxdb";
  return "bridged";
}

export const archonDelegatingProxy = new Proxy({} as ArchonRendererApi, {
  get(_target, prop, _receiver) {
    if (prop === "then") {
      return undefined;
    }
    const impl = activeArchonImpl();
    const value = Reflect.get(impl, prop, impl);
    if (typeof value === "function" && typeof prop === "string" && prop.startsWith("wpn")) {
      wpnTrace("getArchon.dispatch", { method: prop, overlay: overlayLabel(impl) });
    }
    if (typeof value === "function") {
      return (value as (...args: unknown[]) => unknown).bind(impl);
    }
    return value;
  },
}) as ArchonRendererApi;
