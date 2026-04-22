import React from "react";
import { useSelector } from "react-redux";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  grantTeamSpace,
  listOrgMembers,
  listOrgSpaces,
  listOrgTeams,
  listTeamGrants,
  listTeamMembers,
  removeTeamMember,
  revokeTeamGrant,
  type OrgMember,
  type SpaceRow,
  type TeamGrant,
  type TeamMember,
  type TeamRow,
} from "../auth/auth-client";
import type { SpaceRole } from "../auth/auth-session";
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
 * Admin-only Teams console: create teams with a color, manage members,
 * grant teams a role on one or more spaces. Discord-style colored chips.
 */
export function TeamsPanel(): React.ReactElement | null {
  const orgState = useSelector((s: RootState) => s.orgMembership);
  const activeOrg = orgState.orgs.find((o) => o.orgId === orgState.activeOrgId);
  const orgId = orgState.activeOrgId;

  const [teams, setTeams] = React.useState<TeamRow[]>([]);
  const [orgMembers, setOrgMembers] = React.useState<OrgMember[]>([]);
  const [spaces, setSpaces] = React.useState<SpaceRow[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newColor, setNewColor] = React.useState<string>(COLOR_TOKENS[0]!);
  const [submitting, setSubmitting] = React.useState(false);
  const [activeTeamId, setActiveTeamId] = React.useState<string | null>(null);
  const [activeMembers, setActiveMembers] = React.useState<TeamMember[]>([]);
  const [activeGrants, setActiveGrants] = React.useState<TeamGrant[]>([]);
  const [addUserId, setAddUserId] = React.useState<string>("");
  const [grantSpaceId, setGrantSpaceId] = React.useState<string>("");
  const [grantRole, setGrantRole] = React.useState<SpaceRole>("member");

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const [t, m, s] = await Promise.all([
        listOrgTeams(orgId),
        listOrgMembers(orgId),
        listOrgSpaces(orgId),
      ]);
      setTeams(t);
      setOrgMembers(m);
      setSpaces(s);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  const refreshActive = React.useCallback(async (): Promise<void> => {
    if (!activeTeamId) return;
    try {
      const [m, g] = await Promise.all([
        listTeamMembers(activeTeamId),
        listTeamGrants(activeTeamId),
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
    setSubmitting(true);
    setError(null);
    try {
      await createTeam({ orgId, name: newName.trim(), colorToken: newColor });
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
    if (!activeTeamId || !grantSpaceId) return;
    setError(null);
    try {
      await grantTeamSpace({
        teamId: activeTeamId,
        spaceId: grantSpaceId,
        role: grantRole,
      });
      setGrantSpaceId("");
      await refreshActive();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleRevoke(spaceId: string): Promise<void> {
    if (!activeTeamId) return;
    setError(null);
    try {
      await revokeTeamGrant({ teamId: activeTeamId, spaceId });
      await refreshActive();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const activeTeam = teams.find((t) => t.teamId === activeTeamId) ?? null;
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
            Pick a team chip on the left to manage its members and space grants.
          </p>
        ) : (
          <>
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
              <span className={muted}>Space grants ({activeGrants.length})</span>
              <div className="my-2 flex items-center gap-2">
                <select
                  aria-label="Grant space"
                  value={grantSpaceId}
                  onChange={(e) => setGrantSpaceId(e.target.value)}
                  className={input}
                >
                  <option value="">Grant access to a space…</option>
                  {spaces.map((s) => (
                    <option key={s.spaceId} value={s.spaceId}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Grant role"
                  value={grantRole}
                  onChange={(e) => setGrantRole(e.target.value as SpaceRole)}
                  className={btn}
                >
                  <option value="member">member</option>
                  <option value="owner">owner</option>
                </select>
                <button
                  type="button"
                  className={btn}
                  disabled={!grantSpaceId}
                  onClick={() => {
                    void handleGrant();
                  }}
                >
                  Grant
                </button>
              </div>
              <ul className="divide-y divide-border/40">
                {activeGrants.map((g) => (
                  <li key={g.spaceId} className="flex items-center justify-between py-1.5">
                    <span className="truncate text-sm">
                      {g.spaceName}
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        ({g.role})
                      </span>
                    </span>
                    <button
                      type="button"
                      className={btnDanger}
                      onClick={() => {
                        void handleRevoke(g.spaceId);
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
