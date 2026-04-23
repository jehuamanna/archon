import { archonDelegatingProxy } from "../../shared/archon-host-access";
import { configureStore } from "@reduxjs/toolkit";
import { createArchonPlatformDeps } from "@archon/platform";
import {
  initHeadlessWebApiBaseFromUrlAndStorage,
  installArchonWebShimIfNeeded,
} from "../archon-web-shim";
import {
  notifySyncSessionInvalidated,
  setSyncSessionInvalidatedHandler,
} from "../sync-session-invalidation";
import { setRefreshSessionDeps } from "../auth/refresh-session";
import { setSessionTerminationDeps, terminateSession } from "../auth/session-termination";
import { setSilentRefreshSchedulerDeps } from "../auth/silent-refresh-scheduler";
import cloudAuthReducer, {
  authTerminationCompleted,
  authTerminationStarted,
  sessionRefreshEnded,
  sessionRefreshStarted,
  sessionTokensRotated,
} from "./cloudAuthSlice";
import { resetCloudNotes } from "./cloudNotesSlice";
import { clearOrgMembership } from "./orgMembershipSlice";
import { clearSpaceMembership } from "./spaceMembershipSlice";
import cloudNotesReducer from "./cloudNotesSlice";
import { cloudNotesRxListener } from "./cloudNotesRxListener";
import notesReducer from "./notesSlice";
import notificationsReducer from "./notificationsSlice";
import orgMembershipReducer from "./orgMembershipSlice";
import pluginUiReducer from "./pluginUiSlice";
import spaceMembershipReducer from "./spaceMembershipSlice";

/**
 * Next / browser: other modules may import `store` before any client entry runs; `createArchonPlatformDeps`
 * needs `archonDelegatingProxy` / `window.Archon`. Electron preload sets `Archon` first; `installArchonWebShimIfNeeded` is a no-op then.
 */
if (typeof window !== "undefined") {
  try {
    initHeadlessWebApiBaseFromUrlAndStorage();
  } catch {
    /* ignore */
  }
  installArchonWebShimIfNeeded();
}

/** Single instance: Redux thunks and optional desktop sync nudge share this. */
export const platformDeps = createArchonPlatformDeps({
  notes: archonDelegatingProxy,
  onSyncSessionInvalidated: notifySyncSessionInvalidated,
});

export const store = configureStore({
  reducer: {
    notes: notesReducer,
    pluginUi: pluginUiReducer,
    cloudNotes: cloudNotesReducer,
    cloudAuth: cloudAuthReducer,
    notifications: notificationsReducer,
    orgMembership: orgMembershipReducer,
    spaceMembership: spaceMembershipReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      thunk: { extraArgument: platformDeps },
    }).prepend(cloudNotesRxListener.middleware),
});

setSessionTerminationDeps({
  store,
  remoteApi: platformDeps.remoteApi,
  resetCloudNotes,
  clearOrgMembership,
  clearSpaceMembership,
  authTerminationStarted,
  authTerminationCompleted,
});

setSyncSessionInvalidatedHandler(() => {
  void terminateSession("session_expired");
});

setRefreshSessionDeps({
  remoteApi: platformDeps.remoteApi,
  onTokensRotated: ({ accessToken }) => {
    // Let listener middleware (and any UI observers) know claims may have
    // changed; org/space bookkeeping was already updated by refreshSessionOnce.
    void accessToken;
    store.dispatch(sessionTokensRotated({}));
  },
});

setSilentRefreshSchedulerDeps({
  onRefreshEvent: (event) => {
    if (event.kind === "started") store.dispatch(sessionRefreshStarted());
    else store.dispatch(sessionRefreshEnded());
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
