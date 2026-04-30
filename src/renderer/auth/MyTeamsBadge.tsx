import React from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../store";
import { listMyTeams, type MyTeamRow } from "./auth-client";

const trigger =
  "inline-flex items-center gap-2 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/30 hover:text-foreground";
const menu =
  "absolute right-0 top-full z-50 mt-1 min-w-[240px] rounded-md border border-border bg-popover p-1 shadow-md";
const item =
  "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-[12px]";

/**
 * Read-only "my teams" indicator. Sits next to the OrgSwitcher and shows the
 * caller which teams they belong to in the active org plus the role each
 * team holds inside the team. Not a switcher: post-migration there is no
 * second-level scope to switch between, but users still need to be able to
 * answer "what teams am I in?" without hunting through the admin panel.
 *
 * Refetches whenever the active org changes — team membership is per-org.
 */
export function MyTeamsBadge(): React.ReactElement | null {
  const cloudAuth = useSelector((s: RootState) => s.cloudAuth);
  const activeOrgId = useSelector((s: RootState) => s.orgMembership.activeOrgId);
  const [open, setOpen] = React.useState(false);
  const [teams, setTeams] = React.useState<MyTeamRow[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (cloudAuth.status !== "signedIn" || !activeOrgId) {
      setTeams(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listMyTeams()
      .then((rows) => {
        if (!cancelled) setTeams(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError((err as Error)?.message ?? "Failed to load teams");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [cloudAuth.status, activeOrgId]);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (): void => setOpen(false);
    window.addEventListener("click", onClick);
    return (): void => window.removeEventListener("click", onClick);
  }, [open]);

  if (cloudAuth.status !== "signedIn" || !activeOrgId) {
    return null;
  }

  const count = teams?.length ?? 0;
  const label =
    teams === null
      ? loading
        ? "Teams…"
        : "Teams"
      : count === 0
        ? "No teams"
        : count === 1
          ? `1 team`
          : `${count} teams`;

  return (
    <div className="relative">
      <button
        type="button"
        className={trigger}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Teams you belong to in this organization"
      >
        <span className="font-medium text-foreground">{label}</span>
        <span aria-hidden className="text-[9px] opacity-70">▾</span>
      </button>
      {open ? (
        <div className={menu} onClick={(e) => e.stopPropagation()} role="menu">
          {error ? (
            <div className="px-2 py-1.5 text-[12px] text-red-600 dark:text-red-300">
              {error}
            </div>
          ) : teams === null || loading ? (
            <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
              Loading…
            </div>
          ) : teams.length === 0 ? (
            <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
              You're not in any team in this org. Ask an admin to add you so
              you can see shared projects.
            </div>
          ) : (
            teams.map((t) => (
              <div key={t.teamId} className={item} role="menuitem">
                <span className="flex items-center gap-2">
                  {t.colorToken ? (
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: t.colorToken }}
                    />
                  ) : null}
                  <span className="font-medium">{t.name}</span>
                </span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t.role}
                </span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
