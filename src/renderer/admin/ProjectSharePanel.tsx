import React from "react";
import {
  addProjectShare,
  listProjectShares,
  listSpaceMembers,
  removeProjectShare,
  setProjectVisibility,
  updateProjectShareRole,
  type ProjectShareRow,
  type ResourceVisibility,
  type ShareRole,
  type SpaceMember,
} from "../auth/auth-client";

const card = "rounded-md border border-border bg-background p-4 text-sm";
const heading =
  "mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
const row =
  "flex items-center justify-between gap-2 border-b border-border/40 py-2 last:border-b-0";
const muted = "text-xs text-muted-foreground";
const btn =
  "rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] hover:bg-muted/30";
const btnDanger =
  "rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-700 hover:bg-red-500/20 dark:text-red-200";
const select =
  "rounded-md border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring";

const VISIBILITY_HINT: Record<ResourceVisibility, string> = {
  public: "Every member of the parent workspace can access this project.",
  private: "Only the creator can access. Workspace access alone is not enough.",
  shared: "Specific members you add get access. Others in the workspace cannot see this project.",
};

const ROLE_LABEL: Record<ShareRole, string> = {
  reader: "Reader",
  writer: "Writer",
};

export type ProjectSharePanelProps = {
  projectId: string;
  spaceId: string | null;
  initialVisibility: ResourceVisibility;
  canManage: boolean;
};

export function ProjectSharePanel({
  projectId,
  spaceId,
  initialVisibility,
  canManage,
}: ProjectSharePanelProps): React.ReactElement {
  const [visibility, setVisibility] =
    React.useState<ResourceVisibility>(initialVisibility);
  const [shares, setShares] = React.useState<ProjectShareRow[]>([]);
  const [spaceMembers, setSpaceMembers] = React.useState<SpaceMember[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [addUserId, setAddUserId] = React.useState("");
  const [addRole, setAddRole] = React.useState<ShareRole>("reader");
  const [submitting, setSubmitting] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listProjectShares(projectId);
      setShares(rows);
      if (spaceId) {
        const sm = await listSpaceMembers(spaceId);
        setSpaceMembers(sm);
      }
    } catch (err) {
      setError((err as Error).message ?? "Failed to load project shares");
    } finally {
      setLoading(false);
    }
  }, [projectId, spaceId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const sharedUserIds = React.useMemo(
    () => new Set(shares.map((s) => s.userId)),
    [shares],
  );
  const addable = React.useMemo(
    () => spaceMembers.filter((m) => !sharedUserIds.has(m.userId)),
    [spaceMembers, sharedUserIds],
  );

  React.useEffect(() => {
    if (!addable.some((u) => u.userId === addUserId)) {
      setAddUserId(addable[0]?.userId ?? "");
    }
  }, [addable, addUserId]);

  async function handleVisibilityChange(next: ResourceVisibility): Promise<void> {
    setError(null);
    try {
      await setProjectVisibility({ projectId, visibility: next });
      setVisibility(next);
      if (next !== "shared") {
        setShares([]);
      }
    } catch (err) {
      setError((err as Error).message ?? "Failed to change visibility");
    }
  }

  async function handleAdd(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!addUserId) return;
    setSubmitting(true);
    setError(null);
    try {
      await addProjectShare({ projectId, userId: addUserId, role: addRole });
      await refresh();
    } catch (err) {
      setError((err as Error).message ?? "Failed to add share");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRole(userId: string, role: ShareRole): Promise<void> {
    setError(null);
    try {
      await updateProjectShareRole({ projectId, userId, role });
      await refresh();
    } catch (err) {
      setError((err as Error).message ?? "Failed to update role");
    }
  }

  async function handleRemove(userId: string): Promise<void> {
    setError(null);
    try {
      await removeProjectShare({ projectId, userId });
      await refresh();
    } catch (err) {
      setError((err as Error).message ?? "Failed to remove share");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className={card}>
        <h2 className={heading}>Visibility</h2>
        {canManage ? (
          <select
            className={select}
            value={visibility}
            onChange={(e) =>
              void handleVisibilityChange(e.target.value as ResourceVisibility)
            }
            title={VISIBILITY_HINT[visibility]}
          >
            <option value="public">Public — every workspace member</option>
            <option value="private">Private — only me</option>
            <option value="shared">Shared — specific members</option>
          </select>
        ) : (
          <p className={muted}>{visibility}</p>
        )}
        <p className={`mt-2 ${muted}`}>{VISIBILITY_HINT[visibility]}</p>
      </section>

      {visibility === "shared" ? (
        <section className={card}>
          <h2 className={heading}>Shared with</h2>
          {loading ? <p className={muted}>Loading…</p> : null}
          {!loading && shares.length === 0 ? (
            <p className={muted}>
              No explicit shares yet. Added users must already have access to the parent workspace.
            </p>
          ) : null}
          <ul>
            {shares.map((s) => (
              <li key={s.userId} className={row}>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[12px]">
                    {s.displayName ?? s.email}
                  </span>
                  <span className={muted}>{s.email}</span>
                </div>
                <div className="flex items-center gap-2">
                  {canManage ? (
                    <select
                      className={select}
                      value={s.role}
                      onChange={(e) =>
                        void handleRole(s.userId, e.target.value as ShareRole)
                      }
                    >
                      <option value="reader">{ROLE_LABEL.reader}</option>
                      <option value="writer">{ROLE_LABEL.writer}</option>
                    </select>
                  ) : (
                    <span className={muted}>{ROLE_LABEL[s.role]}</span>
                  )}
                  {canManage ? (
                    <button
                      type="button"
                      className={btnDanger}
                      onClick={() => void handleRemove(s.userId)}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          {canManage && spaceId ? (
            <form className="mt-3 flex items-center gap-2" onSubmit={handleAdd}>
              <select
                className={select + " flex-1"}
                value={addUserId}
                onChange={(e) => setAddUserId(e.target.value)}
                disabled={submitting || addable.length === 0}
              >
                {addable.length === 0 ? (
                  <option value="">Everyone in this space is already shared</option>
                ) : (
                  addable.map((u) => (
                    <option key={u.userId} value={u.userId}>
                      {u.displayName ? `${u.displayName} — ${u.email}` : u.email}
                    </option>
                  ))
                )}
              </select>
              <select
                className={select}
                value={addRole}
                onChange={(e) => setAddRole(e.target.value as ShareRole)}
                disabled={submitting}
              >
                <option value="reader">{ROLE_LABEL.reader}</option>
                <option value="writer">{ROLE_LABEL.writer}</option>
              </select>
              <button
                type="submit"
                className={btn}
                disabled={submitting || !addUserId || addable.length === 0}
              >
                {submitting ? "Adding…" : "Add"}
              </button>
            </form>
          ) : null}
        </section>
      ) : null}

      <p className={muted}>
        Workspace access is required before project access. A user without
        workspace access cannot see this project even if explicitly shared here.
      </p>

      {error ? (
        <p className="text-[11px] text-red-600 dark:text-red-300">{error}</p>
      ) : null}
    </div>
  );
}
