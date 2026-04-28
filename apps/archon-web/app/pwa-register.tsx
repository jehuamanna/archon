"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Production-only service worker registration with an in-app "Reload to
 * update" banner. Lifecycle:
 *
 *   1. Register `/sw.js` → browser checks bytes against the installed SW.
 *   2. If different, the new SW installs in the background. We listen for
 *      `updatefound` and the new worker's `installed` state.
 *   3. When `installed` AND there's an existing `controller` (i.e. this
 *      isn't the first SW install on the device), surface the banner.
 *   4. User clicks "Reload" → page posts `{type:"SKIP_WAITING"}` → SW
 *      activates → `controllerchange` fires → page reloads itself once.
 *
 * Same pattern Gmail / Slack / Linear use to hide deploy-refresh friction.
 * Periodically polls `registration.update()` so long-idle tabs notice new
 * builds without waiting for a navigation.
 */
export function PwaServiceWorkerRegister(): React.ReactElement | null {
  const [updateReady, setUpdateReady] = useState(false);
  const waitingRef = useRef<ServiceWorker | null>(null);
  const reloadGuardRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    if (process.env.NODE_ENV !== "production") {
      return;
    }

    let cancelled = false;
    let pollHandle: number | undefined;

    const armUpdate = (worker: ServiceWorker | null): void => {
      if (!worker) return;
      waitingRef.current = worker;
      setUpdateReady(true);
    };

    void navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        if (cancelled) return;

        if (reg.waiting && navigator.serviceWorker.controller) {
          armUpdate(reg.waiting);
        }

        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (
              installing.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              armUpdate(installing);
            }
          });
        });

        // Long-idle tabs: re-check every 15 min so the banner appears
        // even without a navigation event.
        pollHandle = window.setInterval(() => {
          reg.update().catch(() => {
            /* network glitch — try again next interval */
          });
        }, 15 * 60_000);
      })
      .catch(() => {
        /* HTTPS missing / SW disabled — skip silently */
      });

    const onControllerChange = (): void => {
      if (reloadGuardRef.current) return;
      reloadGuardRef.current = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange,
    );

    return () => {
      cancelled = true;
      if (pollHandle !== undefined) window.clearInterval(pollHandle);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
    };
  }, []);

  if (!updateReady) return null;

  const onReload = (): void => {
    const w = waitingRef.current;
    if (w) {
      w.postMessage({ type: "SKIP_WAITING" });
    } else {
      // No waiting worker reference (corner case) — fall back to a hard reload.
      window.location.reload();
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 10000,
        background: "#0f172a",
        color: "white",
        padding: "12px 16px",
        borderRadius: 8,
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
        fontSize: 14,
        display: "flex",
        gap: 12,
        alignItems: "center",
        maxWidth: 360,
      }}
    >
      <span>A newer version of Archon is available.</span>
      <button
        type="button"
        onClick={onReload}
        style={{
          background: "white",
          color: "#0f172a",
          border: "none",
          padding: "6px 12px",
          borderRadius: 4,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Reload
      </button>
    </div>
  );
}
