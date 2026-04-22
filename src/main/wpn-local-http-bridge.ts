import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { app } from "electron";
import { registry } from "../core/registry";
import { getNotesDatabase } from "../core/workspace-store";
import { getWpnOwnerId } from "../core/wpn/wpn-owner";
import {
  wpnJsonCreateProject,
  wpnJsonCreateWorkspace,
  wpnJsonDeleteProject,
  wpnJsonDeleteWorkspace,
  wpnJsonListProjects,
  wpnJsonListWorkspaces,
  wpnJsonUpdateProject,
  wpnJsonUpdateWorkspace,
} from "../core/wpn/wpn-json-service";
import {
  WpnJsonDuplicateTitleError,
  WPN_LOCAL_DUPLICATE_NOTE_TITLE_MESSAGE,
  wpnJsonCreateNote,
  wpnJsonDeleteNotes,
  wpnJsonDuplicateNoteSubtree,
  wpnJsonGetNoteById,
  wpnJsonListAllNotesWithContext,
  wpnJsonListBacklinksToNote,
  wpnJsonListNotesFlat,
  wpnJsonMoveNote,
  wpnJsonUpdateNote,
} from "../core/wpn/wpn-json-notes";
import { wpnJsonApplyVfsRewritesAfterTitleChange } from "../core/wpn/wpn-rename-vfs-rewrite";
import { isValidNoteId, isValidNoteType } from "../shared/validators";
import { ctx } from "./main-context";

const MCP_STATE_FILE = "archon-local-wpn-mcp.json";

let bridgeServer: http.Server | null = null;
let bridgeToken: string | null = null;

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function bearerFromRequest(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) {
    return null;
  }
  return h.slice("Bearer ".length).trim() || null;
}

function resolveBridgeToken(userDataPath: string): string {
  const fromEnv = process.env.ARCHON_LOCAL_WPN_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const statePath = path.join(userDataPath, MCP_STATE_FILE);
  try {
    if (fs.existsSync(statePath)) {
      const raw = JSON.parse(fs.readFileSync(statePath, "utf8")) as { token?: string };
      if (typeof raw.token === "string" && raw.token.length > 0) {
        return raw.token;
      }
    }
  } catch {
    /* fall through */
  }
  const token = crypto.randomBytes(24).toString("hex");
  try {
    fs.writeFileSync(
      statePath,
      JSON.stringify({ token, baseUrl: null, updatedAtMs: Date.now() }, null, 2),
      "utf8",
    );
  } catch (e) {
    console.warn("[WPN local HTTP] Could not persist MCP token file:", e);
  }
  return token;
}

function persistBridgeMeta(userDataPath: string, baseUrl: string, token: string): void {
  const statePath = path.join(userDataPath, MCP_STATE_FILE);
  try {
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          token,
          baseUrl,
          updatedAtMs: Date.now(),
          hint: "Use baseUrl + Bearer token in ARCHON_LOCAL_WPN_URL / ARCHON_LOCAL_WPN_TOKEN for @archon-studio/mcp.",
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (e) {
    console.warn("[WPN local HTTP] Could not write MCP meta file:", e);
  }
}

function stopBridge(): void {
  if (bridgeServer) {
    try {
      bridgeServer.close();
    } catch {
      /* ignore */
    }
    bridgeServer = null;
  }
  bridgeToken = null;
}

function requireStore() {
  const store = getNotesDatabase();
  if (!store) {
    throw new Error("Workspace store is not open");
  }
  return store;
}

function handleWpnRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
): void {
  void (async () => {
    try {
      const auth = bearerFromRequest(req);
      if (!auth || auth !== token) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      const method = (req.method ?? "GET").toUpperCase();
      const ownerId = getWpnOwnerId();

      if (method === "GET" && pathname === "/wpn/workspaces") {
        const store = requireStore();
        const workspaces = wpnJsonListWorkspaces(store, ownerId);
        sendJson(res, 200, { workspaces });
        return;
      }

      if (method === "POST" && pathname === "/wpn/workspaces") {
        const store = requireStore();
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const name =
          typeof body.name === "string" ? body.name : "Workspace";
        const workspace = wpnJsonCreateWorkspace(store, ownerId, name);
        sendJson(res, 201, { workspace });
        return;
      }

      // PATCH /wpn/workspaces/:id — update workspace
      const wsIdMatch = /^\/wpn\/workspaces\/([^/]+)$/.exec(pathname);
      if (method === "PATCH" && wsIdMatch) {
        const workspaceId = decodeURIComponent(wsIdMatch[1]!);
        const store = requireStore();
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const patch: { name?: string; sort_index?: number; color_token?: string | null } = {};
        if (typeof body.name === "string") patch.name = body.name;
        if (typeof body.sort_index === "number") patch.sort_index = body.sort_index;
        if (body.color_token === null || typeof body.color_token === "string")
          patch.color_token = body.color_token as string | null;
        const workspace = wpnJsonUpdateWorkspace(store, ownerId, workspaceId, patch);
        if (!workspace) {
          sendJson(res, 404, { error: "Workspace not found" });
          return;
        }
        sendJson(res, 200, { workspace });
        return;
      }

      // DELETE /wpn/workspaces/:id — delete workspace
      if (method === "DELETE" && wsIdMatch) {
        const workspaceId = decodeURIComponent(wsIdMatch[1]!);
        const store = requireStore();
        const ok = wpnJsonDeleteWorkspace(store, ownerId, workspaceId);
        if (!ok) {
          sendJson(res, 404, { error: "Workspace not found" });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      const wsProjectsMatch = /^\/wpn\/workspaces\/([^/]+)\/projects$/.exec(pathname);

      // POST /wpn/workspaces/:workspaceId/projects — create project
      if (method === "POST" && wsProjectsMatch) {
        const workspaceId = decodeURIComponent(wsProjectsMatch[1]!);
        const store = requireStore();
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const name = typeof body.name === "string" ? body.name : "Project";
        try {
          const project = wpnJsonCreateProject(store, ownerId, workspaceId, name);
          sendJson(res, 201, { project });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          sendJson(res, msg === "Workspace not found" ? 404 : 400, { error: msg });
        }
        return;
      }

      if (method === "GET" && wsProjectsMatch) {
        const workspaceId = decodeURIComponent(wsProjectsMatch[1]!);
        const store = requireStore();
        try {
          const projects = wpnJsonListProjects(store, ownerId, workspaceId);
          sendJson(res, 200, { projects });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === "Workspace not found") {
            sendJson(res, 404, { error: msg });
            return;
          }
          sendJson(res, 400, { error: msg });
        }
        return;
      }

      const projNotesMatch = /^\/wpn\/projects\/([^/]+)\/notes$/.exec(pathname);
      if (method === "GET" && projNotesMatch) {
        const projectId = decodeURIComponent(projNotesMatch[1]!);
        const store = requireStore();
        try {
          const notes = wpnJsonListNotesFlat(store, ownerId, projectId);
          sendJson(res, 200, { notes });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === "Project not found") {
            sendJson(res, 404, { error: msg });
            return;
          }
          sendJson(res, 400, { error: msg });
        }
        return;
      }

      if (method === "GET" && pathname === "/wpn/notes-with-context") {
        const store = requireStore();
        const notes = wpnJsonListAllNotesWithContext(store, ownerId);
        sendJson(res, 200, { notes });
        return;
      }

      const notePathMatch = /^\/wpn\/notes\/([^/]+)$/.exec(pathname);
      if (method === "GET" && notePathMatch) {
        const id = decodeURIComponent(notePathMatch[1]!);
        const store = requireStore();
        const n = wpnJsonGetNoteById(store, ownerId, id);
        if (!n) {
          sendJson(res, 404, { error: "Note not found" });
          return;
        }
        sendJson(res, 200, { note: n });
        return;
      }

      if (method === "PATCH" && notePathMatch) {
        const id = decodeURIComponent(notePathMatch[1]!);
        if (!isValidNoteId(id)) {
          sendJson(res, 400, { error: "Invalid note id" });
          return;
        }
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const patch: {
          title?: string;
          content?: string;
          type?: string;
          metadata?: Record<string, unknown> | null;
        } = {};
        if (typeof body.title === "string") {
          patch.title = body.title;
        }
        if (typeof body.content === "string") {
          patch.content = body.content;
        }
        if (typeof body.type === "string") {
          patch.type = body.type;
        }
        if (body.metadata === null || (body.metadata && typeof body.metadata === "object")) {
          patch.metadata = body.metadata as Record<string, unknown> | null;
        }
        const store = requireStore();
        const before =
          patch.title !== undefined ? wpnJsonGetNoteById(store, ownerId, id) : null;
        let note;
        try {
          note = wpnJsonUpdateNote(store, ownerId, id, patch);
        } catch (e) {
          if (e instanceof WpnJsonDuplicateTitleError) {
            sendJson(res, 409, { error: WPN_LOCAL_DUPLICATE_NOTE_TITLE_MESSAGE });
            return;
          }
          throw e;
        }
        if (!note) {
          sendJson(res, 404, { error: "Note not found" });
          return;
        }
        if (
          before &&
          patch.title !== undefined &&
          (patch.title.trim() || before.title) !== before.title
        ) {
          wpnJsonApplyVfsRewritesAfterTitleChange(store, ownerId, id, before.title, note.title);
        }
        sendJson(res, 200, { note });
        return;
      }

      const postNoteMatch = /^\/wpn\/projects\/([^/]+)\/notes$/.exec(pathname);
      if (method === "POST" && postNoteMatch) {
        const projectId = decodeURIComponent(postNoteMatch[1]!);
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const type = typeof body.type === "string" ? body.type.trim() : "";
        const rel = body.relation;
        if (!type) {
          sendJson(res, 400, { error: "Invalid note type" });
          return;
        }
        const selectable = registry.getSelectableNoteTypes();
        if (!isValidNoteType(type) || !selectable.includes(type)) {
          sendJson(res, 400, { error: "Invalid note type" });
          return;
        }
        if (rel !== "child" && rel !== "sibling" && rel !== "root") {
          sendJson(res, 400, { error: "Invalid relation" });
          return;
        }
        const anchorId = typeof body.anchorId === "string" ? body.anchorId : undefined;
        const store = requireStore();
        try {
          const created = wpnJsonCreateNote(store, ownerId, projectId, {
            anchorId: rel === "root" ? undefined : anchorId,
            relation: rel,
            type,
            content: typeof body.content === "string" ? body.content : undefined,
            title: typeof body.title === "string" ? body.title : undefined,
            metadata:
              body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
                ? (body.metadata as Record<string, unknown>)
                : undefined,
          });
          sendJson(res, 201, created);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === "Project not found") {
            sendJson(res, 404, { error: msg });
            return;
          }
          sendJson(res, 400, { error: msg });
        }
        return;
      }

      // PATCH /wpn/projects/:id — update project
      const projIdMatch = /^\/wpn\/projects\/([^/]+)$/.exec(pathname);
      if (method === "PATCH" && projIdMatch) {
        const projectId = decodeURIComponent(projIdMatch[1]!);
        const store = requireStore();
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const patch: { name?: string; sort_index?: number; color_token?: string | null; workspace_id?: string } = {};
        if (typeof body.name === "string") patch.name = body.name;
        if (typeof body.sort_index === "number") patch.sort_index = body.sort_index;
        if (body.color_token === null || typeof body.color_token === "string")
          patch.color_token = body.color_token as string | null;
        if (typeof body.workspace_id === "string") patch.workspace_id = body.workspace_id;
        const project = wpnJsonUpdateProject(store, ownerId, projectId, patch);
        if (!project) {
          sendJson(res, 404, { error: "Project not found" });
          return;
        }
        sendJson(res, 200, { project });
        return;
      }

      // DELETE /wpn/projects/:id — delete project
      if (method === "DELETE" && projIdMatch) {
        const projectId = decodeURIComponent(projIdMatch[1]!);
        const store = requireStore();
        const ok = wpnJsonDeleteProject(store, ownerId, projectId);
        if (!ok) {
          sendJson(res, 404, { error: "Project not found" });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      // POST /wpn/notes/delete — bulk delete notes
      if (method === "POST" && pathname === "/wpn/notes/delete") {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const raw = body.ids;
        if (!Array.isArray(raw)) {
          sendJson(res, 400, { error: "Expected ids array" });
          return;
        }
        const ids = raw.filter((x): x is string => typeof x === "string");
        const store = requireStore();
        wpnJsonDeleteNotes(store, ownerId, ids);
        sendJson(res, 200, { ok: true });
        return;
      }

      // POST /wpn/notes/move — move note (drag & drop)
      if (method === "POST" && pathname === "/wpn/notes/move") {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const projectId = typeof body.projectId === "string" ? body.projectId : "";
        const draggedId = typeof body.draggedId === "string" ? body.draggedId : "";
        const targetId = typeof body.targetId === "string" ? body.targetId : "";
        const p = body.placement;
        if (!projectId || !draggedId || !targetId) {
          sendJson(res, 400, { error: "projectId, draggedId, targetId required" });
          return;
        }
        if (p !== "before" && p !== "after" && p !== "into") {
          sendJson(res, 400, { error: "Invalid placement (before | after | into)" });
          return;
        }
        const store = requireStore();
        try {
          wpnJsonMoveNote(store, ownerId, projectId, draggedId, targetId, p);
          sendJson(res, 200, { ok: true });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          sendJson(res, msg === "Project not found" ? 404 : 400, { error: msg });
        }
        return;
      }

      // POST /wpn/projects/:projectId/notes/:noteId/duplicate — duplicate subtree
      const dupMatch = /^\/wpn\/projects\/([^/]+)\/notes\/([^/]+)\/duplicate$/.exec(pathname);
      if (method === "POST" && dupMatch) {
        const projectId = decodeURIComponent(dupMatch[1]!);
        const noteId = decodeURIComponent(dupMatch[2]!);
        const store = requireStore();
        try {
          const result = wpnJsonDuplicateNoteSubtree(store, ownerId, projectId, noteId);
          sendJson(res, 201, result);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          sendJson(res, msg === "Project not found" ? 404 : 400, { error: msg });
        }
        return;
      }

      // GET /wpn/backlinks/:noteId — list notes referencing a given note
      const backlinksMatch = /^\/wpn\/backlinks\/([^/]+)$/.exec(pathname);
      if (method === "GET" && backlinksMatch) {
        const noteId = decodeURIComponent(backlinksMatch[1]!);
        const store = requireStore();
        const sources = wpnJsonListBacklinksToNote(store, ownerId, noteId);
        sendJson(res, 200, { sources });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendJson(res, 500, { error: msg });
    }
  })();
}

/**
 * Start or stop the loopback WPN HTTP bridge for MCP (`@archon-studio/mcp` local mode).
 * Enable with `ARCHON_WPN_LOCAL_HTTP=1`. Token: `ARCHON_LOCAL_WPN_TOKEN` or persisted under userData.
 */
export function syncWpnLocalHttpBridgeState(): void {
  if (!app.isReady()) {
    return;
  }
  const userDataPath = app.getPath("userData");
  const enabled = envFlag("ARCHON_WPN_LOCAL_HTTP");
  const store = getNotesDatabase();
  const vaultOpen = ctx.workspaceRoots.length > 0 && store !== null;

  if (!enabled || !vaultOpen) {
    stopBridge();
    return;
  }

  const token = resolveBridgeToken(userDataPath);
  if (bridgeServer && bridgeToken === token) {
    return;
  }

  stopBridge();
  bridgeToken = token;

  const server = http.createServer((req, res) => {
    handleWpnRequest(req, res, token);
  });

  const portRaw = process.env.ARCHON_WPN_LOCAL_HTTP_PORT?.trim();
  const port = portRaw ? parseInt(portRaw, 10) : 0;
  const listenPort = Number.isFinite(port) && port >= 0 ? port : 0;

  server.listen(listenPort, "127.0.0.1", () => {
    const addr = server.address();
    const p = typeof addr === "object" && addr ? addr.port : listenPort;
    const baseUrl = `http://127.0.0.1:${p}`;
    bridgeServer = server;
    console.log(`[WPN local HTTP] MCP bridge listening ${baseUrl} (Bearer token in userData ${MCP_STATE_FILE} or ARCHON_LOCAL_WPN_TOKEN)`);
    persistBridgeMeta(userDataPath, baseUrl, token);
  });

  server.on("error", (err) => {
    console.error("[WPN local HTTP] server error:", err);
    stopBridge();
  });
}
