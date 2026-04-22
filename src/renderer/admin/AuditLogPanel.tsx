import React from "react";
import { useSelector } from "react-redux";
import { listOrgAudit, type AuditEvent } from "../auth/auth-client";
import type { RootState } from "../store";

const card = "rounded-md border border-border bg-background p-4 text-sm";
const row =
  "flex items-start justify-between gap-4 border-b border-border/40 py-2 last:border-b-0";
const muted = "text-xs text-muted-foreground";
const btn =
  "rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] hover:bg-muted/30";

function formatAction(action: string): string {
  return action.split(".").join(" · ").split("_").join(" ");
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const delta = Date.now() - t;
  if (delta < 60_000) return "just now";
  const m = Math.floor(delta / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleString();
}

/**
 * Phase 7 — Activity tab: paginated audit events for the active org.
 * Uses `before` cursor returned by the server.
 */
export function AuditLogPanel(): React.ReactElement | null {
  const orgState = useSelector((s: RootState) => s.orgMembership);
  const orgId = orgState.activeOrgId;
  const activeOrg = orgState.orgs.find((o) => o.orgId === orgId);
  const [events, setEvents] = React.useState<AuditEvent[]>([]);
  const [nextBefore, setNextBefore] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const loadFirst = React.useCallback(async (): Promise<void> => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await listOrgAudit({ orgId, limit: 50 });
      setEvents(r.events);
      setNextBefore(r.nextBefore);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  const loadMore = React.useCallback(async (): Promise<void> => {
    if (!orgId || !nextBefore) return;
    setLoading(true);
    setError(null);
    try {
      const r = await listOrgAudit({ orgId, before: nextBefore, limit: 50 });
      setEvents((prev) => [...prev, ...r.events]);
      setNextBefore(r.nextBefore);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [orgId, nextBefore]);

  React.useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  if (!orgId || !activeOrg) {
    return (
      <div className={card}>
        <p className={muted}>No active organization.</p>
      </div>
    );
  }
  if (activeOrg.role !== "admin") {
    return (
      <div className={card}>
        <p className={muted}>Admin access required to view activity.</p>
      </div>
    );
  }

  return (
    <div className={card}>
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Activity ({events.length}
        {nextBefore ? "+" : ""})
      </h2>
      {loading && events.length === 0 ? <p className={muted}>Loading…</p> : null}
      {events.map((e) => (
        <div key={e.eventId} className={row}>
          <div className="min-w-0">
            <div className="text-sm font-medium">{formatAction(e.action)}</div>
            <div className={muted}>
              {e.targetType} · {e.targetId}
            </div>
            {e.metadata && Object.keys(e.metadata).length > 0 ? (
              <div className={muted}>
                {Object.entries(e.metadata).map(([k, v]) => (
                  <span key={k} className="mr-2">
                    {k}=<code>{String(v)}</code>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <time className={muted} dateTime={e.ts}>
            {formatRelative(e.ts)}
          </time>
        </div>
      ))}
      {nextBefore ? (
        <div className="mt-3">
          <button
            type="button"
            className={btn}
            onClick={() => {
              void loadMore();
            }}
          >
            {loading ? "Loading…" : "Load older"}
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-[12px] text-red-700 dark:text-red-200">
          {error}
        </div>
      ) : null}
    </div>
  );
}
