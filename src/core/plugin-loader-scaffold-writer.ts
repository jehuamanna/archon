import * as fs from "fs";
import * as path from "path";

/**
 * Writes default hybrid plugin sources (used when manifest.json is missing).
 */
export function writeHybridPluginScaffoldFiles(
  base: string,
  pluginId: string,
): void {
  fs.writeFileSync(
    path.join(base, ".archonplugin"),
    `${JSON.stringify({ schema: "archon-plugin-root", version: 1 }, null, 2)}\n`,
    "utf8",
  );
  const manifest = {
    name: pluginId,
    version: "1.0.0",
    type: "hybrid" as const,
    main: "src/main.ts",
    ui: "src/ui.tsx",
    mode: "development" as const,
    displayName: pluginId,
    description: "New Archon plugin (scaffolded from Plugin IDE)",
    dependencies: {
      react: "^19.2.0",
      "react-dom": "^19.2.0",
      "@archon/plugin-ui": "^0.0.1",
    },
  };
  fs.writeFileSync(
    path.join(base, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  fs.mkdirSync(path.join(base, "src"), { recursive: true });
  const mainTs = `interface PluginContext {
  subscriptions: { dispose?: () => void }[];
}

interface Note {
  id: string;
  type: string;
  title: string;
  content: string;
  metadata?: unknown;
}

interface PluginApi {
  getUiBootstrap?: () => Promise<string>;
  registerNoteRenderer: (
    type: string,
    renderer: { render: (note: Note) => string | Promise<string> },
  ) => { dispose: () => void };
}

export function activate(context: PluginContext, api: PluginApi): void {
  if (typeof api.getUiBootstrap !== "function") {
    throw new Error("Manifest must declare ui (hybrid plugin).");
  }
  const disposable = api.registerNoteRenderer("${pluginId}-note", {
    render: async (note: Note) => {
      const ui = await api.getUiBootstrap!();
      return \`window.__ARCHON_NOTE__ = \${JSON.stringify(note)};\${ui}\`;
    },
  });
  context.subscriptions.push(disposable);
}

export function deactivate(): void {}
`;
  fs.writeFileSync(path.join(base, "src/main.ts"), mainTs, "utf8");
  const uiTsx = `import React from "react";
import { createRoot } from "react-dom/client";
import type { NotePayload } from "@archon/plugin-ui";
import {
  useArchonHostMessages,
  useArchonIframeApi,
  useNotifyDisplayReady,
} from "@archon/plugin-ui";

declare global {
  interface Window {
    __ARCHON_NOTE__?: NotePayload;
  }
}

function App() {
  const note = window.__ARCHON_NOTE__;
  useNotifyDisplayReady(true);
  useArchonHostMessages();
  useArchonIframeApi();
  if (!note) {
    return <div className="p-4 text-sm">No note</div>;
  }
  return (
    <div className="p-4 text-sm">
      <strong>{note.title}</strong>
      <pre className="mt-2 whitespace-pre-wrap font-mono text-xs">{note.content}</pre>
    </div>
  );
}

const el = document.getElementById("plugin-root");
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
`;
  fs.writeFileSync(path.join(base, "src/ui.tsx"), uiTsx, "utf8");
  const tsconfig = {
    compilerOptions: {
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      noEmit: true,
      lib: ["ES2020", "DOM", "DOM.Iterable"],
    },
    include: ["src/**/*.ts", "src/**/*.tsx"],
  };
  fs.writeFileSync(
    path.join(base, "tsconfig.json"),
    `${JSON.stringify(tsconfig, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(base, ".prettierrc.json"),
    `${JSON.stringify({ semi: true, singleQuote: false }, null, 2)}\n`,
    "utf8",
  );
  const pkg = {
    name: pluginId,
    version: "1.0.0",
    private: true,
    dependencies: {
      react: "^19.2.0",
      "react-dom": "^19.2.0",
      "@archon/plugin-ui": "^0.0.1",
    },
    devDependencies: {
      typescript: "^5.9.0",
      "@types/react": "^19.2.0",
      "@types/react-dom": "^19.2.0",
    },
  };
  fs.writeFileSync(
    path.join(base, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
    "utf8",
  );
}
