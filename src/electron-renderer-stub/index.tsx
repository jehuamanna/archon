import React from "react";
import { createRoot } from "react-dom/client";

/**
 * Fallback when the main window does not load the Next.js UI (misconfiguration or missing static export).
 */
const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <p style={{ padding: 16, fontFamily: "system-ui, sans-serif", lineHeight: 1.5 }}>
      Archon UI is served by the Next.js app. For development, run{" "}
      <code style={{ background: "#eee", padding: "2px 6px" }}>npm run dev:web</code> then start
      Electron with <code style={{ background: "#eee", padding: "2px 6px" }}>npm start</code>{" "}
      (it loads <code style={{ background: "#eee", padding: "2px 6px" }}>http://127.0.0.1:3000</code>{" "}
      by default). For production, build the static UI with{" "}
      <code style={{ background: "#eee", padding: "2px 6px" }}>npm run build:web:static</code>{" "}
      before packaging.
    </p>,
  );
}
