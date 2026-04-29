import React, { useMemo, useState } from "react";
import { useAuth } from "./AuthContext";

/**
 * Login-only auth screen. Public signup is intentionally absent — onboarding
 * is admin-driven (master invite or org invite). Invitees land on
 * `/invite/[token]` (web) which handles password set + login in a single flow,
 * so they never come through this screen.
 */
export function AuthScreen({
  onBack,
}: {
  /** Retained for backwards compatibility with EntryScreen — ignored. */
  initialMode?: "login";
  onBack?: () => void;
}): React.ReactElement {
  const { login } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = useMemo(() => {
    return email.trim().length > 0 && password.length > 0;
  }, [email, password]);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      const message = err instanceof Error ? err.message : "An error occurred";
      setError(message);
      if (process.env.NODE_ENV === "development") {
        // eslint-disable-next-line no-console
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
              Login
            </div>
          </div>
        </div>

        <form className="space-y-3" onSubmit={onSubmit}>
          <label className="block">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">Email</div>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              autoComplete="email"
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:border-border focus:outline-none focus:ring-2 focus:ring-muted/40"
              placeholder="you@example.com"
            />
          </label>

          <label className="block">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">
              Password
            </div>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete="current-password"
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:border-border focus:outline-none focus:ring-2 focus:ring-muted/40"
              placeholder="••••••••"
            />
          </label>

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
            {submitting ? "Please wait…" : "Login"}
          </button>

          <p className="pt-2 text-center text-[11px] text-muted-foreground">
            Need an account? Ask your admin to send you an invite link.
          </p>
        </form>
      </div>
    </div>
  );
}
