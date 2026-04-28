import React from "react";
import { useDispatch, useSelector } from "react-redux";
import { getArchon } from "../../../../../shared/archon-host-access";
import type {
  WpnProjectRow,
  WpnVisibility,
  WpnWorkspaceRow,
} from "../../../../../shared/wpn-v2-types";
import type { ResourceVisibility } from "../../../../auth/auth-client";
import type { AppDispatch, RootState } from "../../../../store";
import { loadOrgSpacesThunk } from "../../../../store/spaceMembershipSlice";
import type { ShellViewComponentProps } from "../../../views/ShellViewRegistry";
import { adminSelectionStore, type AdminSelection } from "./adminSelectionStore";

const list = "flex min-h-0 flex-1 flex-col overflow-auto p-2 text-[12px]";
const groupHeader =
  "px-2 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";
const rowBase =
  "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-foreground/90";
const rowIdle = "hover:bg-muted/40";
const rowActive = "bg-muted/70 text-foreground";
const chevBtn =
  "flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground";
const mutedNote = "px-2 py-1 text-[11px] text-muted-foreground";

function toResourceVisibility(v: WpnVisibility | undefined): ResourceVisibility {
  return (v ?? "public") as ResourceVisibility;
}

function sameSelection(a: AdminSelection, b: AdminSelection): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "space":
      return b.kind === "space" && a.spaceId === b.spaceId;
    case "space-members":
      return b.kind === "space-members" && a.spaceId === b.spaceId;
    case "workspace-shares":
      return (
        b.kind === "workspace-shares" && a.workspaceId === b.workspaceId
      );
    case "project-shares":
      return b.kind === "project-shares" && a.projectId === b.projectId;
    default:
      return true;
  }
}

function useAdminSelection(): AdminSelection {
  return React.useSyncExternalStore(
    (cb) => adminSelectionStore.subscribe(cb),
    () => adminSelectionStore.get().selection,
    () => adminSelectionStore.get().selection,
  );
}

type IconProps = { className?: string };

const iconBase =
  "h-3.5 w-3.5 shrink-0 text-muted-foreground/80";

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

function BuildingIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(className)}>
      <rect x="4" y="3" width="16" height="18" rx="1.5" />
      <path d="M9 7h.01M13 7h.01M9 11h.01M13 11h.01M9 15h.01M13 15h.01" />
      <path d="M10 21v-3h4v3" />
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

function ActivityIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(className)}>
      <path d="M3 12h4l3-7 4 14 3-7h4" />
    </svg>
  );
}

function FolderIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(className)}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function FolderOpenIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(className)}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3z" />
      <path d="M3 9h18l-2 8a2 2 0 0 1-2 1.5H5A2 2 0 0 1 3 17z" />
    </svg>
  );
}

function EyeOffIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(className)}>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.1A11 11 0 0 1 12 6c5 0 9 4 10 6a13 13 0 0 1-3 3.5" />
      <path d="M6.5 7.5A13 13 0 0 0 2 12c1 2 5 6 10 6a11 11 0 0 0 4-.7" />
      <path d="M9.5 9.5a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

function KeyIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(className)}>
      <circle cx="8" cy="15" r="3" />
      <path d="M10.1 12.9 21 2" />
      <path d="M16 7l3 3" />
      <path d="M19 4l2 2" />
    </svg>
  );
}

function FileTextIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(className)}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
      <path d="M8 13h8M8 17h6" />
    </svg>
  );
}

type TreeRowProps = {
  depth: number;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  label: React.ReactNode;
  icon?: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
  trailing?: React.ReactNode;
};

function TreeRow({
  depth,
  expandable,
  expanded,
  onToggle,
  label,
  icon,
  active,
  onClick,
  trailing,
}: TreeRowProps): React.ReactElement {
  return (
    <div
      className={`${rowBase} ${active ? rowActive : rowIdle}`}
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      {expandable ? (
        <button
          type="button"
          className={chevBtn}
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▾" : "▸"}
        </button>
      ) : (
        <span className="inline-block w-4" />
      )}
      {icon ? <span className="shrink-0">{icon}</span> : null}
      <button
        type="button"
        className="flex-1 truncate text-left"
        onClick={onClick}
      >
        {label}
      </button>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </div>
  );
}

export function AdminSidebarView(
  _props: ShellViewComponentProps,
): React.ReactElement {
  const dispatch = useDispatch<AppDispatch>();
  const orgState = useSelector((s: RootState) => s.orgMembership);
  const spaceState = useSelector((s: RootState) => s.spaceMembership);
  const isMasterAdmin = useSelector(
    (s: RootState) => s.cloudAuth.isMasterAdmin,
  );
  const activeOrg = orgState.orgs.find((o) => o.orgId === orgState.activeOrgId);
  const canManageOrg = activeOrg?.role === "admin";
  const selection = useAdminSelection();

  const [orgExpanded, setOrgExpanded] = React.useState(true);
  const [showHidden, setShowHidden] = React.useState<boolean>(true);
  const [expandedSpaces, setExpandedSpaces] = React.useState<Set<string>>(
    () => new Set(spaceState.activeSpaceId ? [spaceState.activeSpaceId] : []),
  );

  // Admins need the full hidden-included view so they can unhide. Non-admins
  // keep the default filtered fetch driven elsewhere.
  React.useEffect(() => {
    if (canManageOrg && orgState.activeOrgId) {
      void dispatch(
        loadOrgSpacesThunk({ orgId: orgState.activeOrgId, includeHidden: true }),
      );
    }
  }, [dispatch, canManageOrg, orgState.activeOrgId]);
  const [expandedWorkspaces, setExpandedWorkspaces] = React.useState<
    Set<string>
  >(() => new Set());

  const [workspaces, setWorkspaces] = React.useState<WpnWorkspaceRow[]>([]);
  const [projectsByWs, setProjectsByWs] = React.useState<
    Record<string, WpnProjectRow[]>
  >({});
  const [wpnLoading, setWpnLoading] = React.useState(false);
  const [wpnError, setWpnError] = React.useState<string | null>(null);

  // Load workspaces/projects for the active space only. The backend endpoint is
  // scoped by the active-space header, so other spaces show only their Members
  // leaf and prompt the user to switch spaces for workspace/project admin.
  const activeSpaceId = spaceState.activeSpaceId;
  React.useEffect(() => {
    if (!activeSpaceId) {
      setWorkspaces([]);
      setProjectsByWs({});
      return;
    }
    let cancelled = false;
    setWpnLoading(true);
    setWpnError(null);
    (async () => {
      try {
        const r = await getArchon().wpnListWorkspacesAndProjects();
        if (cancelled) return;
        setWorkspaces(r.workspaces);
        const grouped: Record<string, WpnProjectRow[]> = {};
        for (const p of r.projects) {
          (grouped[p.workspace_id] ??= []).push(p);
        }
        for (const ws of Object.keys(grouped)) {
          grouped[ws]!.sort((a, b) => a.sort_index - b.sort_index);
        }
        setProjectsByWs(grouped);
      } catch (e) {
        if (!cancelled) {
          setWpnError(e instanceof Error ? e.message : "Failed to load");
        }
      } finally {
        if (!cancelled) setWpnLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSpaceId]);

  // When a deep-link command sets a workspace-shares or project-shares
  // selection, auto-expand the relevant path so the user sees context.
  React.useEffect(() => {
    if (selection.kind === "workspace-shares") {
      if (selection.spaceId) {
        setExpandedSpaces((s) => {
          if (s.has(selection.spaceId!)) return s;
          const n = new Set(s);
          n.add(selection.spaceId!);
          return n;
        });
      }
      setExpandedWorkspaces((s) => {
        if (s.has(selection.workspaceId)) return s;
        const n = new Set(s);
        n.add(selection.workspaceId);
        return n;
      });
    } else if (selection.kind === "project-shares") {
      if (selection.spaceId) {
        setExpandedSpaces((s) => {
          if (s.has(selection.spaceId!)) return s;
          const n = new Set(s);
          n.add(selection.spaceId!);
          return n;
        });
      }
      const ws = Object.entries(projectsByWs).find(([, ps]) =>
        ps.some((p) => p.id === selection.projectId),
      )?.[0];
      if (ws) {
        setExpandedWorkspaces((s) => {
          if (s.has(ws)) return s;
          const n = new Set(s);
          n.add(ws);
          return n;
        });
      }
    }
  }, [selection, projectsByWs]);

  const toggleSpace = (id: string): void =>
    setExpandedSpaces((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleWorkspace = (id: string): void =>
    setExpandedWorkspaces((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const select = (next: AdminSelection): void => {
    adminSelectionStore.setSelection(next);
    adminSelectionStore.setCompanionFocus({ kind: "none" });
  };

  const isActive = (candidate: AdminSelection): boolean =>
    sameSelection(selection, candidate);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border/60 px-3 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Admin
        </h2>
      </header>
      <div className={list}>
        {isMasterAdmin ? (
          <>
            <div className={groupHeader}>Platform</div>
            <TreeRow
              depth={0}
              icon={<CogIcon />}
              label="Master console"
              active={isActive({ kind: "master" })}
              onClick={() => select({ kind: "master" })}
            />
          </>
        ) : null}

        {activeOrg ? (
          <>
            <div className={groupHeader}>Organization</div>
            <TreeRow
              depth={0}
              icon={<BuildingIcon />}
              label={activeOrg.name}
              expandable
              expanded={orgExpanded}
              onToggle={() => setOrgExpanded((v) => !v)}
              onClick={() => setOrgExpanded((v) => !v)}
            />
            {orgExpanded ? (
              <>
                <TreeRow
                  depth={1}
                  icon={<UserIcon />}
                  label="People"
                  active={isActive({ kind: "org-people" })}
                  onClick={() => select({ kind: "org-people" })}
                />
                <TreeRow
                  depth={1}
                  icon={<UsersIcon />}
                  label="Teams"
                  active={isActive({ kind: "org-teams" })}
                  onClick={() => select({ kind: "org-teams" })}
                />
                <TreeRow
                  depth={1}
                  icon={<ActivityIcon />}
                  label="Activity"
                  active={isActive({ kind: "org-activity" })}
                  onClick={() => select({ kind: "org-activity" })}
                />
                {spaceState.spaces.length > 0 ? (
                  <div
                    className={`${groupHeader} flex items-center justify-between`}
                  >
                    <span>Spaces</span>
                    {canManageOrg &&
                    spaceState.spaces.some((s) => s.hidden === true) ? (
                      <button
                        type="button"
                        className="text-[10px] font-normal text-muted-foreground hover:text-foreground"
                        onClick={() => setShowHidden((v) => !v)}
                        data-testid="sidebar-show-hidden-toggle"
                      >
                        {showHidden ? "Hide hidden" : "Show hidden"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {spaceState.spaces
                  .filter((sp) => showHidden || sp.hidden !== true)
                  .map((sp) => {
                  const spaceExpanded = expandedSpaces.has(sp.spaceId);
                  const isActiveSpace = sp.spaceId === activeSpaceId;
                  const isHidden = sp.hidden === true;
                  return (
                    <React.Fragment key={sp.spaceId}>
                      <div
                        data-testid={`space-row-${sp.spaceId}`}
                        data-hidden={isHidden ? "true" : "false"}
                        className={isHidden ? "opacity-60" : undefined}
                      >
                      <TreeRow
                        depth={1}
                        icon={isHidden ? <EyeOffIcon /> : <FolderIcon />}
                        label={
                          <span>
                            {sp.name}
                            {isActiveSpace ? (
                              <span className="ml-1 text-[10px] text-muted-foreground">
                                (active)
                              </span>
                            ) : null}
                            {isHidden ? (
                              <span className="ml-1 text-[10px] text-muted-foreground">
                                (hidden)
                              </span>
                            ) : null}
                          </span>
                        }
                        expandable
                        expanded={spaceExpanded}
                        onToggle={() => toggleSpace(sp.spaceId)}
                        active={isActive({ kind: "space", spaceId: sp.spaceId })}
                        onClick={() => {
                          select({ kind: "space", spaceId: sp.spaceId });
                          if (!spaceExpanded) toggleSpace(sp.spaceId);
                        }}
                        trailing={
                          canManageOrg ? (
                            <button
                              type="button"
                              className="rounded px-1 text-[11px] text-muted-foreground opacity-60 hover:bg-muted/60 hover:text-foreground hover:opacity-100"
                              onClick={(e) => {
                                e.stopPropagation();
                                select({ kind: "space", spaceId: sp.spaceId });
                              }}
                              aria-label="Open space settings"
                              title="Open space settings"
                              data-testid={`space-settings-trigger-${sp.spaceId}`}
                            >
                              <CogIcon />
                            </button>
                          ) : null
                        }
                      />
                      {spaceExpanded ? (
                        <>
                          <TreeRow
                            depth={2}
                            icon={<UsersIcon />}
                            label="Members"
                            active={isActive({
                              kind: "space-members",
                              spaceId: sp.spaceId,
                            })}
                            onClick={() =>
                              select({
                                kind: "space-members",
                                spaceId: sp.spaceId,
                              })
                            }
                          />
                          {isActiveSpace ? (
                            <>
                              {wpnLoading ? (
                                <div
                                  className={mutedNote}
                                  style={{ paddingLeft: 6 + 2 * 12 }}
                                >
                                  Loading workspaces…
                                </div>
                              ) : null}
                              {wpnError ? (
                                <div
                                  className={mutedNote}
                                  style={{ paddingLeft: 6 + 2 * 12 }}
                                >
                                  {wpnError}
                                </div>
                              ) : null}
                              {!wpnLoading && !wpnError && workspaces.length === 0 ? (
                                <div
                                  className={mutedNote}
                                  style={{ paddingLeft: 6 + 2 * 12 }}
                                >
                                  No workspaces yet.
                                </div>
                              ) : null}
                              {workspaces
                                .slice()
                                .sort((a, b) => a.sort_index - b.sort_index)
                                .map((ws) => {
                                  const wsExpanded = expandedWorkspaces.has(
                                    ws.id,
                                  );
                                  const wsVisibility = toResourceVisibility(
                                    ws.visibility,
                                  );
                                  const projects = projectsByWs[ws.id] ?? [];
                                  return (
                                    <React.Fragment key={ws.id}>
                                      <TreeRow
                                        depth={2}
                                        icon={<FolderOpenIcon />}
                                        label={ws.name}
                                        expandable
                                        expanded={wsExpanded}
                                        onToggle={() => toggleWorkspace(ws.id)}
                                        onClick={() => toggleWorkspace(ws.id)}
                                      />
                                      {wsExpanded ? (
                                        <>
                                          <TreeRow
                                            depth={3}
                                            icon={<KeyIcon />}
                                            label="Shares"
                                            active={isActive({
                                              kind: "workspace-shares",
                                              workspaceId: ws.id,
                                              spaceId: sp.spaceId,
                                              initialVisibility: wsVisibility,
                                              workspaceName: ws.name,
                                              creatorUserId:
                                                ws.creatorUserId ?? null,
                                            })}
                                            onClick={() =>
                                              select({
                                                kind: "workspace-shares",
                                                workspaceId: ws.id,
                                                spaceId: sp.spaceId,
                                                initialVisibility: wsVisibility,
                                                workspaceName: ws.name,
                                                creatorUserId:
                                                  ws.creatorUserId ?? null,
                                              })
                                            }
                                          />
                                          {projects.map((pr) => {
                                            const prVisibility =
                                              toResourceVisibility(pr.visibility);
                                            return (
                                              <React.Fragment key={pr.id}>
                                                <TreeRow
                                                  depth={3}
                                                  icon={<FileTextIcon />}
                                                  label={pr.name}
                                                  expandable
                                                  expanded={false}
                                                  onToggle={() => {
                                                    // Projects have a single leaf (Shares); toggling selects it.
                                                    select({
                                                      kind: "project-shares",
                                                      projectId: pr.id,
                                                      spaceId: sp.spaceId,
                                                      initialVisibility:
                                                        prVisibility,
                                                      projectName: pr.name,
                                                      creatorUserId:
                                                        pr.creatorUserId ??
                                                        null,
                                                    });
                                                  }}
                                                  onClick={() =>
                                                    select({
                                                      kind: "project-shares",
                                                      projectId: pr.id,
                                                      spaceId: sp.spaceId,
                                                      initialVisibility:
                                                        prVisibility,
                                                      projectName: pr.name,
                                                      creatorUserId:
                                                        pr.creatorUserId ??
                                                        null,
                                                    })
                                                  }
                                                  active={isActive({
                                                    kind: "project-shares",
                                                    projectId: pr.id,
                                                    spaceId: sp.spaceId,
                                                    initialVisibility:
                                                      prVisibility,
                                                    projectName: pr.name,
                                                    creatorUserId:
                                                      pr.creatorUserId ?? null,
                                                  })}
                                                />
                                              </React.Fragment>
                                            );
                                          })}
                                        </>
                                      ) : null}
                                    </React.Fragment>
                                  );
                                })}
                            </>
                          ) : (
                            <div
                              className={mutedNote}
                              style={{ paddingLeft: 6 + 2 * 12 }}
                            >
                              Switch to this space to manage its workspaces.
                            </div>
                          )}
                        </>
                      ) : null}
                      </div>
                    </React.Fragment>
                  );
                })}
              </>
            ) : null}
          </>
        ) : null}

        {!activeOrg && !isMasterAdmin ? (
          <div className={mutedNote}>
            Select an organization to manage.
          </div>
        ) : null}

        {activeOrg && !canManageOrg ? (
          <div className={`${mutedNote} mt-3`}>
            Your role: {activeOrg.role ?? "—"}. Some controls are read-only.
          </div>
        ) : null}
      </div>
    </div>
  );
}
