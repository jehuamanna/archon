import React from "react";
import { useSelector } from "react-redux";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  grantTeamProject,
  listOrgDepartments,
  listOrgMembers,
  listOrgTeams,
  listTeamProjects,
  listTeamMembers,
  removeTeamMember,
  revokeTeamProject,
  type DepartmentRow,
  type OrgMember,
  type TeamMember,
  type TeamProjectGrant,
  type TeamProjectRole,
  type TeamRow,
} from "../auth/auth-client";
import type { RootState } from "../store";

const card = "rounded-md border border-border bg-background p-4 text-sm";
const heading =
  "mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
const muted = "text-xs text-muted-foreground";
const btn =
  "rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] hover:bg-muted/30";
const btnDanger =
  "rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-700 hover:bg-red-500/20 dark:text-red-200";
const input =
  "flex-1 rounded-md border border-border bg-background px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-ring";

const COLOR_TOKENS = [
  "#7C3AED",
  "#EC4899",
  "#F59E0B",
  "#10B981",
  "#0EA5E9",
  "#A855F7",
  "#EF4444",
  "#64748B",
];

function teamChipStyle(colorToken: string | null): React.CSSProperties {
  return {
    backgroundColor: `${colorToken ?? "#64748B"}1F`,
    borderColor: `${colorToken ?? "#64748B"}66`,
    color: colorToken ?? "#64748B",
  };
}

/**
 * Admin-only Teams console: create teams within a department, manage
 * members, grant teams a role on one or more projects (post org/team
 * migration: project access flows through `team_projects`, not the
 * pre-migration team→space grants). Discord-style colored chips.
 */
export function TeamsPanel(): React.ReactElement | null {
  const orgState = useSelector((s: RootState) => s.orgMembership);
  const activeOrg = orgState.orgs.find((o) => o.orgId === orgState.activeOrgId);
  const orgId = orgState.activeOrgId;

  const [teams, setTeams] = React.useState<TeamRow[]>([]);
  const [orgMembers, setOrgMembers] = React.useState<OrgMember[]>([]);
  const [departments, setDepartments] = React.useState<DepartmentRow[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newColor, setNewColor] = React.useState<string>(COLOR_TOKENS[0]!);
  const [newDepartmentId, setNewDepartmentId] = React.useState<string>("");
  const [submitting, setSubmitting] = React.useState(false);
  const [activeTeamId, setActiveTeamId] = React.useState<string | null>(null);
  const [activeMembers, setActiveMembers] = React.useState<TeamMember[]>([]);
  const [activeGrants, setActiveGrants] = React.useState<TeamProjectGrant[]>(
    [],
  );
  const [addUserId, setAddUserId] = React.useState<string>("");
  // Project ids are typed manually because we do not list projects here —
  // projects are scoped to teams in the new model, so the Teams admin
  // panel doesn't have direct read access to them. Surface a pasteable
  // text field for the admin and let the server enforce membership.
  const [grantProjectId, setGrantProjectId] = React.useState<string>("");
  const [grantRole, setGrantRole] = React.useState<TeamProjectRole>("contributor");

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const [t, m, d] = await Promise.all([
        listOrgTeams(orgId),
        listOrgMembers(orgId),
        listOrgDepartments(orgId),
      ]);
      setTeams(t);
      setOrgMembers(m);
      setDepartments(d);
      if (!newDepartmentId && d.length > 0) {
        setNewDepartmentId(d[0]!.departmentId);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [orgId, newDepartmentId]);

  const refreshActive = React.useCallback(async (): Promise<void> => {
    if (!activeTeamId) return;
    try {
      const [m, g] = await Promise.all([
        listTeamMembers(activeTeamId),
        listTeamProjects(activeTeamId),
      ]);
      setActiveMembers(m);
      setActiveGrants(g);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeTeamId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    void refreshActive();
  }, [refreshActive]);

  if (!orgId || !activeOrg) {
    return (
      <div className={card}>
        <p className={muted}>No active organization.</p>
      </div>
    );
  }
  if (activeOrg.role !== "admin") {
    return (
      <div className={card}>
        <p className={muted}>Admin access required to manage teams.</p>
      </div>
    );
  }

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!orgId) return;
    if (!newName.trim()) return;
    if (!newDepartmentId) {
      setError(
        "Pick a department first (every team belongs to one). Create one in the Departments panel if none exist.",
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createTeam({
        orgId,
        departmentId: newDepartmentId,
        name: newName.trim(),
        colorToken: newColor,
      });
      setNewName("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteTeam(teamId: string): Promise<void> {
    setError(null);
    try {
      await deleteTeam(teamId);
      if (activeTeamId === teamId) {
        setActiveTeamId(null);
        setActiveMembers([]);
        setActiveGrants([]);
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleAddMember(): Promise<void> {
    if (!activeTeamId || !addUserId) return;
    setError(null);
    try {
      await addTeamMember({ teamId: activeTeamId, userId: addUserId });
      setAddUserId("");
      await Promise.all([refresh(), refreshActive()]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleRemoveMember(userId: string): Promise<void> {
    if (!activeTeamId) return;
    setError(null);
    try {
      await removeTeamMember({ teamId: activeTeamId, userId });
      await Promise.all([refresh(), refreshActive()]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleGrant(): Promise<void> {
    if (!activeTeamId || !grantProjectId) return;
    setError(null);
    try {
      await grantTeamProject({
        teamId: activeTeamId,
        projectId: grantProjectId.trim(),
        role: grantRole,
      });
      setGrantProjectId("");
      await refreshActive();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleRevoke(projectId: string): Promise<void> {
    if (!activeTeamId) return;
    setError(null);
    try {
      await revokeTeamProject({ teamId: activeTeamId, projectId });
      await refreshActive();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const activeTeam = teams.find((t) => t.teamId === activeTeamId) ?? null;
  const departmentById = new Map(
    departments.map((d) => [d.departmentId, d.name]),
  );
  const memberPickerOptions = orgMembers.filter(
    (m) => !activeMembers.some((am) => am.userId === m.userId),
  );

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <section className={card} aria-labelledby="teams-list">
        <h2 id="teams-list" className={heading}>
          Teams ({teams.length})
        </h2>
        <form className="mb-3 flex flex-wrap items-center gap-2" onSubmit={handleCreate}>
          <input
            type="text"
            required
            placeholder="Team name (e.g. Backend)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className={input}
          />
          <select
            aria-label="Department"
            value={newDepartmentId}
            onChange={(e) => setNewDepartmentId(e.target.value)}
            className={btn}
          >
            <option value="">Department…</option>
            {departments.map((d) => (
              <option key={d.departmentId} value={d.departmentId}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            className={btn}
          >
            {COLOR_TOKENS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button type="submit" disabled={submitting} className={btn}>
            {submitting ? "Creating…" : "Create"}
          </button>
        </form>
        {loading ? <p className={muted}>Loading…</p> : null}
        <div className="flex flex-wrap gap-2">
          {teams.map((t) => {
            const selected = t.teamId === activeTeamId;
            return (
              <button
                type="button"
                key={t.teamId}
                onClick={() => setActiveTeamId(t.teamId)}
                style={teamChipStyle(t.colorToken)}
                className={`flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium ${
                  selected ? "ring-2 ring-offset-1 ring-offset-background" : ""
                }`}
                title={`Department: ${departmentById.get(t.departmentId) ?? "—"}`}
              >
                {t.name}
                <span className="opacity-70">· {t.memberCount}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className={card} aria-labelledby="team-detail">
        <h2 id="team-detail" className={heading}>
          {activeTeam ? activeTeam.name : "Select a team"}
        </h2>
        {!activeTeam ? (
          <p className={muted}>
            Pick a team chip on the left to manage its members and project
            grants.
          </p>
        ) : (
          <>
            <p className={muted}>
              Department:{" "}
              {departmentById.get(activeTeam.departmentId) ?? "—"}
            </p>
            <div className="mb-4">
              <div className="mb-2 flex items-center justify-between">
                <span className={muted}>Members ({activeMembers.length})</span>
                <button
                  type="button"
                  className={btnDanger}
                  onClick={() => {
                    void handleDeleteTeam(activeTeam.teamId);
                  }}
                >
                  Delete team
                </button>
              </div>
              <div className="mb-2 flex items-center gap-2">
                <select
                  aria-label="Add member"
                  value={addUserId}
                  onChange={(e) => setAddUserId(e.target.value)}
                  className={input}
                >
                  <option value="">Add a member…</option>
                  {memberPickerOptions.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.displayName ?? m.email}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={btn}
                  disabled={!addUserId}
                  onClick={() => {
                    void handleAddMember();
                  }}
                >
                  Add
                </button>
              </div>
              <ul className="divide-y divide-border/40">
                {activeMembers.map((m) => (
                  <li key={m.userId} className="flex items-center justify-between py-1.5">
                    <span className="truncate text-sm">
                      {m.displayName ?? m.email}
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        ({m.role})
                      </span>
                    </span>
                    <button
                      type="button"
                      className={btnDanger}
                      onClick={() => {
                        void handleRemoveMember(m.userId);
                      }}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <span className={muted}>
                Project grants ({activeGrants.length})
              </span>
              <div className="my-2 flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  aria-label="Grant project id"
                  placeholder="Project UUID…"
                  value={grantProjectId}
                  onChange={(e) => setGrantProjectId(e.target.value)}
                  className={input}
                />
                <select
                  aria-label="Grant role"
                  value={grantRole}
                  onChange={(e) =>
                    setGrantRole(e.target.value as TeamProjectRole)
                  }
                  className={btn}
                >
                  <option value="owner">owner</option>
                  <option value="contributor">contributor</option>
                  <option value="viewer">viewer</option>
                </select>
                <button
                  type="button"
                  className={btn}
                  disabled={!grantProjectId}
                  onClick={() => {
                    void handleGrant();
                  }}
                >
                  Grant
                </button>
              </div>
              <ul className="divide-y divide-border/40">
                {activeGrants.map((g) => (
                  <li
                    key={g.projectId}
                    className="flex items-center justify-between py-1.5"
                  >
                    <span className="truncate text-sm">
                      {g.projectName}
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        ({g.role})
                      </span>
                    </span>
                    <button
                      type="button"
                      className={btnDanger}
                      onClick={() => {
                        void handleRevoke(g.projectId);
                      }}
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </section>

      {error ? (
        <div className="lg:col-span-2 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-[12px] text-red-700 dark:text-red-200">
          {error}
        </div>
      ) : null}
    </div>
  );
}
