import React, { useEffect, useState } from "react";
import { applyHeadlessApiBase, isElectronUserAgent } from "../archon-web-shim";

/**
 * Browser mode: always use same-origin API base (no picker).
 * This assumes nginx (or Next rewrites) exposes `/api/v1/*` and `/marketplace/files/*`
 * on the same origin as the UI.
 */
export const WebHeadlessApiMarketplaceSection: React.FC = () => {
  const [showBrowserHint] = useState(
    () => typeof window !== "undefined" && !isElectronUserAgent(),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Force the headless base to same-origin, so Market always connects without a dropdown.
    applyHeadlessApiBase(window.location.origin);
  }, []);

  if (!showBrowserHint) {
    return null;
  }

  return (
    <section
      className="mb-4 rounded-lg border border-border bg-muted/30 p-3 text-[12px] text-foreground"
      aria-label="Headless API connection"
    >
      <div className="mb-1 font-medium text-muted-foreground">Headless API</div>
      <div className="font-mono text-[11px] text-foreground">
        Using same origin: {typeof window !== "undefined" ? window.location.origin : ""}
      </div>
    </section>
  );
};
