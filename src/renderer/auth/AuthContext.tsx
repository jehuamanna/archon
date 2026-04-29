import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { authLogin, authLogout, authRefresh } from "./auth-client";
import { setAccessToken, type AuthUser } from "./auth-session";
import {
  isElectronUserAgent,
  archonWebBackendSyncOnly,
  syncWpnUsesSyncApi,
} from "../archon-web-shim";
import { isWebScratchSession } from "./web-scratch";
import { syncElectronCloudWpnOverlayFromRunMode } from "../bootstrap/electron-cloud-wpn-bootstrap";
import {
  clearElectronRunMode,
  readElectronRunMode,
  writeElectronRunMode,
  type ElectronRunMode,
  type ElectronRunModeChoice,
} from "./electron-run-mode";
import { store } from "../store";
import {
  cloudLoginThunk,
  cloudLogoutThunk,
  cloudRestoreSessionThunk,
} from "../store/cloudAuthSlice";
import { fetchNotificationsThunk } from "../store/notificationsSlice";
import { consumePostAuthRedirectAfterSignIn } from "./post-auth-redirect";

const LOCAL_AUTH_USER: AuthUser = {
  id: "local",
  email: "local@archon",
  username: "local",
  isAdmin: true,
};

type AuthState =
  | { status: "loading"; user: null }
  | { status: "authed"; user: AuthUser }
  | { status: "anon"; user: null };

type WebAuthOverlayMode = "login";

type AuthContextValue = {
  state: AuthState;
  /** Electron only; always `"unset"` in the browser. */
  electronRunMode: ElectronRunMode;
  chooseElectronRunMode: (mode: ElectronRunModeChoice) => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  setAnon: () => void;
  /** Web only: full-screen login/signup over the shell (e.g. from Notes explorer). */
  webAuthOverlay: WebAuthOverlayMode | null;
  openWebAuth: (mode: WebAuthOverlayMode) => void;
  closeWebAuth: () => void;
  /** Electron Notes: overlay for sync API sign-in / register. */
  electronSyncOverlay: WebAuthOverlayMode | null;
  openElectronSyncAuth: (mode: WebAuthOverlayMode) => void;
  closeElectronSyncAuth: () => void;
  /** Electron only: leave workbench and return to the welcome screen (does not quit the app). */
  exitElectronSessionToWelcome: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return v;
}

function initialAuthState(): AuthState {
  if (typeof window === "undefined") {
    return { status: "loading", user: null };
  }
  if (isElectronUserAgent()) {
    const mode = readElectronRunMode();
    if (mode === "local") {
      return { status: "authed", user: LOCAL_AUTH_USER };
    }
    if (mode === "scratch" || mode === "cloud") {
      return { status: "anon", user: null };
    }
    return { status: "anon", user: null };
  }
  return { status: "loading", user: null };
}

function webUsesSyncServiceAuth(): boolean {
  if (typeof window === "undefined" || isElectronUserAgent()) {
    return false;
  }
  return archonWebBackendSyncOnly() || syncWpnUsesSyncApi();
}

function authUserFromSyncCredentials(userId: string, email: string): AuthUser {
  const localPart = email.includes("@") ? email.slice(0, email.indexOf("@")) : email;
  return { id: userId, email, username: localPart || "user" };
}

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [electronRunMode, setElectronRunModeState] = useState<ElectronRunMode>(() =>
    typeof window === "undefined" ? "unset" : isElectronUserAgent()
      ? readElectronRunMode()
      : "unset",
  );
  const [state, setState] = useState<AuthState>(initialAuthState);
  const [webAuthOverlay, setWebAuthOverlay] = useState<WebAuthOverlayMode | null>(null);
  const [electronSyncOverlay, setElectronSyncOverlay] = useState<WebAuthOverlayMode | null>(null);

  useEffect(() => {
    if (state.status === "authed") {
      setWebAuthOverlay(null);
    }
  }, [state.status]);

  /** Align main-process vault guards + HTTP WPN overlay with persisted run mode (e.g. cloud on file-argv). */
  useEffect(() => {
    if (typeof window === "undefined" || !isElectronUserAgent()) {
      return;
    }
    void (async () => {
      const { getArchon } = await import("../../shared/archon-host-access");
      const archon = getArchon();
      if (readElectronRunMode() === "cloud") {
        syncElectronCloudWpnOverlayFromRunMode();
        await archon.setElectronWpnBackendForSession("cloud");
      } else {
        await archon.setElectronWpnBackendForSession("file");
      }
      syncElectronCloudWpnOverlayFromRunMode();
    })();
  }, []);

  const refreshSession = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (isElectronUserAgent()) {
      return;
    }
    if (archonWebBackendSyncOnly() || syncWpnUsesSyncApi()) {
      setState({ status: "loading", user: null });
      try {
        const result = await store.dispatch(cloudRestoreSessionThunk());
        if (cloudRestoreSessionThunk.fulfilled.match(result) && result.payload) {
          const { userId, email } = result.payload;
          setState({ status: "authed", user: authUserFromSyncCredentials(userId, email) });
          void store.dispatch(fetchNotificationsThunk());
          return;
        }
      } catch {
        /* fall through */
      }
      setAccessToken(null);
      setState({ status: "anon", user: null });
      return;
    }
    setState({ status: "loading", user: null });
    try {
      const u = await authRefresh();
      setState({ status: "authed", user: u });
    } catch {
      setAccessToken(null);
      setState({ status: "anon", user: null });
    }
  }, []);

  useEffect(() => {
    void (async () => {
      if (typeof window === "undefined") return;
      if (isElectronUserAgent()) {
        return;
      }
      if (archonWebBackendSyncOnly() || syncWpnUsesSyncApi()) {
        try {
          const result = await store.dispatch(cloudRestoreSessionThunk());
          if (cloudRestoreSessionThunk.fulfilled.match(result) && result.payload) {
            const { userId, email } = result.payload;
            setState({ status: "authed", user: authUserFromSyncCredentials(userId, email) });
            return;
          }
        } catch {
          /* fall through */
        }
        setState({ status: "anon", user: null });
        return;
      }
      try {
        const u = await authRefresh();
        setState({ status: "authed", user: u });
        return;
      } catch {
        /* fall through */
      }
      setState({ status: "anon", user: null });
    })();
  }, []);

  const chooseElectronRunMode = useCallback((mode: ElectronRunModeChoice) => {
    void (async () => {
      writeElectronRunMode(mode);
      setElectronRunModeState(mode);
      setAccessToken(null);
      syncElectronCloudWpnOverlayFromRunMode();

      const { getArchon } = await import("../../shared/archon-host-access");
      const archon = getArchon();
      const argvCloud =
        typeof window !== "undefined" && window.__ARCHON_ELECTRON_WPN_BACKEND__ === "cloud";
      const wantsCloud = mode === "cloud";

      if (mode === "scratch") {
        try {
          await store.dispatch(cloudLogoutThunk()).unwrap();
        } catch {
          /* ignore: still proceed with scratch init */
        }
        try {
          const { destroyWpnScratchIndexedDb } = await import(
            "../wpnscratch/wpn-scratch-store"
          );
          await destroyWpnScratchIndexedDb();
        } catch {
          /* non-fatal: IDB may not exist yet */
        }
        try {
          await archon.clearElectronWorkspaceRoots();
        } catch {
          /* non-fatal */
        }
      }

      if (!wantsCloud && argvCloud) {
        await archon.openFileWpnWindowCloseSender();
        return;
      }

      await archon.setElectronWpnBackendForSession(wantsCloud ? "cloud" : "file");
      await archon.applyElectronPrimaryWpnBackend({
        backend: wantsCloud ? "cloud" : "file",
        relaunch: false,
      });

      try {
        await archon.reloadWindow();
      } catch {
        if (typeof window !== "undefined") {
          window.location.reload();
        }
      }
    })();
  }, []);

  const mergeWebScratchCloudNotesAfterAuth = useCallback(async (userId: string) => {
    if (isElectronUserAgent() || !isWebScratchSession()) {
      return;
    }
    const { migrateWebScratchCloudNotesToUser } = await import(
      "../cloud-sync/migrate-web-scratch-cloud-notes"
    );
    await migrateWebScratchCloudNotesToUser(userId);
    const { store: appStore } = await import("../store");
    const { cloudNotesSlice } = await import("../store/cloudNotesSlice");
    const { openCloudNotesDbForUser, rxdbFindAllCloudNotes } = await import(
      "../cloud-sync/cloud-notes-rxdb"
    );
    await openCloudNotesDbForUser(userId);
    const rows = await rxdbFindAllCloudNotes();
    appStore.dispatch(cloudNotesSlice.actions.hydrateFromRxDb({ rows }));
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      if (webUsesSyncServiceAuth()) {
        const result = await store.dispatch(cloudLoginThunk({ email, password }));
        if (cloudLoginThunk.rejected.match(result)) {
          throw new Error(result.error.message ?? "Login failed");
        }
        if (typeof window !== "undefined" && !isElectronUserAgent()) {
          window.location.reload();
        }
        return;
      }
      const u = await authLogin({ email, password });
      if (typeof window !== "undefined" && !isElectronUserAgent()) {
        window.location.reload();
      }
    },
    [],
  );

  const logout = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (isElectronUserAgent()) {
      return;
    }
    if (webUsesSyncServiceAuth()) {
      await store.dispatch(cloudLogoutThunk());
    } else {
      await authLogout();
    }
    setState({ status: "anon", user: null });
  }, []);

  const setAnon = useCallback(() => {
    setAccessToken(null);
    setState({ status: "anon", user: null });
  }, []);

  const openWebAuth = useCallback((mode: WebAuthOverlayMode) => {
    if (typeof window === "undefined" || isElectronUserAgent()) {
      return;
    }
    setWebAuthOverlay(mode);
  }, []);

  const closeWebAuth = useCallback(() => {
    setWebAuthOverlay(null);
  }, []);

  const openElectronSyncAuth = useCallback((mode: WebAuthOverlayMode) => {
    if (typeof window === "undefined" || !isElectronUserAgent()) {
      return;
    }
    setElectronSyncOverlay(mode);
  }, []);

  const closeElectronSyncAuth = useCallback(() => {
    setElectronSyncOverlay(null);
  }, []);

  const exitElectronSessionToWelcome = useCallback(() => {
    if (typeof window === "undefined" || !isElectronUserAgent()) {
      return;
    }
    void (async () => {
      try {
        await store.dispatch(cloudLogoutThunk());
      } catch {
        /* still leave workbench */
      }
      clearElectronRunMode();
      setElectronRunModeState("unset");
      setAccessToken(null);
      setElectronSyncOverlay(null);
      setState({ status: "anon", user: null });
      const { getArchon } = await import("../../shared/archon-host-access");
      const archon = getArchon();
      if (typeof window !== "undefined" && window.__ARCHON_ELECTRON_WPN_BACKEND__ === "cloud") {
        await archon.openFileWpnWindowCloseSender();
        return;
      }
      await archon.setElectronWpnBackendForSession("file");
      syncElectronCloudWpnOverlayFromRunMode();
      await archon.applyElectronPrimaryWpnBackend({ backend: "file", relaunch: false });
      try {
        await archon.reloadWindow();
      } catch {
        window.location.reload();
      }
    })();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      electronRunMode: isElectronUserAgent() ? electronRunMode : "unset",
      chooseElectronRunMode,
      login,
      logout,
      refreshSession,
      setAnon,
      webAuthOverlay,
      openWebAuth,
      closeWebAuth,
      electronSyncOverlay,
      openElectronSyncAuth,
      closeElectronSyncAuth,
      exitElectronSessionToWelcome,
    }),
    [
      state,
      electronRunMode,
      chooseElectronRunMode,
      login,
      logout,
      refreshSession,
      setAnon,
      webAuthOverlay,
      openWebAuth,
      closeWebAuth,
      electronSyncOverlay,
      openElectronSyncAuth,
      closeElectronSyncAuth,
      exitElectronSessionToWelcome,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
