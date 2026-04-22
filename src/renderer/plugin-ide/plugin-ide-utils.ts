import type { Note } from "@archon/ui-types";

export const PLUGIN_IDE_FILES_COLLAPSED_KEY = "plugin-ide-files-collapsed";
export const PLUGIN_IDE_TSC_ON_SAVE_KEY = "plugin-ide-tsc-on-save";
export const PLUGIN_IDE_FORMAT_ON_SAVE_KEY = "plugin-ide-format-on-save";
export const PLUGIN_IDE_RELOAD_ON_SAVE_KEY = "plugin-ide-reload-on-save";
export const PLUGIN_IDE_TOOLBAR_MENU_PANEL =
  "absolute left-0 top-full z-50 mt-1 w-[min(18rem,calc(100vw-12px))] rounded-md border border-border bg-background py-1 shadow-lg";
export const PLUGIN_IDE_SNAPSHOT_KEY = "plugin-ide-workspace-snapshot-v1";
export const NODE_MODULES_LIST_MARKER = "node_modules/";
export const PLUGIN_IDE_MAX_SNAPSHOT_FILE_BYTES = 500 * 1024;
export const NPM_DEBOUNCE_MS = 280;
export const PLUGIN_IDE_CUSTOM_EDITOR_KEY = "plugin-ide-custom-editor-cmd";

export interface OpenTab {
  relativePath: string;
  content: string;
  savedContent: string;
  diskMtimeMs: number | null;
}

export interface StoredWorkspaceSnapshot {
  tabs: OpenTab[];
  activePath: string | null;
  cursors: Record<string, { lineNumber: number; column: number }>;
}

export function readSnapshotMap(): Record<string, StoredWorkspaceSnapshot> {
  try {
    const raw = localStorage.getItem(PLUGIN_IDE_SNAPSHOT_KEY);
    if (!raw) {
      return {};
    }
    const p = JSON.parse(raw) as Record<string, StoredWorkspaceSnapshot>;
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

export function writeSnapshotMap(m: Record<string, StoredWorkspaceSnapshot>): void {
  try {
    localStorage.setItem(PLUGIN_IDE_SNAPSHOT_KEY, JSON.stringify(m));
  } catch {
    /* quota */
  }
}

export function formatImportedPathsForStatus(imported: string[] | undefined): string {
  if (!imported?.length) {
    return "";
  }
  const maxShow = 12;
  const head = imported.slice(0, maxShow).join(", ");
  const more =
    imported.length > maxShow
      ? ` (+${imported.length - maxShow} more)`
      : "";
  return ` — ${head}${more}`;
}

export type PathModalState =
  | null
  | { kind: "newFile"; value: string }
  | { kind: "newFolder"; value: string }
  | { kind: "rename"; from: string; value: string };

export function siblingCopyRelativePath(rel: string, isDir: boolean): string {
  const norm = rel.replace(/\\/g, "/").replace(/\/+$/, "");
  if (isDir) {
    const i = norm.lastIndexOf("/");
    const parent = i >= 0 ? norm.slice(0, i) : "";
    const name = i >= 0 ? norm.slice(i + 1) : norm;
    const next = `${name}-copy`;
    return parent ? `${parent}/${next}` : next;
  }
  const i = norm.lastIndexOf("/");
  const dir = i >= 0 ? norm.slice(0, i) : "";
  const base = i >= 0 ? norm.slice(i + 1) : norm;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    const next = `${base}-copy`;
    return dir ? `${dir}/${next}` : next;
  }
  const stem = base.slice(0, dot);
  const ext = base.slice(dot);
  const next = `${stem}-copy${ext}`;
  return dir ? `${dir}/${next}` : next;
}

export function basenameRel(rel: string): string {
  const norm = rel.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

export function normalizePluginRelPath(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function initialPasteDestRel(
  sourceRel: string,
  isDir: boolean,
  pasteIntoDir?: string,
): string {
  const trimmed = pasteIntoDir?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (trimmed) {
    return `${trimmed}/${basenameRel(sourceRel)}`;
  }
  return siblingCopyRelativePath(sourceRel, isDir);
}

export interface InstalledPkg {
  name: string;
  range: string;
  dev: boolean;
}

export interface NpmSearchRow {
  name: string;
  version: string;
  description: string;
  popularity: number;
}

export interface TscDiagnostic {
  relativePath: string;
  line: number;
  column: number;
  message: string;
  category: "error" | "warning" | "suggestion";
  code: number | undefined;
}

export function languageForPath(rel: string): string {
  const lower = rel.toLowerCase();
  if (lower.endsWith(".tsx")) {
    return "typescript";
  }
  if (lower.endsWith(".ts")) {
    return "typescript";
  }
  if (lower.endsWith(".jsx")) {
    return "typescript";
  }
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "javascript";
  }
  if (lower.endsWith(".json")) {
    return "json";
  }
  if (lower.endsWith(".md")) {
    return "markdown";
  }
  if (lower.endsWith(".css")) {
    return "css";
  }
  if (lower.endsWith(".html")) {
    return "html";
  }
  return "plaintext";
}

export function sampleNoteForType(type: string): Note {
  const contentByType: Record<string, string> = {
    root:
      "# Documentation preview\n\n**Root** notes use the same Markdown UI as `markdown` notes.",
    markdown:
      "# Preview\n\nEdit the plugin and **Bundle & reload** to refresh.\n\n- Item one\n- Item two",
    text: "<p><strong>Rich text</strong> preview for this note type.</p>",
    code: 'function preview() {\n  return "hello";\n}\n',
  };
  const metadata =
    type === "code" ? { language: "javascript" } : undefined;
  return {
    id: "ide-preview",
    type,
    title: "Plugin preview",
    content: contentByType[type] ?? `# Preview (${type})\n\nSample body.`,
    metadata,
  };
}
