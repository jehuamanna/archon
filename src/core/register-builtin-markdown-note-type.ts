import type { Note } from "../shared/plugin-api";
import { Registry } from "./registry";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Registers `markdown` in the main-process registry so create-note IPC and the Notes
 * explorer type picker include it. Full editing uses the shell React editor
 * ({@link useRegisterMarkdownNotePlugin}).
 */
export function registerBuiltinMarkdownNoteRenderer(reg: Registry): void {
  if (reg.getRenderer("markdown")) {
    return;
  }
  reg.registerRenderer(
    "builtin.markdown-note",
    "markdown",
    {
      render: async (note: Note) => {
        const body = escapeHtml((note.content ?? "").slice(0, 12_000));
        return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Markdown</title></head><body style="margin:0;font:13px system-ui,sans-serif;background:#fafafa;color:#171717;padding:12px;"><p style="opacity:.75;margin:0 0 8px">Markdown — use the Archon shell for the full editor.</p><pre style="white-space:pre-wrap;word-break:break-word;margin:0;font-family:ui-monospace,monospace;font-size:12px">${body}</pre></body></html>`;
      },
    },
    { theme: "inherit", hostTier: "user" },
  );
}
