import React from "react";
import { useSelector } from "react-redux";
import { selectUnreadNotificationCount } from "../../../../store/notificationsSlice";

/**
 * Rail-item overlay showing unread notification count.
 * Rendered by `ChromeOnlyWorkbench` via {@link ShellMenuRailItem.BadgeOverlay}.
 */
export const NotificationsBadge: React.FC = () => {
  const count = useSelector(selectUnreadNotificationCount);
  if (!count || count <= 0) return null;
  const display = count > 99 ? "99+" : String(count);
  return (
    <span
      className="pointer-events-none absolute -right-1 -top-1 inline-flex min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold leading-4 text-white"
      aria-label={`${count} unread notification${count === 1 ? "" : "s"}`}
    >
      {display}
    </span>
  );
};
