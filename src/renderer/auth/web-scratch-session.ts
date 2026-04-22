/**
 * Web try-out session flag (localStorage only). Split from `web-scratch.ts` so Redux/store
 * modules can import this without pulling async RxDB migration code — reduces Turbopack HMR
 * “deleted module” churn when `cloudNotesSlice` hot reloads.
 */
export const WEB_SCRATCH_SESSION_KEY = "archon.web.scratchSession";

/** RxDB / Dexie database segment for offline cloud notes while signed out (web scratch). */
export const WEB_SCRATCH_CLOUD_USER_ID = "__archon_web_scratch__";

function migrateLegacyScratchSessionFromSessionStorage(): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  const legacy = sessionStorage.getItem(WEB_SCRATCH_SESSION_KEY);
  if (legacy === "1") {
    localStorage.setItem(WEB_SCRATCH_SESSION_KEY, "1");
    sessionStorage.removeItem(WEB_SCRATCH_SESSION_KEY);
  }
}

export function isWebScratchSession(): boolean {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return false;
  }
  migrateLegacyScratchSessionFromSessionStorage();
  return localStorage.getItem(WEB_SCRATCH_SESSION_KEY) === "1";
}

export function setWebScratchSession(enabled: boolean): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return;
  }
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.removeItem(WEB_SCRATCH_SESSION_KEY);
  }
  if (enabled) {
    localStorage.setItem(WEB_SCRATCH_SESSION_KEY, "1");
  } else {
    localStorage.removeItem(WEB_SCRATCH_SESSION_KEY);
  }
}
