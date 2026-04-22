import React, { useEffect, useMemo, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { type AppDispatch, type RootState } from "../store";
import {
  cloudLoginThunk,
  cloudRegisterThunk,
} from "../store/cloudAuthSlice";

type Mode = "login" | "signup";

/**
 * Sign in / register against the sync API (same as Cloud tab). Used from Electron Notes “Sync” overlay.
 */
export function ElectronSyncAuthPanel({
  initialMode,
  onBack,
  onSignedIn,
  backLabel = "Back",
}: {
  initialMode: Mode;
  onBack: () => void;
  onSignedIn: () => void;
  /** Cloud WPN window uses "Return to home" (exits to Electron welcome). */
  backLabel?: string;
}): React.ReactElement {
  const dispatch = useDispatch<AppDispatch>();
  const auth = useSelector((s: RootState) => s.cloudAuth);
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mode, setMode] = useState<"login" | "register">(
    initialMode === "signup" ? "register" : "login",
  );

  const passwordMismatch =
    mode === "register" && confirmPassword.length > 0 && password !== confirmPassword;

  const canSubmit = useMemo(() => {
    const e = email.trim();
    const p = password;
    if (!e || !p) return false;
    if (mode === "register") {
      if (p.length < 8) return false;
      if (username.trim().length < 2) return false;
      if (!confirmPassword || p !== confirmPassword) return false;
    }
    return true;
  }, [email, password, username, mode, confirmPassword]);

  useEffect(() => {
    setMode(initialMode === "signup" ? "register" : "login");
  }, [initialMode]);

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
        Sign in to sync notes with your account. Local workspace files stay on this device.
      </p>
      <form
        className="mt-5 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (auth.busy || !canSubmit) return;
          if (mode === "login") {
            void dispatch(cloudLoginThunk({ email: email.trim(), password }));
          } else {
            void dispatch(cloudRegisterThunk({ email: email.trim(), password }));
          }
        }}
      >
        <div className="flex gap-2 text-[11px]">
          <button
            type="button"
            className={`rounded px-2 py-1 ${mode === "login" ? "bg-muted font-medium" : ""}`}
            onClick={() => {
              setMode("login");
              setConfirmPassword("");
            }}
          >
            Sign in
          </button>
          <button
            type="button"
            className={`rounded px-2 py-1 ${mode === "register" ? "bg-muted font-medium" : ""}`}
            onClick={() => {
              setMode("register");
              setConfirmPassword("");
            }}
          >
            Register
          </button>
        </div>
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
        {mode === "register" ? (
          <label className="block text-[12px]">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">Username</div>
            <input
              type="text"
              autoComplete="username"
              placeholder="yourname"
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:border-border focus:outline-none focus:ring-2 focus:ring-muted/40"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
        ) : null}
        <label className="block text-[12px]">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Password</div>
          <input
            type="password"
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            placeholder="••••••••"
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:border-border focus:outline-none focus:ring-2 focus:ring-muted/40"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {mode === "register" ? (
          <label className="block text-[12px]">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">
              Confirm password
            </div>
            <input
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:border-border focus:outline-none focus:ring-2 focus:ring-muted/40"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </label>
        ) : null}
        {passwordMismatch ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            Passwords do not match
          </div>
        ) : null}
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
          {auth.busy ? "…" : mode === "login" ? "Sign in" : "Signup"}
        </button>
      </form>
    </div>
  );
}
