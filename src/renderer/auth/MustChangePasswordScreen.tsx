import React, { useMemo, useState } from "react";
import { useDispatch } from "react-redux";
import { authChangePassword } from "./auth-client";
import { clearMustSetPassword } from "../store/cloudAuthSlice";
import type { AppDispatch } from "../store";

/**
 * Blocks the workbench when the account has `mustSetPassword=true` — i.e. the
 * user signed in with an admin-issued temporary password. Must be submitted
 * before any other app surface becomes usable.
 */
export function MustChangePasswordScreen(): React.ReactElement {
  const dispatch = useDispatch<AppDispatch>();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await authChangePassword({ currentPassword, newPassword });
      dispatch(clearMustSetPassword());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-screen min-h-0 w-full items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-background p-6 shadow-sm">
        <div className="mb-4">
          <div className="text-[14px] font-semibold tracking-tight text-foreground">
            Set a new password
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Your account is using a temporary password from your administrator. Choose a new one
            to continue.
          </p>
        </div>
        <form className="space-y-3" onSubmit={onSubmit}>
          <label className="block">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">
              Temporary password
            </div>
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none focus:ring-2 focus:ring-muted/40"
              placeholder="••••••••"
            />
          </label>
          <label className="block">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">New password</div>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none focus:ring-2 focus:ring-muted/40"
              placeholder="At least 8 characters"
            />
          </label>
          <label className="block">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">
              Confirm new password
            </div>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none focus:ring-2 focus:ring-muted/40"
              placeholder="••••••••"
            />
          </label>

          {tooShort ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              New password must be at least 8 characters.
            </div>
          ) : null}
          {mismatch ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              Passwords do not match.
            </div>
          ) : null}
          {sameAsCurrent ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              New password must differ from the temporary password.
            </div>
          ) : null}
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={!canSubmit}
            className="archon-auth-submit mt-2 h-10 w-full rounded-md border border-border text-[13px] font-medium"
          >
            {submitting ? "Saving…" : "Update password"}
          </button>
        </form>
      </div>
    </div>
  );
}
