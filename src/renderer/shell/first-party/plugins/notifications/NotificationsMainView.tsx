import React from "react";
import { useSelector } from "react-redux";
import { selectNotifications } from "../../../../store/notificationsSlice";

export const NotificationsMainView: React.FC = () => {
  const notifications = useSelector(selectNotifications);
  return (
    <div className="flex h-full flex-col p-4">
      <h1 className="text-sm font-semibold">Notifications</h1>
      <p className="mt-1 text-[12px] text-muted-foreground">
        {notifications.length === 0
          ? "You're all caught up."
          : `You have ${notifications.length} notification${
              notifications.length === 1 ? "" : "s"
            }. Select one from the sidebar to open it.`}
      </p>
    </div>
  );
};
