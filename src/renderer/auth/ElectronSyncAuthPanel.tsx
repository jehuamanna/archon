import React, { useEffect, useMemo, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { type AppDispatch, type RootState } from "../store";
import { cloudLoginThunk } from "../store/cloudAuthSlice";

/**
 * Sign in against the sync API. Used from Electron Notes "Sync" overlay.
 * Public registration is intentionally absent — new accounts are admin-driven
 * (master invite or org invite). The `initialMode` prop is retained for
 * call-site compatibility but ignored.
 */
export function ElectronSyncAuthPanel({
  onBack,
  onSignedIn,
  backLabel = "Back",
}: {
  /** Retained for call-site compatibility — ignored. */
  initialMode?: "login" | "signup";
  onBack: () => void;
  onSignedIn: () => void;
  /** Cloud WPN window uses "Return to home" (exits to Electron welcome). */
  backLabel?: string;
}): React.ReactElement {
  const dispatch = useDispatch<AppDispatch>();
  const auth = useSelector((s: RootState) => s.cloudAuth);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const canSubmit = useMemo(() => {
    return email.trim().length > 0 && password.length > 0;
  }, [email, password]);

  useEffect(() => {
    if (auth.status === "signedIn") {
      onSignedIn();
    }
  }, [auth.status, onSignedIn]);

  return (
    <div className="mx-auto w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-lg">
      <div className="flex items-center justify-between gap-2 border-b border-border pb-3">
        <h2 className="text-[14px] font-semibold text-foreground">Sync</h2>
        <button
          type="button"
          className="text-[12px] text-muted-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground"
          onClick={onBack}
        >
          {backLabel}
        </button>
      </div>
      <p className="mt-3 text-[12px] leading-5 text-muted-foreground">
        Sign in to sync notes with your account. Local workspace files stay on
        this device. New accounts are created by an admin via invite link.
      </p>
      <form
        className="mt-5 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (auth.busy || !canSubmit) return;
          void dispatch(cloudLoginThunk({ email: email.trim(), password }));
        }}
      >
        <label className="block text-[12px]">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Email</div>
          <input
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:border-border focus:outline-none focus:ring-2 focus:ring-muted/40"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="block text-[12px]">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Password</div>
          <input
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:border-border focus:outline-none focus:ring-2 focus:ring-muted/40"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {auth.error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {auth.error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={auth.busy || !canSubmit}
          className="archon-auth-submit w-full rounded-md border border-border px-3 py-2.5 text-[13px] font-medium shadow-sm hover:bg-muted/50 disabled:opacity-50"
        >
          {auth.busy ? "…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
