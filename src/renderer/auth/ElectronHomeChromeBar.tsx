import { getArchon } from "../../shared/archon-host-access";
import React from "react";
import { isElectronCloudWpnSession } from "./electron-cloud-session";
import { isElectronUserAgent } from "../archon-web-shim";

const btn =
  "rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/30 hover:text-foreground";

/**
 * Electron run-mode welcome screen chrome bar: reload-window button + a Cloud
 * WPN badge. Org/Space switchers and the Admin entry now live in the global
 * `PostAuthChromeOverlay` (rendered on every signed-in surface, web + Electron),
 * so we don't duplicate them here.
 */
export function ElectronHomeChromeBar(): React.ReactElement {
  const cloudWpn = isElectronUserAgent() && typeof window !== "undefined" && isElectronCloudWpnSession();
  return (
    <div className="pointer-events-auto absolute right-3 top-3 z-30 flex flex-wrap items-center justify-end gap-1 sm:right-4 sm:top-4">
      {cloudWpn ? (
        <span
          className="rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[11px] font-medium text-sky-800 dark:text-sky-200"
          title="This window uses cloud WPN. Use File → New local window for a folder vault."
        >
          Cloud WPN
        </span>
      ) : null}
      <button
        type="button"
        className={btn}
        title="Reload this window"
        onClick={() => {
          void getArchon().reloadWindow();
        }}
      >
        Reload window
      </button>
    </div>
  );
}
