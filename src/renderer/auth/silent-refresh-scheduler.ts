import { readCloudSyncToken, subscribeTokenChanges } from "../cloud-sync/cloud-sync-storage";
import { decodeAccessTokenExpiry } from "./jwt-exp";
import { refreshSessionOnce, type RefreshResult } from "./refresh-session";

/**
 * Default safety margin: refresh this many ms before `exp`. 60 s is wider than
 * typical NTP drift plus the worst-case `setTimeout` jitter browsers apply to
 * backgrounded tabs; the `visibilitychange` / `online` handlers catch the rest.
 */
const DEFAULT_SAFETY_SKEW_MS = 60_000;

/** Hard minimum delay so a burst of restarts can't spin-fire the timer. */
const MIN_TIMER_DELAY_MS = 250;

const LOG_TAG = "[archon-auth]";

export type SilentRefreshStatus = {
  running: boolean;
  nextAtMs: number | null;
  inFlight: boolean;
};

export type RefreshEvent =
  | { kind: "started" }
  | { kind: "succeeded" }
  | { kind: "failed"; reason: RefreshResult & { ok: false }["reason"] };

type RefreshListener = (event: RefreshEvent) => void;

type Deps = {
  now?: () => number;
  safetySkewMs?: number;
  onRefreshEvent?: RefreshListener;
};

let deps: Deps = {};
let running = false;
let timerId: ReturnType<typeof setTimeout> | null = null;
let scheduledAtMs: number | null = null;
let inFlight = false;
let tokenChangeUnsub: (() => void) | null = null;
let docHandlersAttached = false;

export function setSilentRefreshSchedulerDeps(next: Deps): void {
  deps = { ...deps, ...next };
}

function now(): number {
  return (deps.now ?? Date.now)();
}

function skew(): number {
  const v = deps.safetySkewMs;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_SAFETY_SKEW_MS;
}

function clearTimer(): void {
  if (timerId != null) {
    clearTimeout(timerId);
    timerId = null;
    scheduledAtMs = null;
  }
}

async function fireRefresh(trigger: "timer" | "visibility" | "online" | "boot"): Promise<void> {
  if (!running) return;
  if (inFlight) return;
  inFlight = true;
  deps.onRefreshEvent?.({ kind: "started" });
  console.info(`${LOG_TAG} silent-refresh: fire (${trigger})`);
  try {
    const r = await refreshSessionOnce();
    if (r.ok) {
      deps.onRefreshEvent?.({ kind: "succeeded" });
    } else {
      deps.onRefreshEvent?.({ kind: "failed", reason: r.reason });
    }
  } finally {
    inFlight = false;
    if (running) {
      scheduleFromStoredToken();
    }
  }
}

function scheduleFromStoredToken(): void {
  clearTimer();
  if (!running) return;
  const token = readCloudSyncToken();
  const expiry = decodeAccessTokenExpiry(token);
  if (!expiry) {
    console.warn(`${LOG_TAG} silent-refresh: no exp — scheduler idle`);
    return;
  }
  const fireAt = expiry.expMs - skew();
  const delay = Math.max(MIN_TIMER_DELAY_MS, fireAt - now());
  if (fireAt <= now()) {
    // Already due — run immediately on next tick rather than blocking the caller.
    timerId = setTimeout(() => {
      void fireRefresh("timer");
    }, MIN_TIMER_DELAY_MS);
    scheduledAtMs = now() + MIN_TIMER_DELAY_MS;
    return;
  }
  timerId = setTimeout(() => {
    void fireRefresh("timer");
  }, delay);
  scheduledAtMs = now() + delay;
}

function handleVisibilityChange(): void {
  if (!running) return;
  if (typeof document === "undefined") return;
  if (document.visibilityState === "visible") {
    const token = readCloudSyncToken();
    const expiry = decodeAccessTokenExpiry(token);
    if (expiry && expiry.expMs - skew() <= now()) {
      void fireRefresh("visibility");
      return;
    }
    // Just reschedule in case a background timer was throttled.
    scheduleFromStoredToken();
  }
}

function handleOnline(): void {
  if (!running) return;
  const token = readCloudSyncToken();
  const expiry = decodeAccessTokenExpiry(token);
  if (expiry && expiry.expMs - skew() <= now()) {
    void fireRefresh("online");
  }
}

function attachDocHandlers(): void {
  if (docHandlersAttached) return;
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("online", handleOnline);
  }
  docHandlersAttached = true;
}

function detachDocHandlers(): void {
  if (!docHandlersAttached) return;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  }
  if (typeof window !== "undefined") {
    window.removeEventListener("online", handleOnline);
  }
  docHandlersAttached = false;
}

export function startSilentRefreshScheduler(): void {
  if (running) {
    console.warn(`${LOG_TAG} silent-refresh: start called while already running`);
    return;
  }
  running = true;
  attachDocHandlers();
  if (!tokenChangeUnsub) {
    tokenChangeUnsub = subscribeTokenChanges((source) => {
      if (source === "other-tab") {
        // Another tab rotated tokens. Reschedule based on the new stored `exp`.
        scheduleFromStoredToken();
      } else {
        // This tab rotated — already rescheduled at the end of fireRefresh.
      }
    });
  }
  scheduleFromStoredToken();
  console.info(`${LOG_TAG} silent-refresh: started`);
}

export function restartSilentRefreshScheduler(): void {
  if (!running) return;
  scheduleFromStoredToken();
}

export function stopSilentRefreshScheduler(): void {
  if (!running && timerId == null) return;
  running = false;
  clearTimer();
  detachDocHandlers();
  tokenChangeUnsub?.();
  tokenChangeUnsub = null;
  console.info(`${LOG_TAG} silent-refresh: stopped`);
}

export function getSilentRefreshStatus(): SilentRefreshStatus {
  return { running, nextAtMs: scheduledAtMs, inFlight };
}

/**
 * Boot-time helper: if the stored access token has already expired, synchronously
 * (awaitably) refresh before the authenticated UI renders. Returns the result
 * so callers can decide to terminate the session when the refresh fails.
 */
export async function refreshNowIfExpired(): Promise<RefreshResult | null> {
  const token = readCloudSyncToken();
  const expiry = decodeAccessTokenExpiry(token);
  if (!expiry) return null;
  if (expiry.expMs - skew() > now()) return null;
  console.info(`${LOG_TAG} silent-refresh: boot-time refresh required`);
  return refreshSessionOnce();
}
