import { BrowserWindow, dialog, nativeTheme, session, shell } from "electron";
import * as fs from "fs";
import { watch as chokidarWatch } from "chokidar";
import * as path from "path";
import { Readable } from "node:stream";
import { app } from "electron";
import {
  activateWorkspace,
  deactivateProject,
  getNormalizedWorkspaceRoots,
  readProjectPrefs,
} from "../core/project-session";
import { clearArchonUndoRedo } from "../core/archon-undo";
import { saveNotesState } from "../core/notes-persistence";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { isSafePluginName } from "../shared/validators";
import { ctx, getPluginLoader } from "./main-context";
import { syncWpnLocalHttpBridgeState } from "./wpn-local-http-bridge";
import { parseAssetIpcPayload } from "./parse-asset-ipc-payload";
import { relativeAssetPathFromArchonAssetUrl } from "../shared/archon-asset-path";
import { ARCHON_PDF_WORKER_PROTOCOL_URL } from "../shared/archon-pdf-worker-url";

export { parseAssetIpcPayload };

function normalizeForCompare(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function pathsEqual(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

export function assetsRootForIpc(projectRootOpt: string | undefined): string | null {
  if (projectRootOpt != null && projectRootOpt.length > 0) {
    const abs = path.resolve(projectRootOpt);
    for (const r of ctx.workspaceRoots) {
      if (pathsEqual(r, abs)) {
        return abs;
      }
    }
    return null;
  }
  return ctx.projectRootPath;
}

export function broadcastProjectRootChanged(): void {
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
    ctx.mainWindow.webContents.send(IPC_CHANNELS.PROJECT_ROOT_CHANGED);
  }
}

const ARCHON_ASSET_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".htm": "text/html",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

function mimeForAssetPath(filePath: string): string {
  return ARCHON_ASSET_MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** Parse a single `bytes=…` range for a file of `size` bytes. */
function parseByteRange(
  rangeHeader: string,
  size: number,
): { start: number; end: number } | null {
  const m = /^bytes=([^,]+)$/i.exec(rangeHeader.trim());
  if (!m) {
    return null;
  }
  const spec = m[1]!.trim();
  const dash = spec.indexOf("-");
  if (dash < 0) {
    return null;
  }
  const left = spec.slice(0, dash).trim();
  const right = spec.slice(dash + 1).trim();
  if (left === "" && right === "") {
    return null;
  }
  if (left === "") {
    const suffix = parseInt(right, 10);
    if (Number.isNaN(suffix) || suffix <= 0) {
      return null;
    }
    if (suffix >= size) {
      return { start: 0, end: size - 1 };
    }
    return { start: size - suffix, end: size - 1 };
  }
  const start = parseInt(left, 10);
  if (Number.isNaN(start) || start < 0 || start >= size) {
    return null;
  }
  let end = right === "" ? size - 1 : parseInt(right, 10);
  if (Number.isNaN(end)) {
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  if (start > end) {
    return null;
  }
  return { start, end };
}

function resolveArchonAssetFilePath(requestUrl: string): string | null {
  try {
    const u = new URL(requestUrl);
    const rel = relativeAssetPathFromArchonAssetUrl(u);
    if (!rel) {
      return null;
    }
    const segments = rel.split("/").filter(Boolean);
    const rootParam = u.searchParams.get("root");
    let baseRoot: string | null = null;
    if (rootParam) {
      try {
        // URLSearchParams already decodes; keep this tolerant and realpath-safe.
        const abs = path.resolve(String(rootParam));
        for (const r of ctx.workspaceRoots) {
          if (pathsEqual(r, abs)) {
            baseRoot = abs;
            break;
          }
        }
      } catch {
        /* ignore */
      }
    }
    const candidates: string[] = [];
    if (baseRoot) {
      candidates.push(baseRoot);
    }
    if (ctx.projectRootPath) {
      candidates.push(ctx.projectRootPath);
    }
    for (const r of ctx.workspaceRoots) {
      candidates.push(r);
    }

    const unique: string[] = [];
    for (const c of candidates) {
      if (!unique.some((u) => pathsEqual(u, c))) {
        unique.push(c);
      }
    }

    for (const root of unique) {
      const assetsRoot = path.resolve(path.join(root, "assets"));
      const full = path.resolve(path.join(assetsRoot, ...segments));
      if (!full.startsWith(assetsRoot + path.sep) && full !== assetsRoot) {
        continue;
      }
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return full;
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  } catch {
    return null;
  }
}

function archonAssetResponseForFile(
  request: globalThis.Request,
  full: string,
): Response {
  const stat = fs.statSync(full);
  const size = stat.size;
  const mimeType = mimeForAssetPath(full);
  const common: Record<string, string> = {
    "Content-Type": mimeType,
    "Accept-Ranges": "bytes",
    /** Embedded PDF/media in iframes (srcdoc ↔ custom scheme) — avoid client-side blocking. */
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin": "*",
  };

  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: {
        ...common,
        "Content-Length": String(size),
      },
    });
  }

  const rangeHeader = request.headers.get("range");
  if (!rangeHeader) {
    const nodeStream = fs.createReadStream(full);
    const body = Readable.toWeb(nodeStream) as unknown as BodyInit;
    return new Response(body, {
      status: 200,
      headers: {
        ...common,
        "Content-Length": String(size),
      },
    });
  }

  const parsed = parseByteRange(rangeHeader, size);
  if (!parsed) {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${size}`,
      },
    });
  }
  const { start, end } = parsed;
  const chunkSize = end - start + 1;
  const nodeStream = fs.createReadStream(full, { start, end });
  const body = Readable.toWeb(nodeStream) as unknown as BodyInit;
  return new Response(body, {
    status: 206,
    headers: {
      ...common,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${size}`,
    },
  });
}

/**
 * Custom asset protocol: use `protocol.handle` + explicit byte ranges so PDF / media viewers
 * (Range requests) work. `registerFileProtocol` alone often yields ERR_BLOCKED_BY_CLIENT for PDF.
 */
export function registerArchonAssetProtocol(): void {
  try {
    session.defaultSession.protocol.unhandle("archon-asset");
  } catch {
    /* first registration */
  }
  try {
    session.defaultSession.protocol.unhandle("node-asset");
  } catch {
    /* first registration */
  }

  const handler = (request: globalThis.Request) => {
    const full = resolveArchonAssetFilePath(request.url);
    if (!full) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Promise.resolve(new Response(null, { status: 405 }));
    }
    try {
      return Promise.resolve(archonAssetResponseForFile(request, full));
    } catch (e) {
      console.warn("[archon-asset] response error:", e);
      return Promise.resolve(new Response(null, { status: 500 }));
    }
  };

  session.defaultSession.protocol.handle("archon-asset", handler);
  session.defaultSession.protocol.handle("node-asset", handler);
}

export { ARCHON_PDF_WORKER_PROTOCOL_URL };

/**
 * Resolve webpack-copied `pdf.worker.min.mjs` next to `main_window` (see webpack.renderer.config.js).
 */
export function resolveBundledPdfWorkerPath(): string | null {
  const fileName = "pdf.worker.min.mjs";
  const rel = path.join(".webpack", "renderer", "main_window", fileName);
  const candidates = [
    path.join(app.getAppPath(), rel),
    path.join(__dirname, "..", "renderer", "main_window", fileName),
    path.join(process.cwd(), rel),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return p;
      }
    } catch {
      /* next */
    }
  }
  console.warn(
    "[archon-pdf-worker] pdf.worker.min.mjs not found; tried:",
    candidates,
  );
  return null;
}

function resolvePdfJsDistPackageRoot(): string | null {
  try {
    return path.dirname(require.resolve("pdfjs-dist/package.json"));
  } catch {
    return null;
  }
}

function pathIsUnderParent(filePath: string, parentDir: string): boolean {
  const f = path.resolve(filePath);
  const p = path.resolve(parentDir);
  return f === p || f.startsWith(p + path.sep);
}

function mimeForPdfJsBundledAsset(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".bcmap") {
    return "application/octet-stream";
  }
  if (ext === ".pfb" || ext === ".otf" || ext === ".ttf" || ext === ".woff") {
    return "application/octet-stream";
  }
  return "application/octet-stream";
}

/**
 * Resolve `archon-pdf-worker` URL to a file: worker, or `pdfjs-dist` cmaps / standard_fonts.
 */
function resolveArchonPdfWorkerFile(
  requestUrl: string,
): { full: string; contentType: string } | null {
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return null;
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    /* use raw */
  }
  // Some Chromium fetch paths can include a trailing slash for module imports.
  // Normalize so `/pdf.worker.min.mjs/` maps to the same asset as `/pdf.worker.min.mjs`.
  if (pathname.length > 1) {
    pathname = pathname.replace(/\/+$/, "");
  }
  if (pathname.includes("\0")) {
    return null;
  }

  const baseName = "pdf.worker.min.mjs";
  if (pathname === `/${baseName}` || pathname.endsWith(`/${baseName}`)) {
    const full = resolveBundledPdfWorkerPath();
    if (!full) {
      return null;
    }
    return { full, contentType: "text/javascript; charset=utf-8" };
  }

  const pkgRoot = resolvePdfJsDistPackageRoot();
  if (!pkgRoot) {
    return null;
  }

  const cmapsRoot = path.join(pkgRoot, "cmaps");
  const fontsRoot = path.join(pkgRoot, "standard_fonts");

  if (pathname.startsWith("/cmaps/")) {
    const rest = pathname.slice("/cmaps/".length);
    if (!rest || rest.includes("..")) {
      return null;
    }
    const full = path.join(cmapsRoot, rest);
    if (!pathIsUnderParent(full, cmapsRoot)) {
      return null;
    }
    return { full, contentType: mimeForPdfJsBundledAsset(full) };
  }

  if (pathname.startsWith("/standard_fonts/")) {
    const rest = pathname.slice("/standard_fonts/".length);
    if (!rest || rest.includes("..")) {
      return null;
    }
    const full = path.join(fontsRoot, rest);
    if (!pathIsUnderParent(full, fontsRoot)) {
      return null;
    }
    return { full, contentType: mimeForPdfJsBundledAsset(full) };
  }

  return null;
}

/**
 * Serves bundled pdf.js worker for plugin `about:srcdoc` — dynamic `import()` of a real URL
 * (not `blob:`) so packaged Electron does not fail the fake-worker path.
 * Also serves `cmaps/` and `standard_fonts/` from the `pdfjs-dist` package for `getDocument`.
 */
export function registerArchonPdfWorkerProtocol(): void {
  try {
    session.defaultSession.protocol.unhandle("archon-pdf-worker");
  } catch {
    /* first registration */
  }

  const handler = (request: globalThis.Request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Promise.resolve(new Response(null, { status: 405 }));
    }
    const resolved = resolveArchonPdfWorkerFile(request.url);
    if (!resolved) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const { full, contentType } = resolved;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (!stat.isFile()) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const size = stat.size;
    const common: Record<string, string> = {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Access-Control-Allow-Origin": "*",
    };
    if (request.method === "HEAD") {
      return Promise.resolve(
        new Response(null, {
          status: 200,
          headers: {
            ...common,
            "Content-Length": String(size),
          },
        }),
      );
    }
    /**
     * Packaged builds typically keep renderer assets inside `app.asar`.
     * Electron's asar virtual filesystem is reliable for `readFileSync`, but streaming
     * APIs can be flaky depending on platform/packager (notably AppImage mounts).
     * For the pdf.js worker + bundled cmaps/fonts, small full-file reads are fine and
     * avoid "Failed to fetch dynamically imported module" failures.
     */
    try {
      const buf = fs.readFileSync(full);
      return Promise.resolve(
        new Response(new Uint8Array(buf), {
          status: 200,
          headers: {
            ...common,
            "Content-Length": String(size),
          },
        }),
      );
    } catch (e) {
      console.warn("[archon-pdf-worker] response error:", e);
      return Promise.resolve(new Response(null, { status: 500 }));
    }
  };

  session.defaultSession.protocol.handle("archon-pdf-worker", handler);
}

export function applyWorkspaceActivateResult(res: {
  ok: true;
  root: string;
  dbPath: string;
  workspaceRoots: string[];
  scratch?: boolean;
}): void {
  if (res.workspaceRoots.length === 0) {
    ctx.projectRootPath = null;
    ctx.notesPersistencePath = null;
    ctx.workspaceRoots = [];
    ctx.scratchSession = false;
    syncWpnLocalHttpBridgeState();
    return;
  }
  ctx.projectRootPath = res.root;
  ctx.notesPersistencePath = res.dbPath;
  ctx.workspaceRoots = res.workspaceRoots;
  ctx.scratchSession = res.scratch === true;
  syncWpnLocalHttpBridgeState();
}

export function tryLoadSavedProject(
  userDataPath: string,
  registeredTypes: string[],
): void {
  const prefs = readProjectPrefs(userDataPath);
  const roots = getNormalizedWorkspaceRoots(prefs);
  if (roots.length === 0) {
    ctx.projectRootPath = null;
    ctx.notesPersistencePath = null;
    ctx.workspaceRoots = [];
    ctx.scratchSession = false;
    clearArchonUndoRedo();
    deactivateProject();
    return;
  }
  const r = activateWorkspace(roots, userDataPath, registeredTypes);
  if (r.ok) {
    applyWorkspaceActivateResult(r);
    clearArchonUndoRedo();
    if (ctx.workspaceRoots.length > 0) {
      console.log("[Main] Opened workspace:", ctx.workspaceRoots.join(", "));
    }
    return;
  }
  console.warn("[Main] Could not open saved project:", r.error);
  ctx.projectRootPath = null;
  ctx.notesPersistencePath = null;
  ctx.workspaceRoots = [];
  ctx.scratchSession = false;
  clearArchonUndoRedo();
  deactivateProject();
}

export function persistNotes(): void {
  if (!ctx.notesPersistencePath) {
    return;
  }
  try {
    saveNotesState();
  } catch (e) {
    console.warn("[Main] Failed to save notes:", e);
  }
}

export function assertProjectOpenForNotes(): void {
  if (!ctx.projectRootPath) {
    throw new Error("Open a project folder first (Notes → Open project).");
  }
}

function emitIdeWorkspaceFsChanged(): void {
  ctx.ideWorkspaceWatchTimer = null;
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
    ctx.mainWindow.webContents.send(IPC_CHANNELS.PLUGIN_IDE_WORKSPACE_FS_CHANGED);
  }
}

export function setIdeWorkspaceWatch(pluginName: string | null): void {
  if (ctx.ideWorkspaceWatch) {
    void ctx.ideWorkspaceWatch.close();
    ctx.ideWorkspaceWatch = null;
  }
  if (ctx.ideWorkspaceWatchTimer) {
    clearTimeout(ctx.ideWorkspaceWatchTimer);
    ctx.ideWorkspaceWatchTimer = null;
  }
  if (!pluginName) {
    return;
  }
  if (!isSafePluginName(pluginName)) {
    return;
  }
  const root = getPluginLoader().getPluginWorkspaceAbsolutePath(pluginName);
  if (!root || !fs.existsSync(root)) {
    return;
  }
  try {
    const watcher = chokidarWatch(root, {
      ignored: [
        /(^|[\\/])node_modules([\\/]|$)/,
        /(^|[\\/])\.git([\\/]|$)/,
        /(^|[\\/])dist([\\/]|$)/,
      ],
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
    });
    watcher.on("all", () => {
      if (ctx.ideWorkspaceWatchTimer) {
        clearTimeout(ctx.ideWorkspaceWatchTimer);
      }
      ctx.ideWorkspaceWatchTimer = setTimeout(emitIdeWorkspaceFsChanged, 120);
    });
    watcher.on("error", (err: unknown) => {
      console.warn("[Main] ide workspace chokidar:", err);
    });
    ctx.ideWorkspaceWatch = watcher;
  } catch (e) {
    console.warn("[Main] ide workspace watch:", e);
  }
}

export function getDialogParent(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? ctx.mainWindow ?? undefined;
}

export function showOpenDialogWithParent(
  options: Electron.OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> {
  const parent = getDialogParent();
  return parent
    ? dialog.showOpenDialog(parent, options)
    : dialog.showOpenDialog(options);
}

export function broadcastNativeThemeToRenderers(): void {
  const dark = nativeTheme.shouldUseDarkColors;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.UI_NATIVE_THEME_CHANGED, dark);
    }
  }
}

/**
 * Basenames under `plugins/` (dev) or `Resources/` (packaged) scanned as read-only
 * bundled roots. Order: system (e.g. code editor), user (sample + media plugins), core (optional legacy).
 */
const BUNDLED_READONLY_PLUGIN_ROOT_BASENAMES = ["system", "user", "core"] as const;

function resolveExistingPackagedRoot(base: string): string | null {
  const candidates = [
    path.join(process.resourcesPath, base),
    path.join(process.resourcesPath, "plugins", base),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return null;
}

/** All existing read-only plugin directories shipped with the app (before userData/plugins). */
export function resolveBundledReadonlyPluginRoots(): string[] {
  if (app.isPackaged) {
    const out: string[] = [];
    for (const base of BUNDLED_READONLY_PLUGIN_ROOT_BASENAMES) {
      const resolved = resolveExistingPackagedRoot(base);
      if (resolved) {
        out.push(resolved);
      }
    }
    return out;
  }
  const pluginsParent = path.join(app.getAppPath(), "plugins");
  const out: string[] = [];
  for (const base of BUNDLED_READONLY_PLUGIN_ROOT_BASENAMES) {
    const p = path.join(pluginsParent, base);
    if (fs.existsSync(p)) {
      out.push(p);
    }
  }
  return out;
}

export function broadcastPluginsChanged(): void {
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
    ctx.mainWindow.webContents.send(IPC_CHANNELS.PLUGINS_CHANGED);
  }
}
