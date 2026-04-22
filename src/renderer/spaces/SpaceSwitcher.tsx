import React from "react";
import { useDispatch, useSelector } from "react-redux";
import type { AppDispatch, RootState } from "../store";
import {
  createSpaceThunk,
  loadOrgSpacesThunk,
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

/**
 * Phase 2 dropdown that lists Spaces in the active Org. Re-fetches when the
 * Org changes, when stale (60s TTL), or after sign-in. Hidden when the user
 * has no Org context yet.
 */
export function SpaceSwitcher(): React.ReactElement | null {
  const dispatch = useDispatch<AppDispatch>();
  const orgState = useSelector((s: RootState) => s.orgMembership);
  const spaceState = useSelector((s: RootState) => s.spaceMembership);
  const cloudAuth = useSelector((s: RootState) => s.cloudAuth);
  const [open, setOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);

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
      void dispatch(loadOrgSpacesThunk({ orgId: activeOrgId }));
      return;
    }
    if (
      spaceState.status === "ready" &&
      spaceState.loadedAt !== null &&
      Date.now() - spaceState.loadedAt > 60_000
    ) {
      void dispatch(loadOrgSpacesThunk({ orgId: activeOrgId }));
    }
  }, [
    cloudAuth.status,
    activeOrgId,
    dispatch,
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
            spaceState.spaces.map((s) => {
              const isActive = s.spaceId === spaceState.activeSpaceId;
              return (
                <button
                  type="button"
                  key={s.spaceId}
                  className={item}
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => {
                    setOpen(false);
                    if (!isActive) {
                      void dispatch(switchActiveSpaceThunk({ spaceId: s.spaceId }));
                    }
                  }}
                >
                  <span className="flex flex-col">
                    <span className="font-medium">{s.name}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {s.role ?? "viewer"}
                      {s.kind === "default" ? " · default" : ""}
                    </span>
                  </span>
                  {isActive ? <span aria-hidden>✓</span> : null}
                </button>
              );
            })
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
