import type { Note } from "../shared/plugin-api";
import { Registry } from "./registry";

/**
 * Registers `image` in the main-process registry so create-note IPC and the Notes
 * explorer type picker include it. Full rendering uses the shell React editor
 * ({@link useRegisterImageNotesPlugin}); this fallback renderer is only reached
 * when that plugin is unregistered (e.g. diagnostic / preview contexts).
 */
export function registerBuiltinImageNoteRenderer(reg: Registry): void {
  if (reg.getRenderer("image")) {
    return;
  }
  reg.registerRenderer(
    "builtin.image-note",
    "image",
    {
      render: async (note: Note) => {
        const meta = (note.metadata ?? {}) as Record<string, unknown>;
        const sizeBytes = typeof meta.sizeBytes === "number" ? meta.sizeBytes : null;
        const mimeType = typeof meta.mimeType === "string" ? meta.mimeType : "unknown";
        const hasAsset = typeof meta.r2Key === "string" && meta.r2Key.length > 0;
        const body = hasAsset
          ? `Image note — ${mimeType}${sizeBytes != null ? `, ${sizeBytes} bytes` : ""}. Use the Archon shell to view it.`
          : "Image note — empty. Use the Archon shell to upload an image.";
        return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Image</title></head><body style="margin:0;font:13px system-ui,sans-serif;background:#fafafa;color:#171717;padding:12px;"><p style="margin:0">${body}</p></body></html>`;
      },
    },
    { theme: "inherit", hostTier: "user" },
  );
}
