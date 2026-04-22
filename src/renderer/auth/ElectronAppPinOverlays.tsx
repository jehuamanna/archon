import React, { useState } from "react";
import {
  markPinOfferDismissed,
  setElectronAppPin,
  setSessionPinUnlocked,
  verifyElectronAppPin,
} from "./electron-app-pin-storage";

export function ElectronAppPinLock(props: {
  onUnlocked: () => void;
  onSignInWithEmail: () => void | Promise<void>;
}): React.ReactElement {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e?: React.FormEvent): Promise<void> {
    e?.preventDefault();
    if (busy || !pin.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const ok = await verifyElectronAppPin(pin);
      if (!ok) {
        setError("Incorrect PIN.");
        return;
      }
      setSessionPinUnlocked();
      setPin("");
      props.onUnlocked();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[101] flex items-center justify-center overflow-y-auto bg-background/95 px-4 py-8 backdrop-blur-sm">
      <div className="mx-auto w-full max-w-sm rounded-xl border border-border bg-background p-6 shadow-lg">
        <h2 className="text-[14px] font-semibold text-foreground">Unlock Archon</h2>
        <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
          Enter your app PIN. We ask again after you restart the app, or after you sign out of sync and sign back
          in. Forgot the PIN? Use the link below to sign in with email, then you can set a new PIN.
        </p>
        <form className="mt-4 space-y-3" onSubmit={(e) => void submit(e)}>
          <label className="block text-[12px]">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">PIN</div>
            <input
              type="password"
              autoComplete="off"
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none focus:ring-2 focus:ring-muted/40"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoFocus
            />
          </label>
          {error ? (
            <p className="text-[12px] text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy || !pin.trim()}
            className="archon-auth-submit h-10 w-full rounded-md border border-border text-[13px] font-medium disabled:opacity-50"
          >
            {busy ? "…" : "Unlock"}
          </button>
        </form>
        <button
          type="button"
          className="mt-4 w-full text-[12px] text-muted-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground"
          onClick={() => void props.onSignInWithEmail()}
        >
          Forgot PIN? Sign in with email
        </button>
      </div>
    </div>
  );
}

export function ElectronAppPinOffer(props: {
  onSkip: () => void;
  onPinCreated: () => void | Promise<void>;
}): React.ReactElement {
  const [phase, setPhase] = useState<"choice" | "create">("choice");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function savePin(e?: React.FormEvent): Promise<void> {
    e?.preventDefault();
    if (busy) return;
    setError(null);
    if (pin !== confirm) {
      setError("PINs do not match.");
      return;
    }
    setBusy(true);
    try {
      await setElectronAppPin(pin);
      setSessionPinUnlocked();
      await Promise.resolve(props.onPinCreated());
      setPin("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save PIN.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[102] flex items-center justify-center overflow-y-auto bg-background/80 px-4 py-8 backdrop-blur-sm">
      <div className="mx-auto w-full max-w-sm rounded-xl border border-border bg-background p-6 shadow-lg">
        {phase === "choice" ? (
          <>
            <h2 className="text-[14px] font-semibold text-foreground">Quick unlock</h2>
            <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
              Optional PIN: skip your sync password on each app launch. We will not ask for the PIN again until you
              restart the app or sign out of sync. Skip if you prefer your password each time.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <button
                type="button"
                className="archon-auth-submit h-10 w-full rounded-md border border-border text-[13px] font-medium"
                onClick={() => setPhase("create")}
              >
                Set PIN
              </button>
              <button
                type="button"
                className="h-10 w-full rounded-md border border-border bg-muted/20 text-[13px] text-muted-foreground hover:bg-muted/40"
                onClick={() => {
                  markPinOfferDismissed();
                  props.onSkip();
                }}
              >
                Skip
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-[14px] font-semibold text-foreground">Create app PIN</h2>
            <p className="mt-2 text-[12px] text-muted-foreground">4–32 characters. Used only on this device.</p>
            <form className="mt-4 space-y-3" onSubmit={(e) => void savePin(e)}>
              <label className="block text-[12px]">
                <div className="mb-1 text-[11px] font-medium text-muted-foreground">PIN</div>
                <input
                  type="password"
                  className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] outline-none focus:ring-2 focus:ring-muted/40"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  autoFocus
                />
              </label>
              <label className="block text-[12px]">
                <div className="mb-1 text-[11px] font-medium text-muted-foreground">Confirm PIN</div>
                <input
                  type="password"
                  className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] outline-none focus:ring-2 focus:ring-muted/40"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </label>
              {error ? (
                <p className="text-[12px] text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  className="h-10 flex-1 rounded-md border border-border text-[13px] text-muted-foreground hover:bg-muted/30"
                  onClick={() => {
                    setPhase("choice");
                    setPin("");
                    setConfirm("");
                    setError(null);
                  }}
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={busy || !pin.trim()}
                  className="archon-auth-submit h-10 flex-1 rounded-md border border-border text-[13px] font-medium disabled:opacity-50"
                >
                  {busy ? "…" : "Save"}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
