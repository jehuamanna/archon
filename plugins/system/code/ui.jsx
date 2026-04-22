import React from "react";
import { createRoot } from "react-dom/client";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import Editor from "@monaco-editor/react";

loader.config({ monaco });

function readNoteMeta() {
  if (typeof window === "undefined" || !window.__ARCHON_NOTE__) {
    return { content: "", language: "javascript" };
  }
  const n = window.__ARCHON_NOTE__;
  const language =
    n.metadata && n.metadata.language ? n.metadata.language : "javascript";
  return { content: n.content || "", language };
}

function CodeApp() {
  const initial = readNoteMeta();
  const [value, setValue] = React.useState(initial.content);
  const [language, setLanguage] = React.useState(initial.language);
  const [monacoDark, setMonacoDark] = React.useState(() =>
    typeof document !== "undefined"
      ? document.documentElement.classList.contains("dark")
      : false,
  );

  React.useEffect(() => {
    const el = document.documentElement;
    const sync = () => setMonacoDark(el.classList.contains("dark"));
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    sync();
    return () => obs.disconnect();
  }, []);

  React.useEffect(() => {
    Archon.onMessage = (message) => {
      if (message.type === "update" || message.type === "render") {
        window.__ARCHON_NOTE__ = message.payload;
        const p = message.payload;
        setValue(p.content || "");
        setLanguage(
          p.metadata && p.metadata.language ? p.metadata.language : "javascript",
        );
      }
    };
  }, []);

  return (
    <div
      style={{
        height: "100%",
        minHeight: "420px",
        border: "1px solid hsl(var(--border, 214.3 31.8% 91.4%))",
        borderRadius: "0.5rem",
        overflow: "hidden",
      }}
    >
      <Editor
        height="100%"
        language={language}
        theme={monacoDark ? "vs-dark" : "vs"}
        value={value}
        onChange={(v) => setValue(v ?? "")}
        options={{
          minimap: { enabled: false },
          fontSize: 14,
          automaticLayout: true,
          scrollBeyondLastLine: false,
        }}
      />
    </div>
  );
}

const mountEl = document.getElementById("plugin-root");
if (mountEl) {
  createRoot(mountEl).render(<CodeApp />);
}
