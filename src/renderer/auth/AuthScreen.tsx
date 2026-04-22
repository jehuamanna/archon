import React, { useEffect, useMemo, useState } from "react";
import { useAuth } from "./AuthContext";

type Mode = "login" | "signup";

export function AuthScreen({
  initialMode,
  onBack,
}: {
  initialMode?: Mode;
  onBack?: () => void;
}): React.ReactElement {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<Mode>(initialMode ?? "login");

  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialMode) setMode(initialMode);
  }, [initialMode]);

  const title = mode === "login" ? "Login" : "Signup";
  const passwordMismatch =
    mode === "signup" && confirmPassword.length > 0 && password !== confirmPassword;
  const canSubmit = useMemo(() => {
    const e = email.trim();
    const p = password;
    if (!e || !p) return false;
    if (mode === "signup" && username.trim().length < 2) return false;
    if (mode === "signup" && confirmPassword.length === 0) return false;
    if (mode === "signup" && p !== confirmPassword) return false;
    return true;
  }, [email, password, username, mode, confirmPassword]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "login") {
        await login(email.trim(), password);
      } else {
        await signup(email.trim(), username.trim(), password);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "An error occurred";
      setError(message);
      if (process.env.NODE_ENV === "development") {
        console.error(err);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-screen min-h-0 w-full items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-background p-6 shadow-sm">
        <div className="mb-5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {onBack ? (
              <button
                type="button"
                className="rounded-md border border-border bg-muted/10 px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                onClick={() => onBack()}
              >
                Back
              </button>
            ) : null}
            <div className="text-[14px] font-semibold tracking-tight text-foreground">
              {title}
            </div>
          </div>
          <div className="flex rounded-lg border border-border bg-muted/10 p-1">
            <button
              type="button"
              className={`rounded-md px-2.5 py-1 text-[12px] ${
                mode === "login"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => {
                setMode("login");
                setConfirmPassword("");
                setError(null);
              }}
            >
              Login
            </button>
            <button
              type="button"
              className={`rounded-md px-2.5 py-1 text-[12px] ${
                mode === "signup"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => {
                setMode("signup");
                setConfirmPassword("");
                setError(null);
              }}
            >
              Signup
            </button>
          </div>
        </div>

        <form className="space-y-3" onSubmit={onSubmit}>
          <label className="block">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">Email</div>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              autoComplete={mode === "login" ? "email" : "email"}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:border-border focus:outline-none focus:ring-2 focus:ring-muted/40"
              placeholder="you@example.com"
            />
          </label>

          {mode === "signup" ? (
            <label className="block">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                Username
              </div>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                type="text"
                autoComplete="username"
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:border-border focus:outline-none focus:ring-2 focus:ring-muted/40"
                placeholder="yourname"
              />
            </label>
          ) : null}

          <label className="block">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">
              Password
            </div>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:border-border focus:outline-none focus:ring-2 focus:ring-muted/40"
              placeholder="••••••••"
            />
          </label>

          {mode === "signup" ? (
            <label className="block">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                Confirm password
              </div>
              <input
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                type="password"
                autoComplete="new-password"
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:border-border focus:outline-none focus:ring-2 focus:ring-muted/40"
                placeholder="••••••••"
              />
            </label>
          ) : null}

          {passwordMismatch ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              Passwords do not match
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={!canSubmit || submitting}
            className="archon-auth-submit mt-2 h-10 w-full rounded-md border border-border text-[13px] font-medium"
          >
            {submitting ? "Please wait…" : title}
          </button>
        </form>
      </div>
    </div>
  );
}

