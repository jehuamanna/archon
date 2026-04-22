import React from "react";
import { useSelector } from "react-redux";
import { AuditLogPanel } from "../../../../admin/AuditLogPanel";
import { MasterConsolePanel } from "../../../../admin/MasterConsolePanel";
import { PeoplePanel } from "../../../../admin/PeoplePanel";
import { ProjectSharePanel } from "../../../../admin/ProjectSharePanel";
import { SpacePeoplePanel } from "../../../../admin/SpacePeoplePanel";
import { TeamsPanel } from "../../../../admin/TeamsPanel";
import { WorkspaceSharePanel } from "../../../../admin/WorkspaceSharePanel";
import type { RootState } from "../../../../store";
import type { ShellViewComponentProps } from "../../../views/ShellViewRegistry";
import { adminSelectionStore, type AdminSelection } from "./adminSelectionStore";

const wrap = "flex h-full min-h-0 flex-col gap-4 p-4";
const card = "rounded-md border border-border bg-background p-4 text-sm";
const heading = "text-base font-semibold";
const muted = "text-xs text-muted-foreground";

function useSelection(): AdminSelection {
  return React.useSyncExternalStore(
    (cb) => adminSelectionStore.subscribe(cb),
    () => adminSelectionStore.get().selection,
    () => adminSelectionStore.get().selection,
  );
}

export function AdminMainView(
  _props: ShellViewComponentProps,
): React.ReactElement {
  const selection = useSelection();
  const orgState = useSelector((s: RootState) => s.orgMembership);
  const spaceState = useSelector((s: RootState) => s.spaceMembership);
  const isMasterAdmin = useSelector(
    (s: RootState) => s.cloudAuth.isMasterAdmin,
  );
  const currentUserId = useSelector((s: RootState) => s.cloudAuth.userId);
  const activeOrg = orgState.orgs.find((o) => o.orgId === orgState.activeOrgId);
  const canManageOrg = activeOrg?.role === "admin";
  const canManageCreator = (creatorUserId?: string | null): boolean =>
    canManageOrg ||
    (currentUserId !== null &&
      typeof creatorUserId === "string" &&
      creatorUserId === currentUserId);

  if (selection.kind === "none") {
    return (
      <div className={wrap}>
        <header>
          <h1 className={heading}>
            {activeOrg?.name ?? (isMasterAdmin ? "Platform administration" : "Admin")}
          </h1>
          <p className={muted}>
            {isMasterAdmin
              ? "Master admin · platform-wide controls"
              : activeOrg?.role === "admin"
                ? "Admin · People & Permissions"
                : activeOrg
                  ? `${activeOrg.role ?? ""} — admin role required for some screens`
                  : "Select an organization to manage."}
          </p>
        </header>
        <div className={card}>
          <p className="text-sm">
            Pick a node from the left to manage it.
          </p>
          <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">
            {isMasterAdmin ? <li>Master console — platform-wide controls</li> : null}
            {activeOrg ? (
              <>
                <li>Organization · People, Teams, Activity</li>
                <li>Space · Members</li>
                <li>Workspace / Project · Shares & visibility</li>
              </>
            ) : null}
          </ul>
        </div>
      </div>
    );
  }

  if (selection.kind === "master") {
    if (!isMasterAdmin) {
      return (
        <div className={wrap}>
          <p className={muted}>Master admin role required.</p>
        </div>
      );
    }
    return (
      <div className={wrap}>
        <MasterConsolePanel />
      </div>
    );
  }

  if (!activeOrg) {
    return (
      <div className={wrap}>
        <p className={muted}>Select an organization to manage.</p>
      </div>
    );
  }

  switch (selection.kind) {
    case "org-people":
      return (
        <div className={wrap}>
          <PeoplePanel />
        </div>
      );
    case "org-teams":
      return (
        <div className={wrap}>
          <TeamsPanel />
        </div>
      );
    case "org-activity":
      return (
        <div className={wrap}>
          <AuditLogPanel />
        </div>
      );
    case "space-members":
      return (
        <div className={wrap}>
          <SpacePeoplePanel
            spaceId={selection.spaceId}
            canManage={canManageOrg}
          />
        </div>
      );
    case "workspace-shares":
      return (
        <div className={wrap}>
          <header>
            <h1 className={heading}>
              {selection.workspaceName ?? "Workspace"} — shares
            </h1>
            <p className={muted}>Visibility and per-member access for this workspace.</p>
          </header>
          <WorkspaceSharePanel
            workspaceId={selection.workspaceId}
            spaceId={selection.spaceId ?? spaceState.activeSpaceId}
            initialVisibility={selection.initialVisibility}
            canManage={canManageCreator(selection.creatorUserId)}
          />
        </div>
      );
    case "project-shares":
      return (
        <div className={wrap}>
          <header>
            <h1 className={heading}>
              {selection.projectName ?? "Project"} — shares
            </h1>
            <p className={muted}>Visibility and per-member access for this project.</p>
          </header>
          <ProjectSharePanel
            projectId={selection.projectId}
            spaceId={selection.spaceId ?? spaceState.activeSpaceId}
            initialVisibility={selection.initialVisibility}
            canManage={canManageCreator(selection.creatorUserId)}
          />
        </div>
      );
    default: {
      const _exhaustive: never = selection;
      return <div className={wrap} />;
    }
  }
}
