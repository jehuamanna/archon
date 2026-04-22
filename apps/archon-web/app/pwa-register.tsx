"use client";

import { useEffect } from "react";

/** Registers `public/sw.js` in production builds (requires HTTPS on the host). */
export function PwaServiceWorkerRegister(): null {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    if (process.env.NODE_ENV !== "production") {
      return;
    }
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* ignore — dev proxy or missing file */
    });
  }, []);
  return null;
}
