import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import type { ArchonPlatformDeps } from "@archon/platform";
import { closeCloudNotesDb } from "../cloud-sync/cloud-notes-rxdb";
import {
  readCloudSyncEmail,
  readCloudSyncRefreshToken,
  readCloudSyncToken,
  writeCloudSyncEmail,
  writeCloudSyncRefreshToken,
  writeCloudSyncToken,
} from "../cloud-sync/cloud-sync-storage";
import { clearAllElectronAppPinSettings } from "../auth/electron-app-pin-storage";
import { setAccessToken, setActiveOrgId, setActiveSpaceId } from "../auth/auth-session";
import { decodeJwtPayload } from "../auth/jwt-exp";
import { clearPersistedWebSyncWpnPreference } from "../archon-web-shim";
import {
  hydrateCloudNotesFromRxDbThunk,
  resetCloudNotes,
  runCloudSyncThunk,
} from "./cloudNotesSlice";
import { fetchNotificationsThunk } from "./notificationsSlice";
import { clearOrgMembership, setLocalActiveOrg } from "./orgMembershipSlice";
import { clearSpaceMembership, setLocalActiveSpace } from "./spaceMembershipSlice";
import { showGlobalToast } from "../toast/toast-service";

type CloudAuthThunkExtra = { extra: ArchonPlatformDeps };

function decodeAccessTokenClaims(
  token: string,
): { activeOrgId?: string; activeSpaceId?: string } | null {
  const obj = decodeJwtPayload(token);
  if (!obj) return null;
  return {
    activeOrgId: typeof obj.activeOrgId === "string" ? obj.activeOrgId : undefined,
    activeSpaceId: typeof obj.activeSpaceId === "string" ? obj.activeSpaceId : undefined,
  };
}

async function migrateWebScratchCloudNotesIfNeeded(realUserId: string): Promise<void> {
  if (typeof window === "undefined") return;
  const { isWebScratchSession } = await import("../auth/web-scratch-session");
  if (!isWebScratchSession()) return;
  const { migrateWebScratchCloudNotesToUser } = await import(
    "../cloud-sync/migrate-web-scratch-cloud-notes"
  );
  await migrateWebScratchCloudNotesToUser(realUserId);
}

export type CloudAuthState = {
  status: "signedOut" | "signedIn";
  userId: string | null;
  email: string | null;
  error: string | null;
  busy: boolean;
  /** True when the account was admin-issued a temp password that must be rotated. */
  mustSetPassword: boolean;
  /** Platform-wide master admin flag. Populated from /auth/me on session restore. */
  isMasterAdmin: boolean;
};

const initialState: CloudAuthState = {
  status: "signedOut",
  userId: null,
  email: null,
  error: null,
  busy: false,
  mustSetPassword: false,
  isMasterAdmin: false,
};

const cloudAuthSlice = createSlice({
  name: "cloudAuth",
  initialState,
  reducers: {
    /** Local flip after /auth/change-password succeeds so the gate unmounts without a reload. */
    clearMustSetPassword(state) {
      state.mustSetPassword = false;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(cloudRestoreSessionThunk.pending, (state) => {
        state.busy = true;
        state.error = null;
      })
      .addCase(cloudRestoreSessionThunk.fulfilled, (state, action) => {
        state.busy = false;
        if (action.payload) {
          state.status = "signedIn";
          state.userId = action.payload.userId;
          state.email = action.payload.email;
          state.mustSetPassword = action.payload.mustSetPassword === true;
          state.isMasterAdmin = action.payload.isMasterAdmin === true;
        } else {
          state.status = "signedOut";
          state.userId = null;
          state.email = null;
          state.mustSetPassword = false;
          state.isMasterAdmin = false;
        }
      })
      .addCase(cloudRestoreSessionThunk.rejected, (state) => {
        state.busy = false;
        state.status = "signedOut";
        state.userId = null;
        state.email = null;
        state.mustSetPassword = false;
        state.isMasterAdmin = false;
      })
      .addCase(cloudLoginThunk.pending, (state) => {
        state.busy = true;
        state.error = null;
      })
      .addCase(cloudLoginThunk.fulfilled, (state, action) => {
        state.busy = false;
        state.status = "signedIn";
        state.userId = action.payload.userId;
        state.email = action.payload.email;
        state.mustSetPassword = action.payload.mustSetPassword === true;
        state.isMasterAdmin = action.payload.isMasterAdmin === true;
      })
      .addCase(cloudLoginThunk.rejected, (state, action) => {
        state.busy = false;
        state.error = action.error.message ?? "Login failed";
      })
      .addCase(cloudRegisterThunk.pending, (state) => {
        state.busy = true;
        state.error = null;
      })
      .addCase(cloudRegisterThunk.fulfilled, (state, action) => {
        state.busy = false;
        state.status = "signedIn";
        state.userId = action.payload.userId;
        state.email = action.payload.email;
        state.mustSetPassword = false;
      })
      .addCase(cloudRegisterThunk.rejected, (state, action) => {
        state.busy = false;
        state.error = action.error.message ?? "Register failed";
      })
      .addCase(cloudLogoutThunk.fulfilled, () => initialState);
  },
});

export const { clearMustSetPassword } = cloudAuthSlice.actions;

export const cloudRestoreSessionThunk = createAsyncThunk<
  { userId: string; email: string; mustSetPassword: boolean; isMasterAdmin: boolean } | null,
  void,
  CloudAuthThunkExtra
>("cloudAuth/restore", async (_, { extra, dispatch }) => {
  if (!extra.remoteApi.getBaseUrl()) {
    return null;
  }
  const token = readCloudSyncToken();
  if (!token) {
    extra.remoteApi.setAuthToken(null);
    extra.remoteApi.setRefreshToken(null);
    return null;
  }
  extra.remoteApi.setAuthToken(token);
  extra.remoteApi.setRefreshToken(readCloudSyncRefreshToken());
  setAccessToken(token);
  const claims = decodeAccessTokenClaims(token);
  if (claims?.activeOrgId) {
    dispatch(setLocalActiveOrg({ orgId: claims.activeOrgId }));
  }
  if (claims?.activeSpaceId) {
    dispatch(setLocalActiveSpace({ spaceId: claims.activeSpaceId }));
  }
  try {
    const me = await extra.remoteApi.authMe();
    const email = me.email || readCloudSyncEmail();
    if (email) {
      writeCloudSyncEmail(email);
    }
    
    const userData = {
      userId: me.userId,
      email: me.email,
      mustSetPassword: me.mustSetPassword === true,
      isMasterAdmin: me.isMasterAdmin === true,
    };

    // Defer heavy operations to macrotask queue to allow UI to render first
    setTimeout(() => {
      void (async () => {
        try {
          showGlobalToast({
            severity: "info",
            message: "Setting up your workspace...",
            mergeKey: "sync-progress",
          });
          
          await migrateWebScratchCloudNotesIfNeeded(me.userId);
          
          showGlobalToast({
            severity: "info",
            message: "Loading notes from local storage...",
            mergeKey: "sync-progress",
          });
          
          await dispatch(
            hydrateCloudNotesFromRxDbThunk({ overrideStorageUserId: me.userId }),
          );
          
          showGlobalToast({
            severity: "info",
            message: "Syncing with server...",
            mergeKey: "sync-progress",
          });
          
          await dispatch(runCloudSyncThunk({ overrideStorageUserId: me.userId }));
          
          showGlobalToast({
            severity: "info",
            message: "✓ Sync complete!",
            mergeKey: "sync-complete",
          });
        } catch (err) {
          console.error("Background sync failed after login:", err);
          showGlobalToast({
            severity: "error",
            message: "Sync failed. You can retry from the sync menu.",
          });
        }
      })();
    }, 100); // 100ms delay allows browser to render UI first
    
    return userData;
  } catch (err) {
    console.error("Session restoration failed:", err);
    showGlobalToast({
      severity: "error",
      message: "Failed to restore session",
    });
    writeCloudSyncToken(null);
    writeCloudSyncRefreshToken(null);
    writeCloudSyncEmail(null);
    extra.remoteApi.setAuthToken(null);
    extra.remoteApi.setRefreshToken(null);
    setAccessToken(null);
    return null;
  }
});

export const cloudLoginThunk = createAsyncThunk<
  { userId: string; email: string; mustSetPassword: boolean; isMasterAdmin: boolean },
  { email: string; password: string },
  CloudAuthThunkExtra
>("cloudAuth/login", async ({ email, password }, { extra, dispatch }) => {
  const { token, refreshToken, userId, mustSetPassword } =
    await extra.remoteApi.authLogin(email, password);
  writeCloudSyncToken(token);
  writeCloudSyncRefreshToken(refreshToken);
  writeCloudSyncEmail(email.toLowerCase());
  extra.remoteApi.setAuthToken(token);
  extra.remoteApi.setRefreshToken(refreshToken);
  setAccessToken(token);
  const claims = decodeAccessTokenClaims(token);
  if (claims?.activeOrgId) {
    dispatch(setLocalActiveOrg({ orgId: claims.activeOrgId }));
  }
  if (claims?.activeSpaceId) {
    dispatch(setLocalActiveSpace({ spaceId: claims.activeSpaceId }));
  }
  let isMasterAdmin = false;
  try {
    const me = await extra.remoteApi.authMe();
    isMasterAdmin = me.isMasterAdmin === true;
  } catch {
    /* non-fatal */
  }
  void dispatch(fetchNotificationsThunk());
  return {
    userId,
    email: email.toLowerCase(),
    mustSetPassword: mustSetPassword === true,
    isMasterAdmin,
  };
});

export const cloudRegisterThunk = createAsyncThunk<
  { userId: string; email: string },
  { email: string; password: string },
  CloudAuthThunkExtra
>("cloudAuth/register", async ({ email, password }, { extra, dispatch }) => {
  const { token, refreshToken, userId } = await extra.remoteApi.authRegister(
    email,
    password,
  );
  writeCloudSyncToken(token);
  writeCloudSyncRefreshToken(refreshToken);
  writeCloudSyncEmail(email.toLowerCase());
  extra.remoteApi.setAuthToken(token);
  extra.remoteApi.setRefreshToken(refreshToken);
  setAccessToken(token);
  const claims = decodeAccessTokenClaims(token);
  if (claims?.activeOrgId) {
    dispatch(setLocalActiveOrg({ orgId: claims.activeOrgId }));
  }
  if (claims?.activeSpaceId) {
    dispatch(setLocalActiveSpace({ spaceId: claims.activeSpaceId }));
  }
  void dispatch(fetchNotificationsThunk());
  return { userId, email: email.toLowerCase() };
});

export const cloudLogoutThunk = createAsyncThunk<void, void, CloudAuthThunkExtra>(
  "cloudAuth/logout",
  async (_, { extra, dispatch }) => {
    await closeCloudNotesDb();
    writeCloudSyncToken(null);
    writeCloudSyncRefreshToken(null);
    writeCloudSyncEmail(null);
    extra.remoteApi.setAuthToken(null);
    extra.remoteApi.setRefreshToken(null);
    setAccessToken(null);
    clearAllElectronAppPinSettings();
    setActiveOrgId(null);
    setActiveSpaceId(null);
    dispatch(resetCloudNotes());
    dispatch(clearOrgMembership());
    dispatch(clearSpaceMembership());
    clearPersistedWebSyncWpnPreference();
  },
);

export default cloudAuthSlice.reducer;
