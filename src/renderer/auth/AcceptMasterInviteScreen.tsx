import React, { useMemo, useState } from "react";
import { acceptMasterInvite } from "./auth-client";

const card =
  "mx-auto mt-12 w-full max-w-md rounded-md border border-border bg-background p-6 text-sm shadow-sm";
const heading = "mb-1 text-lg font-semibold";
const sub = "mb-4 text-xs text-muted-foreground";
const labelClass =
  "mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground";
const input =
  "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring";
const submitBtn =
  "archon-auth-submit mt-4 h-10 w-full rounded-md border border-border text-[13px] font-medium disabled:opacity-50";

/**
 * Master-admin invite landing page (`/invite/master/:token`). The server
 * resolves the email from the token; we just take a password. On accept the
 * server marks `mustSetPassword=true` for new accounts so the first login
 * forces a rotation of this bootstrap password through `MustChangePasswordScreen`.
 */
export function AcceptMasterInviteScreen({
  token,
  onAccepted,
}: {
  token: string;
  onAccepted?: () => void;
}): React.ReactElement {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ email: string } | null>(null);

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < 8;

  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (!password || !confirm) return false;
    if (mismatch || tooShort) return false;
    return true;
  }, [submitting, password, confirm, mismatch, tooShort]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await acceptMasterInvite({ token, password });
      setDone({ email: r.email });
      onAccepted?.();
    } catch (err) {
      setError((err as Error).message ?? "Failed to accept invite");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className={card}>
        <div className={heading}>Master admin account ready</div>
        <p className={sub}>
          Your master-admin account ({done.email}) is set up. Log in to
          continue — you'll be asked to change this bootstrap password on first
          login.
        </p>
        <a
          href="/"
          className="mt-4 inline-flex h-10 w-full items-center justify-center rounded-md border border-border text-[13px] font-medium hover:bg-muted/30"
        >
          Go to login
        </a>
      </div>
    );
  }

  return (
    <div className={card}>
      <div className={heading}>Master admin invite</div>
      <p className={sub}>
        Set a password for your master-admin account. You'll be asked to change
        it once on first login.
      </p>
      <form onSubmit={handleSubmit}>
        <label className={labelClass}>Password</label>
        <input
          type="password"
          autoComplete="new-password"
          className={input}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
        />
        <label className={`${labelClass} mt-3`}>Confirm password</label>
        <input
          type="password"
          autoComplete="new-password"
          className={input}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="••••••••"
        />
        {tooShort ? (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            Password must be at least 8 characters.
          </div>
        ) : null}
        {mismatch ? (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            Passwords do not match.
          </div>
        ) : null}
        {error ? (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {error}
          </div>
        ) : null}
        <button type="submit" className={submitBtn} disabled={!canSubmit}>
          {submitting ? "Accepting…" : "Accept invite"}
        </button>
      </form>
    </div>
  );
}
