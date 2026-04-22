import React from "react";
import { useWpnSyncStatus } from "../../../../store/wpnSyncStatus";

const FRESH_WINDOW_MS = 10_000;

function formatAgo(ms: number): string {
  if (ms < 1000) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export function WpnSyncStatusBadge({
  onRetry,
}: {
  onRetry?: () => void;
}): React.ReactElement {
  const s = useWpnSyncStatus();
  const now = Date.now();
  const stale =
    s.kind === "idle" &&
    s.lastSyncedAt != null &&
    now - s.lastSyncedAt > FRESH_WINDOW_MS;

  let color: string;
  let tooltip: string;
  const interactive = s.kind === "error" || s.kind === "offline";

  if (s.kind === "error") {
    color = "bg-red-500";
    tooltip = `Sync failed: ${s.errorMessage ?? "unknown error"}. Click to retry.`;
  } else if (s.kind === "offline") {
    color = "bg-red-500";
    tooltip = "Offline — changes will be sent when reconnected. Click to retry.";
  } else if (s.kind === "syncing") {
    color = "bg-amber-400 animate-pulse";
    tooltip = "Syncing…";
  } else if (stale) {
    color = "bg-amber-400";
    tooltip =
      s.lastSyncedAt != null
        ? `Last synced ${formatAgo(now - s.lastSyncedAt)}`
        : "Not synced yet";
  } else {
    color = "bg-emerald-500";
    tooltip =
      s.lastSyncedAt != null
        ? `Synced ${formatAgo(now - s.lastSyncedAt)}`
        : "Idle";
  }

  const label = (
    <span
      className={`inline-block h-2 w-2 rounded-full ${color}`}
      aria-hidden="true"
    />
  );
  if (interactive && onRetry) {
    return (
      <button
        type="button"
        className="flex items-center rounded p-0.5 hover:bg-muted/40"
        onClick={onRetry}
        title={tooltip}
        aria-label={tooltip}
      >
        {label}
      </button>
    );
  }
  return (
    <span
      className="flex items-center px-0.5"
      title={tooltip}
      aria-label={tooltip}
    >
      {label}
    </span>
  );
}
