import React, { useEffect, useMemo } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { AppDispatch } from "../../../../store";
import type {
  NotificationEntity,
  OrgInviteNotificationPayload,
} from "../../../../auth/auth-client";
import {
  dismissNotificationThunk,
  fetchNotificationsThunk,
  markNotificationsReadThunk,
  selectNotifications,
} from "../../../../store/notificationsSlice";

function isOrgInvitePayload(
  p: Record<string, unknown>,
): p is OrgInviteNotificationPayload & Record<string, unknown> {
  return typeof p.inviteId === "string" && typeof p.orgName === "string";
}

function summary(n: NotificationEntity): string {
  if (n.type === "org_invite" && isOrgInvitePayload(n.payload)) {
    const p = n.payload;
    const grants = p.spaceGrants?.length ?? 0;
    const spacesBit = grants === 0 ? "" : ` (${grants} space${grants === 1 ? "" : "s"})`;
    return `${p.inviterDisplayName} invited you to ${p.orgName} as ${p.role}${spacesBit}`;
  }
  return "Notification";
}

function relativeTime(iso: string): string {
  try {
    const d = new Date(iso).getTime();
    const diffMs = Date.now() - d;
    if (diffMs < 60_000) return "just now";
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
    return `${Math.floor(diffMs / 86_400_000)}d ago`;
  } catch {
    return "";
  }
}

export const NotificationsSidebarView: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const notifications = useSelector(selectNotifications);

  useEffect(() => {
    void dispatch(fetchNotificationsThunk());
  }, [dispatch]);

  const unreadIds = useMemo(
    () => notifications.filter((n) => n.status === "unread").map((n) => n.id),
    [notifications],
  );

  useEffect(() => {
    if (unreadIds.length === 0) return;
    const t = setTimeout(() => {
      void dispatch(markNotificationsReadThunk(unreadIds));
    }, 800);
    return () => clearTimeout(t);
  }, [dispatch, unreadIds]);

  const handleOpen = (n: NotificationEntity): void => {
    if (typeof window !== "undefined" && n.link) {
      window.location.assign(n.link);
    }
  };

  const handleDismiss = (n: NotificationEntity, e: React.MouseEvent): void => {
    e.stopPropagation();
    void dispatch(dismissNotificationThunk(n.id));
  };

  if (notifications.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <div className="shrink-0 border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Notifications
        </div>
        <div className="flex-1 p-3 text-[12px] text-muted-foreground">
          You're all caught up.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Notifications
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {notifications.map((n) => {
          const unread = n.status === "unread";
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => handleOpen(n)}
              className={`group flex w-full items-start gap-2 border-b border-border/60 px-3 py-2 text-left text-[12px] hover:bg-muted/30 ${
                unread ? "bg-muted/10" : ""
              }`}
            >
              <span
                className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                  unread ? "bg-blue-500" : "bg-transparent"
                }`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-foreground">{summary(n)}</span>
                <span className="block text-[10px] text-muted-foreground">
                  {relativeTime(n.createdAt)}
                </span>
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => handleDismiss(n, e)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") handleDismiss(n, e as unknown as React.MouseEvent);
                }}
                className="ml-1 shrink-0 rounded px-1 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted/40 group-hover:opacity-100"
                title="Dismiss"
              >
                ×
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
