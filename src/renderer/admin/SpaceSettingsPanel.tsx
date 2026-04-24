import React from "react";
import { useDispatch, useSelector } from "react-redux";
import type { SpaceRow } from "../auth/auth-client";
import { useArchonDialog } from "../dialog/ArchonDialogProvider";
import type { AppDispatch, RootState } from "../store";
import {
  deleteSpaceThunk,
  renameSpaceThunk,
  setSpaceHiddenThunk,
} from "../store/spaceMembershipSlice";

const card = "rounded-md border border-border bg-background p-4 text-sm";
const heading =
  "mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
const muted = "text-xs text-muted-foreground";
const btn =
  "rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-50";
const btnDanger =
  "rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-700 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-200";
const input =
  "rounded-md border border-border bg-background px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-ring";

export type SpaceSettingsPanelProps = {
  /** The space being managed. `null` shows a placeholder. */
  spaceId: string | null;
  /** True when the caller can mutate the space (org admin or space owner). */
  canManage: boolean;
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function SpaceSettingsPanel({
  spaceId,
  canManage,
}: SpaceSettingsPanelProps): React.ReactElement | null {
  const dispatch = useDispatch<AppDispatch>();
  const { confirm } = useArchonDialog();
  const orgState = useSelector((s: RootState) => s.orgMembership);
  const spaces = useSelector((s: RootState) => s.spaceMembership.spaces);
  const activeOrgId = orgState.activeOrgId;

  const space: SpaceRow | null = React.useMemo(
    () => spaces.find((s) => s.spaceId === spaceId) ?? null,
    [spaces, spaceId],
  );

  const [editing, setEditing] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState("");
  const [mutation, setMutation] = React.useState<
    "idle" | "renaming" | "hiding" | "unhiding" | "deleting"
  >("idle");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setEditing(false);
    setError(null);
  }, [spaceId]);

  if (!spaceId) {
    return (
      <div className={card}>
        <p className={muted}>Select a space to manage its settings.</p>
      </div>
    );
  }

  if (!space) {
    return (
      <div className={card}>
        <p className={muted}>This space is no longer available.</p>
      </div>
    );
  }

  const isDefault = space.kind === "default";
  const isHidden = space.hidden === true;

  async function handleRename(): Promise<void> {
    if (!activeOrgId || !space) return;
    const next = nameDraft.trim();
    if (!next || next === space.name) {
      setEditing(false);
      return;
    }
    setMutation("renaming");
    setError(null);
    try {
      await dispatch(
        renameSpaceThunk({
          orgId: activeOrgId,
          spaceId: space.spaceId,
          name: next,
          includeHidden: true,
        }),
      ).unwrap();
      setEditing(false);
    } catch (err) {
      setError((err as Error).message ?? "Failed to rename space");
    } finally {
      setMutation("idle");
    }
  }

  async function handleToggleHidden(): Promise<void> {
    if (!activeOrgId || !space) return;
    const hidden = !isHidden;
    setMutation(hidden ? "hiding" : "unhiding");
    setError(null);
    try {
      await dispatch(
        setSpaceHiddenThunk({
          orgId: activeOrgId,
          spaceId: space.spaceId,
          hidden,
          includeHidden: true,
        }),
      ).unwrap();
    } catch (err) {
      setError((err as Error).message ?? "Failed to update visibility");
    } finally {
      setMutation("idle");
    }
  }

  async function handleDelete(): Promise<void> {
    if (!activeOrgId || !space) return;
    const ok = await confirm({
      title: "Delete space",
      message: `Delete the space "${space.name}"?`,
      detail:
        "This cannot be undone. Members lose access and any audit history on the space remains but references a deleted target.",
      confirmLabel: "Delete forever",
      variant: "danger",
    });
    if (!ok) return;
    setMutation("deleting");
    setError(null);
    try {
      await dispatch(
        deleteSpaceThunk({
          orgId: activeOrgId,
          spaceId: space.spaceId,
          includeHidden: true,
        }),
      ).unwrap();
    } catch (err) {
      setError((err as Error).message ?? "Failed to delete space");
    } finally {
      setMutation("idle");
    }
  }

  const renaming = mutation === "renaming";
  const togglingHide = mutation === "hiding" || mutation === "unhiding";
  const deleting = mutation === "deleting";

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="space-settings-panel"
      data-space-id={space.spaceId}
    >
      <section className={card}>
        <div className="flex items-center justify-between gap-2">
          {editing ? (
            <input
              autoFocus
              className={input + " flex-1"}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
              data-testid="space-name-input"
              disabled={renaming}
            />
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="truncate text-[14px] font-medium"
                data-testid="space-name"
              >
                {space.name}
              </span>
              {isDefault ? (
                <span className={muted + " shrink-0"}>(default)</span>
              ) : null}
              {isHidden ? (
                <span
                  className={muted + " shrink-0"}
                  data-testid="space-hidden-badge"
                >
                  (hidden)
                </span>
              ) : null}
            </div>
          )}
          {canManage ? (
            <div className="flex shrink-0 gap-2">
              {editing ? (
                <>
                  <button
                    type="button"
                    className={btn}
                    onClick={() => void handleRename()}
                    disabled={renaming}
                    data-testid="space-name-save"
                  >
                    {renaming ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    className={btn}
                    onClick={() => setEditing(false)}
                    disabled={renaming}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={btn}
                  onClick={() => {
                    setNameDraft(space.name);
                    setEditing(true);
                  }}
                  data-testid="space-rename-button"
                >
                  Rename
                </button>
              )}
            </div>
          ) : null}
        </div>
      </section>

      <section className={card}>
        <h2 className={heading}>About</h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12px]">
          <dt className={muted}>Kind</dt>
          <dd>{space.kind}</dd>
          <dt className={muted}>Created</dt>
          <dd>{formatDate(space.createdAt)}</dd>
          {isHidden ? (
            <>
              <dt className={muted}>Hidden since</dt>
              <dd>{formatDate(space.hiddenAt ?? null)}</dd>
            </>
          ) : null}
        </dl>
      </section>

      {canManage ? (
        <section className={card}>
          <h2 className={heading}>Visibility</h2>
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[12px]">
                {isHidden ? "Hidden from non-admins" : "Visible to members"}
              </p>
              <p className={muted}>
                Hidden spaces still work for members with a direct URL; they
                just don&apos;t appear in the spaces list.
              </p>
            </div>
            <button
              type="button"
              className={btn}
              onClick={() => void handleToggleHidden()}
              disabled={togglingHide || isDefault}
              title={
                isDefault
                  ? "The default space cannot be hidden."
                  : isHidden
                    ? "Unhide this space"
                    : "Hide this space from non-admins"
              }
              data-testid="space-hide-toggle"
            >
              {togglingHide
                ? "Saving…"
                : isHidden
                  ? "Unhide"
                  : "Hide"}
            </button>
          </div>
        </section>
      ) : null}

      {canManage ? (
        <section className={card}>
          <h2 className={heading}>Danger zone</h2>
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[12px]">Delete this space</p>
              <p className={muted}>
                {isDefault
                  ? "The default space cannot be deleted."
                  : "The space must be empty of workspaces before it can be deleted."}
              </p>
            </div>
            <button
              type="button"
              className={btnDanger}
              onClick={() => void handleDelete()}
              disabled={deleting || isDefault}
              data-testid="space-delete-button"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </section>
      ) : null}

      {error ? (
        <p
          className="text-[11px] text-red-600 dark:text-red-300"
          data-testid="space-settings-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
