/**
 * localStorage flag: anonymous web “try the app” session (try-out notes in IndexedDB until login).
 * Session helpers live in {@link ./web-scratch-session} so store code can import them without RxDB.
 */
import {
  WEB_SCRATCH_CLOUD_USER_ID,
  WEB_SCRATCH_SESSION_KEY,
  isWebScratchSession,
  setWebScratchSession,
} from "./web-scratch-session";

export {
  WEB_SCRATCH_CLOUD_USER_ID,
  WEB_SCRATCH_SESSION_KEY,
  isWebScratchSession,
  setWebScratchSession,
};

/** Leave try-out UI and return to the marketing page; try-out data stays in this browser (localStorage + IndexedDB). */
export function exitWebScratchKeepData(): void {
  setWebScratchSession(false);
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

/** Clear try-out localStorage + IndexedDB, then start a fresh try-out session (reload). */
export async function resetWebScratchClearLocalData(): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }
  const { destroyCloudNotesDbForUser } = await import("../cloud-sync/cloud-notes-rxdb");
  await destroyCloudNotesDbForUser(WEB_SCRATCH_CLOUD_USER_ID);
  setWebScratchSession(true);
  window.location.reload();
}
