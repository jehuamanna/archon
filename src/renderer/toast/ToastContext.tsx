import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { registerGlobalToast, unregisterGlobalToast } from "./toast-service";

export type ToastSeverity = "error" | "warning" | "info" | "log";

export type ShowToastOptions = {
  severity: ToastSeverity;
  message: string;
  /** Same key + severity merges lines and resets the dismiss timer. */
  mergeKey?: string;
};

type ToastState = {
  severity: ToastSeverity;
  text: string;
  mergeKey: string;
};

const DISMISS_MS = 5000;

const ToastContext = createContext<{
  showToast: (opts: ShowToastOptions) => void;
} | null>(null);

function severityBorder(sev: ToastSeverity): string {
  switch (sev) {
    case "error":
      return "1px solid var(--danger, #c62828)";
    case "warning":
      return "1px solid var(--warning, #f9a825)";
    case "info":
      return "1px solid var(--accent, #1976d2)";
    default:
      return "1px solid var(--border-subtle, rgba(128,128,128,0.35))";
  }
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const showToast = useCallback((opts: ShowToastOptions) => {
    const mergeKey = opts.mergeKey ?? `${opts.severity}:default`;
    const msg = opts.message.trim();
    if (!msg) {
      return;
    }
    setToast((prev) => {
      if (
        prev &&
        prev.mergeKey === mergeKey &&
        prev.severity === opts.severity
      ) {
        const nextText = prev.text.includes(msg)
          ? prev.text
          : `${prev.text}\n${msg}`;
        return { ...prev, text: nextText };
      }
      return {
        severity: opts.severity,
        text: msg,
        mergeKey,
      };
    });
  }, []);

  useEffect(() => {
    registerGlobalToast(showToast);
    return () => {
      unregisterGlobalToast();
    };
  }, [showToast]);

  useEffect(() => {
    if (!toast) {
      clearTimer();
      return;
    }
    clearTimer();
    timerRef.current = setTimeout(() => {
      setToast(null);
      timerRef.current = null;
    }, DISMISS_MS);
    return clearTimer;
  }, [toast, clearTimer]);

  const copyText = useCallback(() => {
    if (!toast?.text) {
      return;
    }
    void navigator.clipboard.writeText(toast.text).catch(() => {
      /* ignore */
    });
  }, [toast?.text]);

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? (
        <div
          className="archon-toast-host"
          style={{
            position: "fixed",
            top: 12,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 100000,
            maxWidth: "min(560px, calc(100vw - 24px))",
            fontSize: "12px",
            lineHeight: 1.35,
            padding: "8px 10px",
            borderRadius: 8,
            background: "var(--bg-elevated, #2a2a2e)",
            color: "var(--text-primary, #e8e8ec)",
            boxShadow: "0 4px 24px rgba(0,0,0,0.35)",
            border: severityBorder(toast.severity),
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
          role="status"
          aria-live="polite"
        >
          <pre
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "inherit",
              fontSize: "inherit",
            }}
          >
            {toast.text}
          </pre>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              className="rounded-sm border border-border bg-background px-2 py-1 text-[11px] text-foreground hover:bg-muted/50"
              onClick={copyText}
              title="Copy full message"
              aria-label="Copy full message"
            >
              Copy
            </button>
            <button
              type="button"
              className="rounded-sm border border-border bg-background px-2 py-1 text-[11px] text-foreground hover:bg-muted/50"
              onClick={() => {
                clearTimer();
                setToast(null);
              }}
              title="Dismiss"
              aria-label="Dismiss"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
    </ToastContext.Provider>
  );
};

export function useToast(): { showToast: (opts: ShowToastOptions) => void } {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return {
      showToast: () => {
        /* no provider */
      },
    };
  }
  return ctx;
}
