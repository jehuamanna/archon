import React from "react";
import { useDispatch, useSelector } from "react-redux";
import { useArchonDialog } from "../dialog/ArchonDialogProvider";
import type { AppDispatch, RootState } from "../store";
import {
  createSpaceThunk,
  deleteSpaceThunk,
  loadOrgSpacesThunk,
  renameSpaceThunk,
  setSpaceHiddenThunk,
  switchActiveSpaceThunk,
} from "../store/spaceMembershipSlice";

const trigger =
  "inline-flex items-center gap-2 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/30 hover:text-foreground";
const menu =
  "absolute right-0 top-full z-50 mt-1 min-w-[220px] rounded-md border border-border bg-popover p-1 shadow-md";
const item =
  "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-muted/50";
const footerBtn =
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-muted/50 hover:text-foreground";
const footerInput =
  "flex-1 rounded-md border border-border bg-background px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-ring";
const footerInlineBtn =
  "rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] hover:bg-muted/30 disabled:opacity-50";
const rowMoreBtn =
  "rounded-sm px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-muted/60 hover:text-foreground";
const rowActionBtn =
  "rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";
const rowActionBtnDanger =
  "rounded-sm px-1.5 py-0.5 text-[11px] text-red-600 hover:bg-red-500/10 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-300";
const rowRenameInput =
  "flex-1 rounded-md border border-border bg-background px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-ring";

/**
 * Phase 2 dropdown that lists Spaces in the active Org. Re-fetches when the
 * Org changes, when stale (60s TTL), or after sign-in. Hidden when the user
 * has no Org context yet.
 */
export function SpaceSwitcher(): React.ReactElement | null {
  const dispatch = useDispatch<AppDispatch>();
  const { confirm } = useArchonDialog();
  const orgState = useSelector((s: RootState) => s.orgMembership);
  const spaceState = useSelector((s: RootState) => s.spaceMembership);
  const cloudAuth = useSelector((s: RootState) => s.cloudAuth);
  const [open, setOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);

  // Per-row admin-action state: one row at a time is in "menu" or "rename"
  // mode; mutations are tracked by spaceId to avoid disabling the whole list.
  const [menuForSpaceId, setMenuForSpaceId] = React.useState<string | null>(
    null,
  );
  const [renamingSpaceId, setRenamingSpaceId] = React.useState<string | null>(
    null,
  );
  const [renameDraft, setRenameDraft] = React.useState("");
  const [mutatingSpaceId, setMutatingSpaceId] = React.useState<string | null>(
    null,
  );
  const [rowError, setRowError] = React.useState<{
    spaceId: string;
    message: string;
  } | null>(null);

  const activeOrgId = orgState.activeOrgId;
  const activeOrg = orgState.orgs.find((o) => o.orgId === activeOrgId);
  const isOrgAdmin = activeOrg?.role === "admin";

  React.useEffect(() => {
    if (cloudAuth.status !== "signedIn" || !activeOrgId) {
      return;
    }
    if (spaceState.status === "loading") {
      return;
    }
    const wrongOrg = spaceState.loadedForOrgId !== activeOrgId;
    const erroredForThisOrg =
      spaceState.status === "error" && !wrongOrg;
    if (erroredForThisOrg) {
      return;
    }
    if (wrongOrg || spaceState.status === "idle") {
      void dispatch(
        loadOrgSpacesThunk({ orgId: activeOrgId, includeHidden: isOrgAdmin }),
      );
      return;
    }
    if (
      spaceState.status === "ready" &&
      spaceState.loadedAt !== null &&
      Date.now() - spaceState.loadedAt > 60_000
    ) {
      void dispatch(
        loadOrgSpacesThunk({ orgId: activeOrgId, includeHidden: isOrgAdmin }),
      );
    }
  }, [
    cloudAuth.status,
    activeOrgId,
    dispatch,
    isOrgAdmin,
    spaceState.status,
    spaceState.loadedAt,
    spaceState.loadedForOrgId,
  ]);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (): void => setOpen(false);
    window.addEventListener("click", onClick);
    return (): void => window.removeEventListener("click", onClick);
  }, [open]);

  React.useEffect(() => {
    if (!open) {
      setCreating(false);
      setNewName("");
      setCreateError(null);
      setMenuForSpaceId(null);
      setRenamingSpaceId(null);
      setRenameDraft("");
      setRowError(null);
    }
  }, [open]);

  if (cloudAuth.status !== "signedIn" || !activeOrgId) {
    return null;
  }

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    if (!activeOrgId) return;
    const name = newName.trim();
    if (!name) return;
    setSubmitting(true);
    setCreateError(null);
    try {
      const r = await dispatch(
        createSpaceThunk({ orgId: activeOrgId, name }),
      ).unwrap();
      setNewName("");
      setCreating(false);
      setOpen(false);
      void dispatch(switchActiveSpaceThunk({ spaceId: r.spaceId }));
    } catch (err) {
      setCreateError((err as Error).message ?? "Failed to create space");
    } finally {
      setSubmitting(false);
    }
  }

  const active = spaceState.spaces.find(
    (s) => s.spaceId === spaceState.activeSpaceId,
  );
  const label =
    active?.name ?? (spaceState.status === "loading" ? "Loading…" : "Select space");

  return (
    <div className="relative">
      <button
        type="button"
        className={trigger}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Switch space"
      >
        <span className="max-w-[140px] truncate font-medium text-foreground">
          {label}
        </span>
        <span aria-hidden className="text-[9px] opacity-70">▾</span>
      </button>
      {open ? (
        <div className={menu} onClick={(e) => e.stopPropagation()} role="menu">
          {spaceState.spaces.length === 0 ? (
            <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
              {spaceState.status === "loading" ? "Loading spaces…" : "No spaces"}
            </div>
          ) : (
            spaceState.spaces.map((s) =>
              renderSpaceRow(s, {
                isActive: s.spaceId === spaceState.activeSpaceId,
                isOrgAdmin,
                menuOpenForSpaceId: menuForSpaceId,
                renamingSpaceId,
                renameDraft,
                mutatingSpaceId,
                rowError,
                onSwitch: () => {
                  setOpen(false);
                  if (s.spaceId !== spaceState.activeSpaceId) {
                    void dispatch(
                      switchActiveSpaceThunk({ spaceId: s.spaceId }),
                    );
                  }
                },
                onOpenMenu: () => {
                  setMenuForSpaceId(s.spaceId);
                  setRowError(null);
                },
                onCloseMenu: () => {
                  setMenuForSpaceId(null);
                  setRenamingSpaceId(null);
                  setRenameDraft("");
                },
                onStartRename: () => {
                  setRenamingSpaceId(s.spaceId);
                  setRenameDraft(s.name);
                  setRowError(null);
                },
                onRenameDraft: (next) => setRenameDraft(next),
                onRenameCancel: () => {
                  setRenamingSpaceId(null);
                  setRenameDraft("");
                },
                onRenameCommit: async () => {
                  if (!activeOrgId) return;
                  const nextName = renameDraft.trim();
                  if (!nextName || nextName === s.name) {
                    setRenamingSpaceId(null);
                    setRenameDraft("");
                    return;
                  }
                  setMutatingSpaceId(s.spaceId);
                  setRowError(null);
                  try {
                    await dispatch(
                      renameSpaceThunk({
                        orgId: activeOrgId,
                        spaceId: s.spaceId,
                        name: nextName,
                        includeHidden: isOrgAdmin,
                      }),
                    ).unwrap();
                    setRenamingSpaceId(null);
                    setRenameDraft("");
                    setMenuForSpaceId(null);
                  } catch (err) {
                    setRowError({
                      spaceId: s.spaceId,
                      message:
                        (err as Error).message ?? "Failed to rename space",
                    });
                  } finally {
                    setMutatingSpaceId(null);
                  }
                },
                onToggleHidden: async () => {
                  if (!activeOrgId) return;
                  setMutatingSpaceId(s.spaceId);
                  setRowError(null);
                  try {
                    await dispatch(
                      setSpaceHiddenThunk({
                        orgId: activeOrgId,
                        spaceId: s.spaceId,
                        hidden: !(s.hidden === true),
                        includeHidden: isOrgAdmin,
                      }),
                    ).unwrap();
                    setMenuForSpaceId(null);
                  } catch (err) {
                    setRowError({
                      spaceId: s.spaceId,
                      message:
                        (err as Error).message ??
                        "Failed to update visibility",
                    });
                  } finally {
                    setMutatingSpaceId(null);
                  }
                },
                onDelete: async () => {
                  if (!activeOrgId) return;
                  const ok = await confirm({
                    title: "Delete space",
                    message: `Delete "${s.name}"?`,
                    detail:
                      "This cannot be undone. Members lose access; the space must be empty of workspaces first.",
                    confirmLabel: "Delete forever",
                    variant: "danger",
                  });
                  if (!ok) return;
                  setMutatingSpaceId(s.spaceId);
                  setRowError(null);
                  try {
                    await dispatch(
                      deleteSpaceThunk({
                        orgId: activeOrgId,
                        spaceId: s.spaceId,
                        includeHidden: isOrgAdmin,
                      }),
                    ).unwrap();
                    setMenuForSpaceId(null);
                  } catch (err) {
                    setRowError({
                      spaceId: s.spaceId,
                      message:
                        (err as Error).message ?? "Failed to delete space",
                    });
                  } finally {
                    setMutatingSpaceId(null);
                  }
                },
              }),
            )
          )}
          {isOrgAdmin ? (
            <>
              <div className="my-1 border-t border-border/50" />
              {creating ? (
                <form
                  className="flex items-center gap-1 px-2 py-1.5"
                  onSubmit={handleCreate}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    autoFocus
                    type="text"
                    placeholder="Space name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className={footerInput}
                    disabled={submitting}
                  />
                  <button
                    type="submit"
                    className={footerInlineBtn}
                    disabled={submitting || !newName.trim()}
                  >
                    {submitting ? "…" : "Create"}
                  </button>
                  <button
                    type="button"
                    className={footerInlineBtn}
                    onClick={() => {
                      setCreating(false);
                      setNewName("");
                      setCreateError(null);
                    }}
                    disabled={submitting}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className={footerBtn}
                  onClick={() => setCreating(true)}
                >
                  <span aria-hidden>＋</span>
                  <span>New space…</span>
                </button>
              )}
              {createError ? (
                <div className="px-2 py-1 text-[11px] text-red-600 dark:text-red-300">
                  {createError}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type RowHandlers = {
  isActive: boolean;
  isOrgAdmin: boolean;
  menuOpenForSpaceId: string | null;
  renamingSpaceId: string | null;
  renameDraft: string;
  mutatingSpaceId: string | null;
  rowError: { spaceId: string; message: string } | null;
  onSwitch: () => void;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  onStartRename: () => void;
  onRenameDraft: (next: string) => void;
  onRenameCancel: () => void;
  onRenameCommit: () => Promise<void>;
  onToggleHidden: () => Promise<void>;
  onDelete: () => Promise<void>;
};

function renderSpaceRow(
  s: import("../auth/auth-client").SpaceRow,
  h: RowHandlers,
): React.ReactElement {
  const isHidden = s.hidden === true;
  const isDefault = s.kind === "default";
  const menuOpen = h.menuOpenForSpaceId === s.spaceId;
  const isRenaming = h.renamingSpaceId === s.spaceId;
  const isMutating = h.mutatingSpaceId === s.spaceId;
  const rowError =
    h.rowError && h.rowError.spaceId === s.spaceId ? h.rowError.message : null;
  return (
    <div
      key={s.spaceId}
      className={`rounded-sm ${isHidden ? "opacity-60" : ""}`}
      data-testid={`space-switcher-row-${s.spaceId}`}
      data-hidden={isHidden ? "true" : "false"}
    >
      <div className="flex items-center gap-1">
        {isRenaming ? (
          <div className="flex flex-1 items-center gap-1 px-2 py-1">
            <input
              autoFocus
              type="text"
              className={rowRenameInput}
              value={h.renameDraft}
              onChange={(e) => h.onRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void h.onRenameCommit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  h.onRenameCancel();
                }
              }}
              disabled={isMutating}
              data-testid="space-switcher-rename-input"
            />
            <button
              type="button"
              className={rowActionBtn}
              onClick={() => void h.onRenameCommit()}
              disabled={isMutating}
            >
              {isMutating ? "…" : "Save"}
            </button>
            <button
              type="button"
              className={rowActionBtn}
              onClick={h.onRenameCancel}
              disabled={isMutating}
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className={`${item} flex-1`}
              role="menuitemradio"
              aria-checked={h.isActive}
              onClick={h.onSwitch}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">
                  {s.name}
                  {isHidden ? (
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      (hidden)
                    </span>
                  ) : null}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {s.role ?? "viewer"}
                  {isDefault ? " · default" : ""}
                </span>
              </span>
              {h.isActive ? <span aria-hidden>✓</span> : null}
            </button>
            {h.isOrgAdmin && !menuOpen ? (
              <button
                type="button"
                className={rowMoreBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  h.onOpenMenu();
                }}
                aria-label="Space actions"
                title="Manage space"
                data-testid={`space-switcher-more-${s.spaceId}`}
                disabled={isMutating}
              >
                ⋯
              </button>
            ) : null}
            {h.isOrgAdmin && menuOpen ? (
              <div className="flex items-center gap-0.5 pr-1">
                <button
                  type="button"
                  className={rowActionBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    h.onStartRename();
                  }}
                  disabled={isMutating}
                  data-testid={`space-switcher-rename-${s.spaceId}`}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className={rowActionBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    void h.onToggleHidden();
                  }}
                  disabled={isMutating || isDefault}
                  title={
                    isDefault
                      ? "The default space cannot be hidden."
                      : isHidden
                        ? "Unhide this space"
                        : "Hide this space from non-admins"
                  }
                  data-testid={`space-switcher-hide-${s.spaceId}`}
                >
                  {isMutating ? "…" : isHidden ? "Unhide" : "Hide"}
                </button>
                <button
                  type="button"
                  className={rowActionBtnDanger}
                  onClick={(e) => {
                    e.stopPropagation();
                    void h.onDelete();
                  }}
                  disabled={isMutating || isDefault}
                  title={
                    isDefault
                      ? "The default space cannot be deleted."
                      : "Delete this space"
                  }
                  data-testid={`space-switcher-delete-${s.spaceId}`}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className={rowActionBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    h.onCloseMenu();
                  }}
                  aria-label="Close actions"
                  disabled={isMutating}
                >
                  ×
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
      {rowError ? (
        <div className="px-2 py-1 text-[11px] text-red-600 dark:text-red-300">
          {rowError}
        </div>
      ) : null}
    </div>
  );
}
