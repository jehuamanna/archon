import type { Note } from "../shared/plugin-api";
import { JS_NOTEBOOK_NOTE_TYPE } from "../shared/note-type-legacy";
import { Registry } from "./registry";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Registers `js-notebook` note type for create-note validation and iframe/HTML fallback.
 * Full editing uses the shell React editor ({@link useRegisterJsNoteEditor}).
 */
export function registerBuiltinJsNotebookNoteRenderer(reg: Registry): void {
  if (reg.getRenderer(JS_NOTEBOOK_NOTE_TYPE)) {
    return;
  }
  reg.registerRenderer(
    "builtin.js-notebook",
    JS_NOTEBOOK_NOTE_TYPE,
    {
      render: async (note: Note) => {
        const body = escapeHtml((note.content ?? "").slice(0, 12_000));
        return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>JS notebook</title></head><body style="margin:0;font:13px system-ui,sans-serif;background:#0b1020;color:#e5e7eb;padding:12px;"><p style="opacity:.75;margin:0 0 8px">JS notebook — use the Archon shell for the full editor.</p><pre style="white-space:pre-wrap;word-break:break-word;margin:0">${body}</pre></body></html>`;
      },
    },
    { theme: "inherit", hostTier: "user" },
  );
}
