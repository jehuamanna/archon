import type {
  DesktopHost,
  LocalStore,
  ArchonPlatformDeps,
  NotesPersistencePort,
  RemoteApi,
} from "./ports";
import type { SyncPullResponse, SyncPushResponse } from "./sync-types";
import { createFetchRemoteApi } from "./remote-fetch";
import { createSyncBaseUrlResolver } from "./resolve-sync-base";

function isElectronUserAgent(): boolean {
  return (
    typeof navigator !== "undefined" && navigator.userAgent.includes("Electron")
  );
}

/** No remote URL: sync no-ops; auth throws. */
export function createStubRemoteApi(): RemoteApi {
  let token: string | null = null;
  const needUrl = (): never => {
    throw new Error("Archon sync API URL is not configured");
  };
  return {
    getBaseUrl: () => "",
    setAuthToken: (t) => {
      token = t;
    },
    setRefreshToken: () => {},
    authRegister: () => needUrl(),
    authLogin: () => needUrl(),
    authRefresh: () => needUrl(),
    authMe: () => needUrl(),
    authChangePassword: () => needUrl(),
    syncPush: async (): Promise<SyncPushResponse> => {
      void token;
      return { accepted: [], conflicts: [] };
    },
    syncPull: async (): Promise<SyncPullResponse> => ({
      documents: [],
      lastSync: Date.now(),
    }),
  };
}

export function createNoopDesktopHost(): DesktopHost {
  return {
    isElectron: false,
    onSyncTrigger: () => () => {},
  };
}

export function createElectronDesktopHost(): DesktopHost {
  return {
    isElectron: true,
    onSyncTrigger: (callback) => {
      const w = globalThis as unknown as {
        archonDesktop?: { onSyncTrigger?: (cb: () => void) => () => void };
      };
      const bridge = w.archonDesktop?.onSyncTrigger;
      if (typeof bridge === "function") {
        return bridge(callback);
      }
      return () => {};
    },
  };
}

function notesPortFromArchonGlobal(): NotesPersistencePort {
  if (typeof window === "undefined") {
    throw new Error("@archon/platform: window.Archon is not available in this context");
  }
  const archon = (window as unknown as { Archon?: NotesPersistencePort }).Archon;
  if (!archon) {
    throw new Error(
      "@archon/platform: window.Archon is missing — install preload or web shim before Redux store init",
    );
  }
  return archon;
}

export function createWebThinLocalStore(
  notes?: NotesPersistencePort,
): LocalStore {
  return {
    profile: "web-thin",
    notes: notes ?? notesPortFromArchonGlobal(),
  };
}

export function createElectronOfflineFirstLocalStore(
  notes?: NotesPersistencePort,
): LocalStore {
  return {
    profile: "electron-offline-first",
    notes: notes ?? notesPortFromArchonGlobal(),
  };
}

export interface CreateArchonPlatformDepsOptions {
  /** Override notes backend (tests). */
  notes?: NotesPersistencePort;
  /** Force profile (tests). */
  profile?: "web" | "electron";
  /** Highest-priority sync API base URL (no trailing slash); empty falls through to env. */
  getSyncApiBaseUrl?: () => string;
  /** After the sync client clears tokens (401 + refresh failed, or 401 after refresh retry). */
  onSyncSessionInvalidated?: () => void;
}

/**
 * Compose platform deps for the current runtime.
 * - Web PWA: server-first mental model; `LocalStore` stays thin (delegates to `window.Archon` web shim).
 * - Electron: local-first target (RxDB migration hooks into same port later); `DesktopHost` exposes IPC when preload adds `window.archonDesktop.onSyncTrigger`.
 */
export function createArchonPlatformDeps(
  options: CreateArchonPlatformDepsOptions = {},
): ArchonPlatformDeps {
  const profile =
    options.profile ?? (isElectronUserAgent() ? "electron" : "web");
  const getBase = createSyncBaseUrlResolver(options.getSyncApiBaseUrl);
  const remoteApi = createFetchRemoteApi(getBase, {
    onSessionInvalidated: options.onSyncSessionInvalidated,
  });
  const localStore =
    profile === "electron"
      ? createElectronOfflineFirstLocalStore(options.notes)
      : createWebThinLocalStore(options.notes);
  const desktopHost =
    profile === "electron" ? createElectronDesktopHost() : createNoopDesktopHost();

  return {
    profile,
    remoteApi,
    localStore,
    desktopHost,
  };
}
