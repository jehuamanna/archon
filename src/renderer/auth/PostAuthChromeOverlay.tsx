import React from "react";
import { useSelector } from "react-redux";
import { OrgSwitcher } from "./OrgSwitcher";
import type { RootState } from "../store";

/**
 * Signed-in chrome: Org switcher only. The admin console lives in the
 * Admin activity-bar plugin; the former top-right `⚙ Admin` button has
 * been removed in favor of the rail item contributed by
 * `useRegisterAdminPlugin`.
 *
 * The pre-migration `SpaceSwitcher` was removed in #5 slice 2 — spaces
 * were deleted from the data model with the org/team migration, and
 * the locked design decision is "no UI grouping replacement" for
 * dropped concepts. Within an org, projects are visible to the caller
 * via `team_projects` grants on any team they're a member of; there's
 * no second-level scope to switch between. Team membership management
 * lives in the Teams admin panel.
 */
export function PostAuthChromeOverlay(): React.ReactElement | null {
  const cloudAuth = useSelector((s: RootState) => s.cloudAuth);

  if (cloudAuth.status !== "signedIn") {
    return null;
  }

  return (
    <>
      <OrgSwitcher />
    </>
  );
}
