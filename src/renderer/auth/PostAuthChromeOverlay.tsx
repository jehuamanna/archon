import React from "react";
import { useSelector } from "react-redux";
import { OrgSwitcher } from "./OrgSwitcher";
import { MyTeamsBadge } from "./MyTeamsBadge";
import type { RootState } from "../store";

/**
 * Signed-in chrome: Org switcher + a read-only "my teams" badge. The admin
 * console lives in the Admin activity-bar plugin.
 *
 * The pre-migration `SpaceSwitcher` was removed in #5 slice 2 — spaces were
 * deleted from the data model with the org/team migration, and the locked
 * design decision is "no UI grouping replacement". The MyTeamsBadge is
 * deliberately *not* a switcher: within an org, projects are visible via
 * `team_projects` grants on any team the caller is a member of, and there's
 * no second-level scope to switch between. The badge just answers "which
 * teams am I in?" so users don't have to ask an admin to find out.
 */
export function PostAuthChromeOverlay(): React.ReactElement | null {
  const cloudAuth = useSelector((s: RootState) => s.cloudAuth);

  if (cloudAuth.status !== "signedIn") {
    return null;
  }

  return (
    <>
      <OrgSwitcher />
      <MyTeamsBadge />
    </>
  );
}
