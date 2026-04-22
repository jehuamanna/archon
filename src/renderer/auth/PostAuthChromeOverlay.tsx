import React from "react";
import { useSelector } from "react-redux";
import { OrgSwitcher } from "./OrgSwitcher";
import { SpaceSwitcher } from "../spaces/SpaceSwitcher";
import type { RootState } from "../store";

/**
 * Signed-in chrome: Org/Space switchers only. The admin console now lives in the
 * Admin activity-bar plugin; the former top-right `⚙ Admin` button has been
 * removed in favor of the rail item contributed by `useRegisterAdminPlugin`.
 */
export function PostAuthChromeOverlay(): React.ReactElement | null {
  const cloudAuth = useSelector((s: RootState) => s.cloudAuth);

  if (cloudAuth.status !== "signedIn") {
    return null;
  }

  return (
    <>
      <OrgSwitcher />
      <SpaceSwitcher />
    </>
  );
}
