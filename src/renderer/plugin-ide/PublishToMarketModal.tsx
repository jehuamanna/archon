import { getArchon } from "../../shared/archon-host-access";
import React, { useMemo, useState } from "react";
import { createPortal } from "react-dom";

export function PublishToMarketModal(props: {
  open: boolean;
  onClose: () => void;
  pluginName: string | null;
}): React.ReactElement | null {
  const { open, onClose, pluginName } = props;
  const [baseUrl, setBaseUrl] = useState<string>("http://127.0.0.1:8080");
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const canSubmit = useMemo(() => {
    return Boolean(pluginName && baseUrl.trim() && email.trim() && password.length >= 8);
  }, [pluginName, baseUrl, email, password]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    if (!pluginName) return;
    setBusy(true);
    setMessage(null);
    try {
      const root = baseUrl.trim().replace(/\/$/, "");
      const authPath =
        mode === "register"
          ? "/api/v1/marketplace/auth/register"
          : "/api/v1/marketplace/auth/login";
      const authRes = await fetch(`${root}${authPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
        }),
      });
      const authText = await authRes.text();
      if (!authRes.ok) {
        setMessage(authText || `Auth failed (${authRes.status})`);
        return;
      }
      const auth = JSON.parse(authText) as { token?: string };
      const token = typeof auth.token === "string" ? auth.token : "";
      if (!token) {
        setMessage("Auth response missing token");
        return;
      }
      const r = await getArchon().publishPluginToMarketplace(pluginName, {
        baseUrl: root,
        token,
      });
      if (!r.success) {
        setMessage(r.error ?? "Publish failed");
        return;
      }
      setMessage("Published successfully.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Publish to marketplace"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-lg rounded-lg border border-border bg-background p-4 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[13px] font-semibold text-foreground">
              Publish to market
            </p>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Plugin:{" "}
              <code className="rounded bg-muted px-1">
                {pluginName ?? "(none)"}
              </code>
            </p>
          </div>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-[12px] font-medium text-foreground hover:bg-muted/60"
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3">
          <label className="text-[12px] font-medium text-foreground">
            Marketplace base URL
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="https://market.example.com"
              disabled={busy}
            />
          </label>

          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-2 text-[12px] text-foreground">
              <input
                type="radio"
                checked={mode === "login"}
                onChange={() => setMode("login")}
                disabled={busy}
              />
              Login
            </label>
            <label className="inline-flex items-center gap-2 text-[12px] text-foreground">
              <input
                type="radio"
                checked={mode === "register"}
                onChange={() => setMode("register")}
                disabled={busy}
              />
              Register
            </label>
          </div>

          <label className="text-[12px] font-medium text-foreground">
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={busy}
            />
          </label>

          <label className="text-[12px] font-medium text-foreground">
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={busy}
            />
          </label>

          {message ? (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] text-foreground whitespace-pre-wrap">
              {message}
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-muted/60"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="archon-btn-neutral rounded-md px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50"
            onClick={() => void submit()}
            disabled={!canSubmit || busy}
          >
            {busy ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

