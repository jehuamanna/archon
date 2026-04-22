import { useEffect } from "react";
import { useDispatch } from "react-redux";
import type { AppDispatch } from "../store";
import { getAccessToken } from "../auth/auth-session";
import { fetchNotificationsThunk } from "../store/notificationsSlice";

const POLL_INTERVAL_MS = 60_000;

export function useNotificationsPolling(): void {
  const dispatch = useDispatch<AppDispatch>();

  useEffect(() => {
    if (typeof window === "undefined") return;

    const tick = (): void => {
      if (!getAccessToken()) return;
      void dispatch(fetchNotificationsThunk());
    };

    tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [dispatch]);
}
