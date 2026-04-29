import React from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../../../../store";
import type { ShellViewComponentProps } from "../../../views/ShellViewRegistry";
import { adminSelectionStore, type AdminSelection } from "./adminSelectionStore";

const list = "flex min-h-0 flex-1 flex-col overflow-auto p-2 text-[12px]";
const groupHeader =
  "px-2 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";
const rowBase =
  "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-foreground/90";
const rowIdle = "hover:bg-muted/40";
const rowActive = "bg-muted/70 text-foreground";
const mutedNote = "px-2 py-1 text-[11px] text-muted-foreground";

function useAdminSelection(): AdminSelection {
  return React.useSyncExternalStore(
    (cb) => adminSelectionStore.subscribe(cb),
    () => adminSelectionStore.get().selection,
    () => adminSelectionStore.get().selection,
  );
}

type IconProps = { className?: string };

const iconBase = "h-3.5 w-3.5 shrink-0 text-muted-foreground/80";

function svgProps(extra?: string): React.SVGProps<SVGSVGElement> {
  return {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    className: extra ? `${iconBase} ${extra}` : iconBase,
  } as React.SVGProps<SVGSVGElement>;
}

function CogIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(className)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function UserIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(className)}>
      <circle cx="12" cy="8" r="3.25" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  );
}

function UsersIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(className)}>
      <circle cx="9" cy="9" r="3" />
      <path d="M3 19a6 6 0 0 1 12 0" />
      <circle cx="17" cy="8" r="2.25" />
      <path d="M16 13a5 5 0 0 1 5 5" />
    </svg>
  );
}

function BuildingIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(className)}>
      <rect x="4" y="3" width="16" height="18" rx="1.5" />
      <path d="M9 7h.01M13 7h.01M9 11h.01M13 11h.01M9 15h.01M13 15h.01" />
      <path d="M10 21v-3h4v3" />
    </svg>
  );
}

function ActivityIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(className)}>
      <path d="M3 12h4l3-7 4 14 3-7h4" />
    </svg>
  );
}

type RowProps = {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
};

function Row({ active, onClick, icon, label }: RowProps): React.ReactElement {
  return (
    <button
      type="button"
      className={`${rowBase} ${active ? rowActive : rowIdle}`}
      onClick={onClick}
    >
      <span className="inline-block w-4" />
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 truncate text-left">{label}</span>
    </button>
  );
}

/**
 * Admin sidebar (post org/team migration). The pre-migration version was a
 * tree of Org → Space → Workspace → Project nodes, ~684 LOC including
 * tree expansion + workspace/project loading. The migration deleted spaces
 * and workspaces from the data model and replaced project-level access
 * with `team_projects` grants — so the sidebar collapsed to a flat list of
 * org-level admin landings (people, teams, departments, activity), plus
 * the master-admin console for platform admins.
 */
export function AdminSidebarView(
  _props: ShellViewComponentProps,
): React.ReactElement {
  const selection = useAdminSelection();
  const orgState = useSelector((s: RootState) => s.orgMembership);
  const isMasterAdmin = useSelector(
    (s: RootState) => s.cloudAuth.isMasterAdmin,
  );
  const activeOrg = orgState.orgs.find((o) => o.orgId === orgState.activeOrgId);
  const isOrgAdmin = activeOrg?.role === "admin";

  return (
    <div className={list}>
      <div className={groupHeader}>Account</div>
      <Row
        active={selection.kind === "account"}
        onClick={() => adminSelectionStore.setSelection({ kind: "account" })}
        icon={<UserIcon />}
        label="My account"
      />

      {isMasterAdmin ? (
        <>
          <div className={groupHeader}>Platform</div>
          <Row
            active={selection.kind === "master"}
            onClick={() => adminSelectionStore.setSelection({ kind: "master" })}
            icon={<CogIcon />}
            label="Master console"
          />
        </>
      ) : null}

      {activeOrg ? (
        <>
          <div className={groupHeader}>{activeOrg.name}</div>
          <Row
            active={selection.kind === "org-people"}
            onClick={() =>
              adminSelectionStore.setSelection({ kind: "org-people" })
            }
            icon={<UserIcon />}
            label="People"
          />
          <Row
            active={selection.kind === "org-teams"}
            onClick={() =>
              adminSelectionStore.setSelection({ kind: "org-teams" })
            }
            icon={<UsersIcon />}
            label="Teams"
          />
          <Row
            active={selection.kind === "org-departments"}
            onClick={() =>
              adminSelectionStore.setSelection({ kind: "org-departments" })
            }
            icon={<BuildingIcon />}
            label="Departments"
          />
          <Row
            active={selection.kind === "org-activity"}
            onClick={() =>
              adminSelectionStore.setSelection({ kind: "org-activity" })
            }
            icon={<ActivityIcon />}
            label="Activity"
          />
          {!isOrgAdmin ? (
            <p className={mutedNote}>
              Some admin actions require the org admin role.
            </p>
          ) : null}
        </>
      ) : (
        <p className={mutedNote}>Select an organization from the chrome.</p>
      )}
    </div>
  );
}
