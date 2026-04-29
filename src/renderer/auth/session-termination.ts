import type { ArchonPlatformDeps } from "@archon/platform";
import { closeCloudNotesDb } from "../cloud-sync/cloud-notes-rxdb";
import {
  writeCloudSyncEmail,
  writeCloudSyncRefreshToken,
  writeCloudSyncToken,
} from "../cloud-sync/cloud-sync-storage";
import { clearAllElectronAppPinSettings } from "./electron-app-pin-storage";
import { clearPersistedWebSyncWpnPreference } from "../archon-web-shim";
import { showGlobalToast } from "../toast/toast-service";
import {
  setAccessToken,
  setActiveOrgId,
  setActiveSpaceId,
  setActiveTeamId,
} from "./auth-session";
import { stopSilentRefreshScheduler } from "./silent-refresh-scheduler";

export type TerminationReason =
  | "session_expired"
  | "refresh_failed_network"
  | "user_logout"
  | "stale_state";

type Store = {
  dispatch: (action: unknown) => unknown;
  getState: () => unknown;
};

type Deps = {
  store: Store;
  remoteApi: ArchonPlatformDeps["remoteApi"];
  resetCloudNotes: () => { type: string };
  clearOrgMembership: () => { type: string };
  clearSpaceMembership: () => { type: string };
  clearTeam: () => { type: string };
  clearDepartment: () => { type: string };
  authTerminationStarted: (reason: TerminationReason) => { type: string };
  authTerminationCompleted: () => { type: string };
};

let deps: Deps | null = null;
let inProgress = false;
let broadcastChannel: BroadcastChannel | null = null;

export function setSessionTerminationDeps(next: Deps): void {
  deps = next;
  ensureBroadcastWired();
}

function ensureBroadcastWired(): void {
  if (broadcastChannel) return;
  if (typeof BroadcastChannel === "undefined") return;
  try {
    broadcastChannel = new BroadcastChannel("archon-auth");
    broadcastChannel.addEventListener("message", (event) => {
      const msg = event.data as { type?: unknown; reason?: unknown } | null;
      if (msg && msg.type === "session-terminated") {
        // Another tab already terminated. Silently mirror so this tab also
        // lands on the signed-out UI without a toast (that tab already showed one).
        void terminateSession("session_expired", { silent: true });
      }
    });
  } catch {
    broadcastChannel = null;
  }
}

function humanizeReason(reason: TerminationReason): string {
  switch (reason) {
    case "session_expired":
      return "Your session expired. Please sign in again.";
    case "refresh_failed_network":
      return "Connection lost. Please sign in again.";
    case "user_logout":
      return "You were signed out.";
    case "stale_state":
      return "";
  }
}

export type TerminateSessionOptions = {
  /** Suppress the user-visible toast (used for cross-tab mirroring). */
  silent?: boolean;
  /** Don't broadcast to sibling tabs (used when the trigger was itself a broadcast). */
  skipBroadcast?: boolean;
};

export async function terminateSession(
  reason: TerminationReason,
  opts: TerminateSessionOptions = {},
): Promise<void> {
  if (!deps) {
    // Not initialised yet — no state to clear.
    return;
  }
  if (inProgress) return;
  inProgress = true;
  try {
    deps.store.dispatch(deps.authTerminationStarted(reason));
    stopSilentRefreshScheduler();
    try {
      await closeCloudNotesDb();
    } catch {
      /* non-fatal */
    }
    writeCloudSyncToken(null);
    writeCloudSyncRefreshToken(null);
    // Keep email in storage for the login screen to pre-fill; mirror cloudLogoutThunk
    // behavior only when the reason is an explicit user logout.
    if (reason === "user_logout") {
      writeCloudSyncEmail(null);
    }
    try {
      deps.remoteApi.setAuthToken(null);
      deps.remoteApi.setRefreshToken(null);
    } catch {
      /* ignore */
    }
    setAccessToken(null);
    clearAllElectronAppPinSettings();
    setActiveOrgId(null);
    setActiveSpaceId(null);
    setActiveTeamId(null);
    deps.store.dispatch(deps.resetCloudNotes());
    deps.store.dispatch(deps.clearOrgMembership());
    deps.store.dispatch(deps.clearSpaceMembership());
    deps.store.dispatch(deps.clearTeam());
    deps.store.dispatch(deps.clearDepartment());
    clearPersistedWebSyncWpnPreference();
    deps.store.dispatch(deps.authTerminationCompleted());

    if (!opts.skipBroadcast) {
      try {
        broadcastChannel?.postMessage({ type: "session-terminated", reason });
      } catch {
        /* ignore */
      }
    }

    if (!opts.silent) {
      const text = humanizeReason(reason);
      if (text.length > 0) {
        try {
          showGlobalToast({
            severity: reason === "user_logout" ? "info" : "warning",
            message: text,
            mergeKey: "session-termination",
          });
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    inProgress = false;
  }
}

export function isSessionTerminationInProgress(): boolean {
  return inProgress;
}
