/**
 * Dev helpers: clear browser session/UI cache vs IndexedDB (RxDB / scratch WPN) vs both.
 * Used by command palette + minibuffer (`archon.dev.clearUi`, etc.).
 */
import {
  WEB_SCRATCH_CLOUD_USER_ID,
  WEB_SCRATCH_SESSION_KEY,
} from "../auth/web-scratch-session";

/** Same as {@link ARCHON_WEB_HEADLESS_API_STORAGE_KEY} in `archon-web-shim` (avoid importing the shim here). */
const ARCHON_WEB_HEADLESS_API_STORAGE_KEY = "archon-headless-api-base";
import { destroyCloudNotesDbForUser, getOpenCloudNotesUserId } from "../cloud-sync/cloud-notes-rxdb";
import {
  writeCloudSyncEmail,
  writeCloudSyncSince,
  writeCloudSyncToken,
  writeCloudSyncRefreshToken,
} from "../cloud-sync/cloud-sync-storage";
import { setAccessToken } from "../auth/auth-session";
import { destroyWpnScratchIndexedDb } from "../wpnscratch/wpn-scratch-store";

const ARCHON_LS_PREFIX = "archon";

function clearArchonLocalStorageKeys(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(ARCHON_LS_PREFIX) || k === ARCHON_WEB_HEADLESS_API_STORAGE_KEY)) {
        keys.push(k);
      }
    }
    for (const k of keys) {
      localStorage.removeItem(k);
    }
    localStorage.removeItem(WEB_SCRATCH_SESSION_KEY);
  } catch {
    /* private mode */
  }
}

function clearSessionStorageBestEffort(): void {
  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
}

async function clearCacheStorageBestEffort(): Promise<void> {
  if (typeof caches === "undefined") {
    return;
  }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    /* ignore */
  }
}

async function unregisterServiceWorkersBestEffort(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) {
    return;
  }
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    /* ignore */
  }
}

/** Clear auth/session tokens in memory + localStorage (without deleting IndexedDB). */
export function clearUiSessionAndCaches(): void {
  setAccessToken(null);
  writeCloudSyncToken(null);
  writeCloudSyncRefreshToken(null);
  writeCloudSyncEmail(null);
  writeCloudSyncSince(0);
  clearArchonLocalStorageKeys();
  clearSessionStorageBestEffort();
}

/**
 * Clear UI/session/caches then reload. Does not remove IndexedDB databases.
 */
export async function runClearUiDev(): Promise<void> {
  clearUiSessionAndCaches();
  await clearCacheStorageBestEffort();
  await unregisterServiceWorkersBestEffort();
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

/**
 * Destroy local RxDB cloud-notes DB(s) and scratch WPN IndexedDB, then reload.
 */
export async function runClearDbDev(): Promise<void> {
  const openUid = getOpenCloudNotesUserId();
  await destroyCloudNotesDbForUser(WEB_SCRATCH_CLOUD_USER_ID);
  if (openUid && openUid !== WEB_SCRATCH_CLOUD_USER_ID) {
    await destroyCloudNotesDbForUser(openUid);
  }
  await destroyWpnScratchIndexedDb();
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

/**
 * Full local reset: DBs + UI/session/caches, then reload.
 */
export async function runClearAllDev(): Promise<void> {
  const openUid = getOpenCloudNotesUserId();
  await destroyCloudNotesDbForUser(WEB_SCRATCH_CLOUD_USER_ID);
  if (openUid && openUid !== WEB_SCRATCH_CLOUD_USER_ID) {
    await destroyCloudNotesDbForUser(openUid);
  }
  await destroyWpnScratchIndexedDb();
  clearUiSessionAndCaches();
  await clearCacheStorageBestEffort();
  await unregisterServiceWorkersBestEffort();
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
