import React, { useMemo, useState } from "react";
import { useSelector } from "react-redux";
import { authChangePassword } from "../auth/auth-client";
import type { RootState } from "../store";

const card = "rounded-md border border-border bg-background p-4 text-sm";
const heading =
  "mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
const muted = "text-xs text-muted-foreground";
const label =
  "mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground";
const input =
  "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring";
const submitBtn =
  "archon-auth-submit mt-3 h-10 w-full rounded-md border border-border text-[13px] font-medium disabled:opacity-50";

/**
 * Self-service account panel: any signed-in user can change their own
 * password here. Independent of `MustChangePasswordScreen`, which gates the
 * whole app for forced first-login changes — this surface is voluntary.
 */
export function MyAccountPanel(): React.ReactElement {
  const cloudAuth = useSelector((s: RootState) => s.cloudAuth);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && newPassword !== confirm;
  const tooShort = newPassword.length > 0 && newPassword.length < 8;
  const sameAsCurrent =
    currentPassword.length > 0 &&
    newPassword.length > 0 &&
    currentPassword === newPassword;

  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (!currentPassword || !newPassword || !confirm) return false;
    if (mismatch || tooShort || sameAsCurrent) return false;
    return true;
  }, [submitting, currentPassword, newPassword, confirm, mismatch, tooShort, sameAsCurrent]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setDone(false);
    try {
      await authChangePassword({ currentPassword, newPassword });
      setDone(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
    } catch (err) {
      setError((err as Error).message ?? "Failed to change password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={card}>
      <h2 className={heading}>My account</h2>
      <div className="mb-3">
        <div className="text-[12px]">
          Signed in as <span className="font-medium">{cloudAuth.email ?? "(unknown)"}</span>
        </div>
        {cloudAuth.isMasterAdmin ? (
          <span className="mt-1 inline-block rounded bg-amber-500/20 px-1 text-[10px] text-amber-700 dark:text-amber-200">
            master admin
          </span>
        ) : null}
      </div>

      <h3 className={`${heading} mt-4`}>Change password</h3>
      <form onSubmit={handleSubmit}>
        <label className={label}>Current password</label>
        <input
          type="password"
          autoComplete="current-password"
          className={input}
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
        <label className={`${label} mt-3`}>New password</label>
        <input
          type="password"
          autoComplete="new-password"
          className={input}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="At least 8 characters"
        />
        <label className={`${label} mt-3`}>Confirm new password</label>
        <input
          type="password"
          autoComplete="new-password"
          className={input}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />

        {tooShort ? (
          <p className="mt-2 text-[11px] text-red-600 dark:text-red-300">
            New password must be at least 8 characters.
          </p>
        ) : null}
        {mismatch ? (
          <p className="mt-2 text-[11px] text-red-600 dark:text-red-300">
            Passwords do not match.
          </p>
        ) : null}
        {sameAsCurrent ? (
          <p className="mt-2 text-[11px] text-red-600 dark:text-red-300">
            New password must differ from the current one.
          </p>
        ) : null}
        {error ? (
          <p className="mt-2 text-[11px] text-red-600 dark:text-red-300">
            {error}
          </p>
        ) : null}
        {done ? (
          <p className="mt-2 text-[11px] text-emerald-700 dark:text-emerald-300">
            Password changed.
          </p>
        ) : null}

        <button type="submit" className={submitBtn} disabled={!canSubmit}>
          {submitting ? "Saving…" : "Update password"}
        </button>
        <p className={`${muted} mt-2`}>
          You'll stay signed in on this device. If you suspect your account is
          compromised, ask an admin to disable it — that revokes all sessions
          immediately.
        </p>
      </form>
    </section>
  );
}
