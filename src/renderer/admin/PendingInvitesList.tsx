import React from "react";
import {
  listOrgInvites,
  regenerateOrgInvite,
  revokeOrgInvite,
  type OrgInviteRow,
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

function statusColor(status: OrgInviteRow["status"]): string {
  switch (status) {
    case "pending":
      return "text-amber-700 dark:text-amber-200";
    case "accepted":
      return "text-emerald-700 dark:text-emerald-200";
    case "declined":
    case "revoked":
    case "expired":
      return "text-muted-foreground";
    default:
      return "";
  }
}

export function PendingInvitesList(props: {
  orgId: string;
  refreshKey: number;
}): React.ReactElement {
  const { orgId, refreshKey } = props;
  const [invites, setInvites] = React.useState<OrgInviteRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [shareLink, setShareLink] = React.useState<{
    email: string;
    link: string;
    expiresAt: string;
  } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const rows = await listOrgInvites(orgId);
        if (!cancelled) setInvites(rows);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, refreshKey, reloadKey]);

  async function handleRevoke(inviteId: string): Promise<void> {
    setError(null);
    try {
      await revokeOrgInvite({ orgId, inviteId });
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleRegenerate(inviteId: string): Promise<void> {
    setError(null);
    try {
      const r = await regenerateOrgInvite({ orgId, inviteId });
      const link =
        typeof window !== "undefined"
          ? `${window.location.origin}/invite/${encodeURIComponent(r.token)}`
          : `/invite/${encodeURIComponent(r.token)}`;
      setShareLink({
        email: r.email,
        link,
        expiresAt: r.expiresAt,
      });
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className={card} aria-labelledby="people-invites">
      <h2 id="people-invites" className={heading}>
        Invites ({invites.length})
      </h2>
      {loading ? <p className={muted}>Loading…</p> : null}
      {invites.length === 0 && !loading ? (
        <p className={muted}>No invites yet.</p>
      ) : null}
      {invites.map((i) => {
        const grants = i.spaceGrants ?? [];
        return (
          <div key={i.inviteId} className={row}>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{i.email}</div>
              <div className={muted}>
                <span className={statusColor(i.status)}>{i.status}</span>
                {" · "}role {i.role}
                {grants.length > 0
                  ? ` · ${grants.length} space${grants.length === 1 ? "" : "s"}`
                  : ""}
              </div>
            </div>
            <div className="flex items-center gap-1">
              {i.status === "pending" ? (
                <>
                  <button
                    type="button"
                    className={btn}
                    onClick={() => void handleRegenerate(i.inviteId)}
                    title="Mint a fresh link — old link instantly stops working."
                  >
                    Regenerate link
                  </button>
                  <button
                    type="button"
                    className={btnDanger}
                    onClick={() => void handleRevoke(i.inviteId)}
                  >
                    Revoke
                  </button>
                </>
              ) : null}
            </div>
          </div>
        );
      })}
      {shareLink ? (
        <div className="mt-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-[11px]">
          <div className="font-semibold">Invite link for {shareLink.email}</div>
          <code className="mt-1 block break-all rounded bg-background/50 px-1 py-0.5 font-mono text-[10px]">
            {shareLink.link}
          </code>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              className={btn}
              onClick={() => {
                if (typeof navigator !== "undefined" && navigator.clipboard) {
                  void navigator.clipboard.writeText(shareLink.link);
                }
              }}
            >
              Copy
            </button>
            <span className={muted}>
              expires {new Date(shareLink.expiresAt).toLocaleString()} — shown
              once; regenerate again if lost.
            </span>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-700 dark:text-red-200">
          {error}
        </div>
      ) : null}
    </div>
  );
}
