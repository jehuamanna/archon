import { getArchon } from "../../../../../shared/archon-host-access";
import React from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../../../../store";
import type { ShellViewComponentProps } from "../../../views/ShellViewRegistry";
import { WpnExplorerPanelView } from "./WpnExplorerPanelView";

/** Workspace → project → notes (v2) explorer backed by `getArchon().wpn*` / `/api/v1/wpn`. */
export function NotesExplorerPanelView(props: ShellViewComponentProps): React.ReactElement {
  const cloudAuth = useSelector((s: RootState) => s.cloudAuth);
  const activeOrgId = useSelector((s: RootState) => s.orgMembership.activeOrgId);
  if (cloudAuth.status === "signedIn" && !activeOrgId) {
    return (
      <div className="flex h-full min-h-0 w-full items-center justify-center p-4">
        <div className="max-w-xs rounded-md border border-border bg-background p-3 text-center text-[12px] text-muted-foreground">
          No organization selected. Use{" "}
          <span className="font-medium text-foreground">Select org</span> in the top bar to pick or
          create one before using notes.
        </div>
      </div>
    );
  }
  return <WpnExplorerPanelView {...props} />;
}
