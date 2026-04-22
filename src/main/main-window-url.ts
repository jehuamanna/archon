import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "node:url";

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;

export function resolveMainWindowLoadUrl(): string {
  if (process.env.NODE_ENV === "development") {
    return process.env.ARCHON_WEB_DEV_URL ?? "http://127.0.0.1:3000";
  }
  const packaged = path.join(process.resourcesPath, "archon-web", "index.html");
  if (fs.existsSync(packaged)) {
    return pathToFileURL(packaged).href;
  }
  return MAIN_WINDOW_WEBPACK_ENTRY;
}

/** Chromium net::Error codes: refused, timeout, DNS, unreachable, etc. */
export const DEV_SERVER_NET_ERRORS = new Set([-101, -102, -105, -106, -109, -118]);

export function devServerMissingDataUrl(expectedUrl: string): string {
  const safe = expectedUrl
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Archon — dev UI unavailable</title><style>body{font-family:system-ui,sans-serif;padding:24px;max-width:560px;line-height:1.5;color:#111;background:#fafafa}code{background:#eee;padding:2px 6px;border-radius:4px;font-size:.9em}kbd{font-family:inherit;border:1px solid #ccc;border-radius:4px;padding:1px 6px}</style></head><body><h1 style="font-size:1.25rem;margin-top:0">Cannot reach the Archon web UI</h1><p>In development, this window loads <code>${safe}</code>, but nothing is accepting connections there.</p><p>From the repo root, run:</p><pre style="background:#eee;padding:12px;border-radius:6px;overflow:auto">npm run dev:web</pre><p>Then press <kbd>Ctrl+R</kbd> (or <kbd>Cmd+R</kbd> on macOS) to reload.</p><p>To use another URL, set <code>ARCHON_WEB_DEV_URL</code>.</p></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
