import { useSyncExternalStore } from "react";

export type WpnSyncStatusKind = "idle" | "syncing" | "error" | "offline";

export type WpnSyncStatusState = {
  kind: WpnSyncStatusKind;
  lastSyncedAt: number | null;
  errorMessage: string | null;
};

const listeners = new Set<() => void>();
let current: WpnSyncStatusState = {
  kind: "idle",
  lastSyncedAt: null,
  errorMessage: null,
};

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function snapshot(): WpnSyncStatusState {
  return current;
}

export function beginWpnSync(): void {
  if (current.kind === "syncing") return;
  current = { ...current, kind: "syncing", errorMessage: null };
  emit();
}

export function markWpnSyncOk(): void {
  current = {
    kind: "idle",
    lastSyncedAt: Date.now(),
    errorMessage: null,
  };
  emit();
}

export function markWpnSyncError(error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  const offlineHint = /network|failed to fetch|offline|ECONN|NetworkError/i.test(msg);
  current = {
    ...current,
    kind: offlineHint ? "offline" : "error",
    errorMessage: msg,
  };
  emit();
}

export function useWpnSyncStatus(): WpnSyncStatusState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
