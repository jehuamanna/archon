import React from "react";
import { useDispatch, useSelector } from "react-redux";
import type { AppDispatch, RootState } from "../store";
import {
  createOrgThunk,
  loadMyOrgsThunk,
  switchActiveOrgThunk,
} from "../store/orgMembershipSlice";

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

/**
 * Sidebar/chrome dropdown letting the user pick which organization is active.
 * Lazily loads the membership list on first open and re-fetches if stale.
 */
export function OrgSwitcher(): React.ReactElement | null {
  const dispatch = useDispatch<AppDispatch>();
  const orgState = useSelector((s: RootState) => s.orgMembership);
  const cloudAuth = useSelector((s: RootState) => s.cloudAuth);
  const [open, setOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (cloudAuth.status !== "signedIn") {
      return;
    }
    if (orgState.status === "idle") {
      void dispatch(loadMyOrgsThunk());
      return;
    }
    if (
      orgState.status === "ready" &&
      orgState.loadedAt !== null &&
      Date.now() - orgState.loadedAt > 60_000
    ) {
      void dispatch(loadMyOrgsThunk());
    }
  }, [cloudAuth.status, dispatch, orgState.status, orgState.loadedAt]);

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
    }
  }, [open]);

  if (cloudAuth.status !== "signedIn") {
    return null;
  }

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    const name = newName.trim();
    if (!name) return;
    setSubmitting(true);
    setCreateError(null);
    try {
      const r = await dispatch(createOrgThunk({ name })).unwrap();
      setNewName("");
      setCreating(false);
      setOpen(false);
      // Auto-switch to the freshly created org so the user can start using it.
      void dispatch(switchActiveOrgThunk({ orgId: r.orgId }));
    } catch (err) {
      setCreateError((err as Error).message ?? "Failed to create organization");
    } finally {
      setSubmitting(false);
    }
  }

  const active = orgState.orgs.find((o) => o.orgId === orgState.activeOrgId);
  const label = active?.name ?? (orgState.status === "loading" ? "Loading…" : "Select org");

  return (
    <div className="relative">
      <button
        type="button"
        className={trigger}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Switch organization"
      >
        <span className="max-w-[140px] truncate font-medium text-foreground">{label}</span>
        <span aria-hidden className="text-[9px] opacity-70">▾</span>
      </button>
      {open ? (
        <div
          className={menu}
          onClick={(e) => e.stopPropagation()}
          role="menu"
        >
          {orgState.orgs.length === 0 ? (
            <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
              {orgState.status === "loading" ? "Loading orgs…" : "No organizations"}
            </div>
          ) : (
            orgState.orgs.map((o) => {
              const isActive = o.orgId === orgState.activeOrgId;
              return (
                <button
                  type="button"
                  key={o.orgId}
                  className={item}
                  onClick={() => {
                    setOpen(false);
                    if (!isActive) {
                      void dispatch(switchActiveOrgThunk({ orgId: o.orgId }));
                    }
                  }}
                  role="menuitemradio"
                  aria-checked={isActive}
                >
                  <span className="flex flex-col">
                    <span className="font-medium">{o.name}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {o.role}
                      {o.isDefault ? " · default" : ""}
                    </span>
                  </span>
                  {isActive ? <span aria-hidden>✓</span> : null}
                </button>
              );
            })
          )}
          <div className="my-1 border-t border-border/50" />
          {orgState.lockedOrgId ? (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
              Organization creation is disabled for invited members.
            </div>
          ) : creating ? (
            <form
              className="flex items-center gap-1 px-2 py-1.5"
              onSubmit={handleCreate}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                autoFocus
                type="text"
                placeholder="Organization name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className={footerInput}
                disabled={submitting}
              />
              <button type="submit" className={footerInlineBtn} disabled={submitting || !newName.trim()}>
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
              <span>New organization…</span>
            </button>
          )}
          {createError ? (
            <div className="px-2 py-1 text-[11px] text-red-600 dark:text-red-300">
              {createError}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
