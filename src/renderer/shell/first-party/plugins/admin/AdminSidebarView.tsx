import React from "react";
import { useSelector } from "react-redux";
import { getArchon } from "../../../../../shared/archon-host-access";
import type {
  WpnProjectRow,
  WpnVisibility,
  WpnWorkspaceRow,
} from "../../../../../shared/wpn-v2-types";
import type { ResourceVisibility } from "../../../../auth/auth-client";
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
const chevBtn =
  "flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground";
const mutedNote = "px-2 py-1 text-[11px] text-muted-foreground";

function toResourceVisibility(v: WpnVisibility | undefined): ResourceVisibility {
  return (v ?? "public") as ResourceVisibility;
}

function sameSelection(a: AdminSelection, b: AdminSelection): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
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

type TreeRowProps = {
  depth: number;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  label: React.ReactNode;
  icon?: string;
  active?: boolean;
  onClick?: () => void;
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
    </div>
  );
}

export function AdminSidebarView(
  _props: ShellViewComponentProps,
): React.ReactElement {
  const orgState = useSelector((s: RootState) => s.orgMembership);
  const spaceState = useSelector((s: RootState) => s.spaceMembership);
  const isMasterAdmin = useSelector(
    (s: RootState) => s.cloudAuth.isMasterAdmin,
  );
  const activeOrg = orgState.orgs.find((o) => o.orgId === orgState.activeOrgId);
  const selection = useAdminSelection();

  const [orgExpanded, setOrgExpanded] = React.useState(true);
  const [expandedSpaces, setExpandedSpaces] = React.useState<Set<string>>(
    () => new Set(spaceState.activeSpaceId ? [spaceState.activeSpaceId] : []),
  );
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

  const canManageOrg = activeOrg?.role === "admin";

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
              icon="⚙"
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
              icon="🏢"
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
                  icon="📋"
                  label="People"
                  active={isActive({ kind: "org-people" })}
                  onClick={() => select({ kind: "org-people" })}
                />
                <TreeRow
                  depth={1}
                  icon="👥"
                  label="Teams"
                  active={isActive({ kind: "org-teams" })}
                  onClick={() => select({ kind: "org-teams" })}
                />
                <TreeRow
                  depth={1}
                  icon="📜"
                  label="Activity"
                  active={isActive({ kind: "org-activity" })}
                  onClick={() => select({ kind: "org-activity" })}
                />
                {spaceState.spaces.length > 0 ? (
                  <div className={groupHeader}>Spaces</div>
                ) : null}
                {spaceState.spaces.map((sp) => {
                  const spaceExpanded = expandedSpaces.has(sp.spaceId);
                  const isActiveSpace = sp.spaceId === activeSpaceId;
                  return (
                    <React.Fragment key={sp.spaceId}>
                      <TreeRow
                        depth={1}
                        icon="📁"
                        label={
                          <span>
                            {sp.name}
                            {isActiveSpace ? (
                              <span className="ml-1 text-[10px] text-muted-foreground">
                                (active)
                              </span>
                            ) : null}
                          </span>
                        }
                        expandable
                        expanded={spaceExpanded}
                        onToggle={() => toggleSpace(sp.spaceId)}
                        onClick={() => toggleSpace(sp.spaceId)}
                      />
                      {spaceExpanded ? (
                        <>
                          <TreeRow
                            depth={2}
                            icon="👥"
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
                                        icon="📂"
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
                                            icon="🔑"
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
                                                  icon="📄"
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
