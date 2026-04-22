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
import cloudAuthReducer, { cloudLogoutThunk } from "./cloudAuthSlice";
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

setSyncSessionInvalidatedHandler(() => {
  void store.dispatch(cloudLogoutThunk());
  if (typeof window !== "undefined") {
    window.location.replace("/");
  }
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
