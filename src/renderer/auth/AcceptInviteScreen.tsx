import React from "react";
import { useDispatch } from "react-redux";
import {
  acceptInvite,
  declineInvite,
  previewInvite,
  type OrgInvitePreview,
} from "./auth-client";
import type { AppDispatch } from "../store";
import { loadMyOrgsThunk } from "../store/orgMembershipSlice";
import { loadOrgSpacesThunk } from "../store/spaceMembershipSlice";
import { resetCloudNotes, runCloudSyncThunk } from "../store/cloudNotesSlice";
import {
  fetchNotificationsThunk,
  locallyConsumeByDedupeLink,
} from "../store/notificationsSlice";

const card =
  "mx-auto mt-12 w-full max-w-md rounded-md border border-border bg-background p-6 text-sm shadow-sm";
const heading = "mb-1 text-lg font-semibold";
const sub = "mb-4 text-xs text-muted-foreground";
const label = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground";
const input =
  "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring";
const submitBtn =
  "archon-auth-submit mt-4 h-10 w-full rounded-md border border-border text-[13px] font-medium disabled:opacity-50";

export type AcceptInviteScreenProps = {
  /** Invite token from `/invite/:token` deep link. */
  token: string;
  /** Called after success so the host can route to the post-auth shell. */
  onAccepted?: (result: { orgId: string; userId: string }) => void;
};

export function AcceptInviteScreen({
  token,
  onAccepted,
}: AcceptInviteScreenProps): React.ReactElement {
  const dispatch = useDispatch<AppDispatch>();
  const [preview, setPreview] = React.useState<OrgInvitePreview | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [password, setPassword] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [done, setDone] = React.useState<{ orgId: string } | null>(null);
  const [declined, setDeclined] = React.useState(false);
  const [declining, setDeclining] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    previewInvite(token)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!preview) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await acceptInvite({
        token,
        password: preview.needsPassword ? password : undefined,
        displayName: displayName.trim() || undefined,
      });
      setDone({ orgId: r.orgId });
      dispatch(locallyConsumeByDedupeLink({ link: `/invite/${token}` }));
      void dispatch(loadMyOrgsThunk());
      // Rehydrate the invited org's spaces so spaceMembership.activeSpaceId is
      // set to the invited org's default — without this, WpnExplorer's
      // useEffect([activeSpaceId]) won't refire and the tree stays on the
      // invitee's previous scope until a restart.
      void dispatch(loadOrgSpacesThunk({ orgId: r.orgId }));
      // Drop previous-scope cloud-notes cache and pull the new scope so the
      // flat cloud-notes plugin doesn't leak across orgs.
      dispatch(resetCloudNotes());
      void dispatch(runCloudSyncThunk());
      void dispatch(fetchNotificationsThunk());
      onAccepted?.({ orgId: r.orgId, userId: r.userId });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDecline(): Promise<void> {
    setDeclining(true);
    setError(null);
    try {
      await declineInvite(token);
      setDeclined(true);
      dispatch(locallyConsumeByDedupeLink({ link: `/invite/${token}` }));
      void dispatch(fetchNotificationsThunk());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeclining(false);
    }
  }

  if (loading) {
    return (
      <div className={card}>
        <p className="text-muted-foreground">Looking up invite…</p>
      </div>
    );
  }

  if (error && !preview) {
    return (
      <div className={card}>
        <h1 className={heading}>Invite not valid</h1>
        <p className="text-red-600 dark:text-red-300">{error}</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className={card}>
        <h1 className={heading}>Welcome aboard</h1>
        <p className={sub}>
          You're now a member of {preview?.orgName}. Continue to the workspace.
        </p>
      </div>
    );
  }

  if (declined) {
    return (
      <div className={card}>
        <h1 className={heading}>Invite declined</h1>
        <p className={sub}>
          You've declined the invite to {preview?.orgName ?? "this organization"}.
          The admin will see this status and can re-invite if needed.
        </p>
        <a
          href="/"
          className="mt-2 inline-block text-[12px] text-primary underline"
        >
          Back to home
        </a>
      </div>
    );
  }

  if (!preview) {
    return <div className={card}>(no invite)</div>;
  }

  const inviterLabel = preview.inviter?.displayName
    ? `${preview.inviter.displayName}${preview.inviter.email ? ` (${preview.inviter.email})` : ""}`
    : "someone";

  return (
    <div className={card}>
      <h1 className={heading}>Join {preview.orgName}</h1>
      <p className={sub}>
        <strong>{inviterLabel}</strong> invited you as a{" "}
        <strong>{preview.role}</strong> for <strong>{preview.email}</strong>.
      </p>
      {preview.spaceGrants && preview.spaceGrants.length > 0 ? (
        <div className="mb-4 rounded-md border border-border/60 bg-muted/10 p-2 text-[12px]">
          <p className="mb-1 font-medium">You'll also be added to these spaces:</p>
          <ul className="space-y-0.5 pl-4">
            {preview.spaceGrants.map((g) => (
              <li key={g.spaceId} className="list-disc">
                {g.spaceName}{" "}
                <span className="text-muted-foreground">({g.role})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <form onSubmit={handleSubmit}>
        {preview.needsPassword ? (
          <>
            <label className={label}>
              Choose a password
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={input}
              />
            </label>
            <label className={`${label} mt-3`}>
              Display name (optional)
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className={input}
              />
            </label>
          </>
        ) : (
          <p className={sub}>You already have an account — accepting will add you to this org.</p>
        )}
        <button type="submit" className={submitBtn} disabled={submitting || declining}>
          {submitting ? "Joining…" : `Join ${preview.orgName}`}
        </button>
        <button
          type="button"
          onClick={() => void handleDecline()}
          disabled={submitting || declining}
          className="mt-2 w-full rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-muted/30 disabled:opacity-50"
        >
          {declining ? "Declining…" : "Decline"}
        </button>
        {error ? (
          <p className="mt-3 text-xs text-red-600 dark:text-red-300">{error}</p>
        ) : null}
      </form>
    </div>
  );
}
