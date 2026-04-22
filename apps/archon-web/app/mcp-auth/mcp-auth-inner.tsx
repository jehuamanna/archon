"use client";

import { ARCHON_SYNC_ACCESS_TOKEN_KEY } from "@archon/platform";
import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { buildMcpDevicePostAuthSignInHref } from "../../../../src/renderer/auth/post-auth-redirect";

export function McpAuthInner(): ReactElement {
  const searchParams = useSearchParams();
  const userCode = searchParams.get("user_code")?.trim() ?? "";
  const [status, setStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState<string>("");
  const signInHref = useMemo(
    () => (userCode ? buildMcpDevicePostAuthSignInHref(userCode) : ""),
    [userCode],
  );

  const authorize = useCallback(async () => {
    if (!userCode) {
      setStatus("error");
      setMessage("Missing user_code in the URL. Start again from your MCP client.");
      return;
    }
    let token: string | null = null;
    try {
      token = localStorage.getItem(ARCHON_SYNC_ACCESS_TOKEN_KEY);
    } catch {
      token = null;
    }
    if (!token) {
      setStatus("error");
      setMessage(
        "You are not signed in to Archon in this browser. Use “Sign in to Archon” below, then click Confirm authorization again.",
      );
      return;
    }
    setStatus("working");
    setMessage("");
    try {
      const res = await fetch("/api/v1/auth/mcp/device/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ user_code: userCode }),
      });
      const text = await res.text();
      let body: { error?: unknown; ok?: boolean; status?: string } = {};
      try {
        body = text ? (JSON.parse(text) as typeof body) : {};
      } catch {
        body = {};
      }
      if (!res.ok) {
        const err =
          typeof body.error === "string"
            ? body.error
            : `Request failed (${res.status})`;
        setStatus("error");
        setMessage(err);
        return;
      }
      setStatus("done");
      setMessage(
        "MCP access authorized. You can close this tab and return to your editor; the MCP client will finish signing in.",
      );
    } catch (e) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }, [userCode]);

  return (
    <main style={{ maxWidth: 520, margin: "48px auto", padding: "0 16px", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: "1.35rem" }}>Authorize MCP access</h1>
      <p style={{ color: "#444", lineHeight: 1.5 }}>
        A Cursor or other MCP client requested access to your Archon account using this browser
        session. If you started that login, continue below. This grants the MCP process the same API
        access as your signed-in web session until you log out of MCP or tokens expire.
      </p>
      {!userCode ? (
        <p style={{ color: "#a40" }}>No user_code in the link. Close this page and restart from MCP.</p>
      ) : (
        <p style={{ fontSize: "0.9rem", color: "#666" }}>
          Request code: <code>{userCode}</code>
        </p>
      )}
      {userCode && signInHref ? (
        <p style={{ marginTop: 20, fontSize: "0.9rem", lineHeight: 1.5 }}>
          <a
            href={signInHref}
            style={{ color: "#0369a1", fontWeight: 600, textDecoration: "underline" }}
          >
            Sign in to Archon
          </a>{" "}
          (or create an account). After signing in you will return here to finish MCP authorization.
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => void authorize()}
        disabled={status === "working" || !userCode}
        style={{
          marginTop: 16,
          padding: "10px 18px",
          fontSize: "1rem",
          cursor: status === "working" || !userCode ? "not-allowed" : "pointer",
        }}
      >
        {status === "working" ? "Authorizing…" : "Confirm authorization"}
      </button>
      {message ? (
        <p
          style={{
            marginTop: 20,
            color: status === "error" ? "#a40" : "#063",
            whiteSpace: "pre-wrap",
          }}
        >
          {message}
        </p>
      ) : null}
    </main>
  );
}
