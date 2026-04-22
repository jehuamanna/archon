import React from "react";
import { useSelector } from "react-redux";
import {
  addSpaceMember,
  listOrgMembers,
  listSpaceMembers,
  removeSpaceMember,
  setSpaceMemberRole,
  type OrgMember,
  type SpaceMember,
} from "../auth/auth-client";
import type { SpaceRole } from "../auth/auth-session";
import type { RootState } from "../store";

const card = "rounded-md border border-border bg-background p-4 text-sm";
const heading = "mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
const row =
  "flex items-center justify-between gap-2 border-b border-border/40 py-2 last:border-b-0";
const muted = "text-xs text-muted-foreground";
const btn =
  "rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] hover:bg-muted/30";
const btnDanger =
  "rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-700 hover:bg-red-500/20 dark:text-red-200";
const select =
  "rounded-md border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring";

const ROLE_LABEL: Record<SpaceRole, string> = {
  owner: "Owner",
  member: "Member",
  viewer: "Viewer (read-only)",
};

const ROLE_HINT: Record<SpaceRole, string> = {
  owner: "Full control of the space (manage members + delete).",
  member: "Can create and edit their own workspaces.",
  viewer: "Read-only — can view workspaces and notes.",
};

export type SpacePeoplePanelProps = {
  /** The space being managed. `null` shows a placeholder. */
  spaceId: string | null;
  /**
   * Whether the current user can mutate members (add, change role, remove).
   * Readers still see the list; only the action controls are hidden.
   */
  canManage: boolean;
};

export function SpacePeoplePanel({
  spaceId,
  canManage,
}: SpacePeoplePanelProps): React.ReactElement | null {
  const orgState = useSelector((s: RootState) => s.orgMembership);
  const activeOrgId = orgState.activeOrgId;
  const [members, setMembers] = React.useState<SpaceMember[]>([]);
  const [orgMembers, setOrgMembers] = React.useState<OrgMember[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [addUserId, setAddUserId] = React.useState("");
  const [addRole, setAddRole] = React.useState<SpaceRole>("member");
  const [submitting, setSubmitting] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (!spaceId || !activeOrgId) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [sm, om] = await Promise.all([
        listSpaceMembers(spaceId),
        listOrgMembers(activeOrgId),
      ]);
      setMembers(sm);
      setOrgMembers(om);
    } catch (err) {
      setError((err as Error).message ?? "Failed to load space members");
    } finally {
      setLoading(false);
    }
  }, [spaceId, activeOrgId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const memberIds = React.useMemo(
    () => new Set(members.map((m) => m.userId)),
    [members],
  );
  const addable = React.useMemo(
    () => orgMembers.filter((o) => !memberIds.has(o.userId)),
    [orgMembers, memberIds],
  );

  React.useEffect(() => {
    if (!addable.some((u) => u.userId === addUserId)) {
      setAddUserId(addable[0]?.userId ?? "");
    }
  }, [addable, addUserId]);

  if (!spaceId) {
    return (
      <div className={card}>
        <p className={muted}>Select a space to manage its members.</p>
      </div>
    );
  }

  async function handleAdd(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!spaceId || !addUserId) return;
    setSubmitting(true);
    setError(null);
    try {
      await addSpaceMember({ spaceId, userId: addUserId, role: addRole });
      await refresh();
    } catch (err) {
      setError((err as Error).message ?? "Failed to add member");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRole(userId: string, role: SpaceRole): Promise<void> {
    if (!spaceId) return;
    setError(null);
    try {
      await setSpaceMemberRole({ spaceId, userId, role });
      await refresh();
    } catch (err) {
      setError((err as Error).message ?? "Failed to change role");
    }
  }

  async function handleRemove(userId: string): Promise<void> {
    if (!spaceId) return;
    setError(null);
    try {
      await removeSpaceMember({ spaceId, userId });
      await refresh();
    } catch (err) {
      setError((err as Error).message ?? "Failed to remove member");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className={card}>
        <h2 className={heading}>Members</h2>
        {loading ? <p className={muted}>Loading…</p> : null}
        {!loading && members.length === 0 ? (
          <p className={muted}>No members yet.</p>
        ) : null}
        <ul>
          {members.map((m) => (
            <li key={m.userId} className={row}>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[12px]">
                  {m.displayName ?? m.email}
                </span>
                <span className={muted}>{m.email}</span>
              </div>
              <div className="flex items-center gap-2">
                {canManage ? (
                  <select
                    className={select}
                    value={m.role}
                    onChange={(e) =>
                      void handleRole(m.userId, e.target.value as SpaceRole)
                    }
                    title={ROLE_HINT[m.role]}
                  >
                    <option value="owner">{ROLE_LABEL.owner}</option>
                    <option value="member">{ROLE_LABEL.member}</option>
                    <option value="viewer">{ROLE_LABEL.viewer}</option>
                  </select>
                ) : (
                  <span className={muted}>{ROLE_LABEL[m.role]}</span>
                )}
                {canManage ? (
                  <button
                    type="button"
                    className={btnDanger}
                    onClick={() => void handleRemove(m.userId)}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {canManage ? (
        <section className={card}>
          <h2 className={heading}>Add member</h2>
          {addable.length === 0 ? (
            <p className={muted}>
              Every org member is already in this space.
            </p>
          ) : (
            <form className="flex items-center gap-2" onSubmit={handleAdd}>
              <select
                className={select + " flex-1"}
                value={addUserId}
                onChange={(e) => setAddUserId(e.target.value)}
                disabled={submitting}
              >
                {addable.map((u) => (
                  <option key={u.userId} value={u.userId}>
                    {u.displayName ? `${u.displayName} — ${u.email}` : u.email}
                  </option>
                ))}
              </select>
              <select
                className={select}
                value={addRole}
                onChange={(e) => setAddRole(e.target.value as SpaceRole)}
                disabled={submitting}
                title={ROLE_HINT[addRole]}
              >
                <option value="member">{ROLE_LABEL.member}</option>
                <option value="viewer">{ROLE_LABEL.viewer}</option>
                <option value="owner">{ROLE_LABEL.owner}</option>
              </select>
              <button
                type="submit"
                className={btn}
                disabled={submitting || !addUserId}
              >
                {submitting ? "Adding…" : "Add"}
              </button>
            </form>
          )}
        </section>
      ) : null}

      {error ? (
        <p className="text-[11px] text-red-600 dark:text-red-300">{error}</p>
      ) : null}
    </div>
  );
}
