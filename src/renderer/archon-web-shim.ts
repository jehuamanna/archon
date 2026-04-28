import { createSyncBaseUrlResolver, SessionExpiredError } from "@archon/platform";
import { PLUGIN_UI_METADATA_KEY, validatePluginUiStateSize } from "../shared/plugin-state-protocol";
import type {
  MarketplaceListResponse,
  ArchonRendererApi,
  Note,
  NoteListItem,
} from "../shared/archon-renderer-api";
import type { WpnNoteDetail, WpnNoteListItem } from "../shared/wpn-v2-types";
import { authRefresh } from "./auth/auth-client";
import { authedFetch } from "./auth/auth-retry";
import { getAccessToken, setAccessToken } from "./auth/auth-session";
import { terminateSession } from "./auth/session-termination";
import { readElectronRunMode } from "./auth/electron-run-mode";
import { isWebScratchSession } from "./auth/web-scratch";
import {
  readCloudSyncRefreshToken,
  readCloudSyncToken,
} from "./cloud-sync/cloud-sync-storage";
import { assertSignedInCloudWpnOnlineForMutation } from "./cloud-sync/signed-in-cloud-offline";
import {
  useWebTryoutWpnIndexedDb,
  webScratchPlainStubOverrides,
} from "./wpnscratch/web-scratch-archon-api";
import { wpnTrace } from "../shared/wpn-debug-trace";

const noopUnsub = (): void => {};

const resolveSyncApiBase = createSyncBaseUrlResolver();

/** Route WPN HTTP to Fastify sync-api (`/wpn/*`) instead of headless Express (`/api/v1/wpn/*`). */
export function syncWpnUsesSyncApi(): boolean {
  if (typeof window !== "undefined" && window.__ARCHON_WPN_USE_SYNC_API__ === true) {
    return true;
  }
  if (typeof window !== "undefined" && window.__ARCHON_ELECTRON_WPN_BACKEND__ === "cloud") {
    return true;
  }
  if (typeof window !== "undefined" && isElectronUserAgent() && readElectronRunMode() === "cloud") {
    return true;
  }
  try {
    if (process.env.NEXT_PUBLIC_ARCHON_WPN_USE_SYNC_API === "1") {
      return true;
    }
    const syncUrl =
      typeof process.env.NEXT_PUBLIC_ARCHON_SYNC_API_URL === "string"
        ? process.env.NEXT_PUBLIC_ARCHON_SYNC_API_URL.trim()
        : "";
    if (syncUrl.length > 0) {
      return true;
    }
  } catch {
    /* no process in some bundles */
  }
  return false;
}

/** Sync WPN mode with a resolved sync base: use `/wpn/*` for note data (no legacy `/api/v1/notes/*`). */
export function syncWpnNotesBackend(): boolean {
  return syncWpnUsesSyncApi() && resolveSyncApiBase().trim().length > 0;
}

/**
 * When true, `webRequest` (headless Express `/api/v1`) is disabled — use archon-sync-api only.
 * Set `NEXT_PUBLIC_ARCHON_WEB_BACKEND=sync-only` (ignored in Electron renderer).
 */
export function archonWebBackendSyncOnly(): boolean {
  if (typeof navigator !== "undefined" && navigator.userAgent.includes("Electron")) {
    return false;
  }
  try {
    return process.env.NEXT_PUBLIC_ARCHON_WEB_BACKEND === "sync-only";
  } catch {
    return false;
  }
}

const WPN_BUILTIN_NOTE_TYPES = ["markdown", "mdx", "text", "code", "root", "image"] as const;

async function wpnAggregateAllNoteListItems(
  headlessBaseUrl: string,
): Promise<NoteListItem[]> {
  if (syncWpnNotesBackend()) {
    try {
      const { notes } = await wpnHttp<{ notes: WpnNoteListItem[] }>(
        headlessBaseUrl,
        "GET",
        "/wpn/all-notes-list",
      );
      const list = notes ?? [];
      return list.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        parentId: n.parent_id,
        depth: n.depth,
      }));
    } catch {
      /**
       * Signed-in cloud mode: never fall back to headless JSON file WPN — that is not SoT.
       * (Legacy headless-only builds may still use the loop below when sync API is not configured.)
       */
      if (syncWpnUsesSyncApi() && resolveSyncApiBase().trim().length > 0) {
        return [];
      }
    }
  }
  const { workspaces } = await wpnHttp<{ workspaces: { id: string }[] }>(
    headlessBaseUrl,
    "GET",
    "/wpn/workspaces",
  );
  const out: NoteListItem[] = [];
  for (const w of workspaces ?? []) {
    const { projects } = await wpnHttp<{ projects: { id: string }[] }>(
      headlessBaseUrl,
      "GET",
      `/wpn/workspaces/${encodeURIComponent(w.id)}/projects`,
    );
    for (const p of projects ?? []) {
      const { notes } = await wpnHttp<{ notes: WpnNoteListItem[] }>(
        headlessBaseUrl,
        "GET",
        `/wpn/projects/${encodeURIComponent(p.id)}/notes`,
      );
      for (const n of notes ?? []) {
        out.push({
          id: n.id,
          type: n.type,
          title: n.title,
          parentId: n.parent_id,
          depth: n.depth,
        });
      }
    }
  }
  return out;
}

async function wpnFetchNoteDetail(
  headlessBaseUrl: string,
  noteId: string,
): Promise<WpnNoteDetail | null> {
  try {
    const r = await wpnHttp<{ note: WpnNoteDetail }>(
      headlessBaseUrl,
      "GET",
      `/wpn/notes/${encodeURIComponent(noteId)}`,
    );
    return r?.note ?? null;
  } catch {
    return null;
  }
}

function wpnDetailToNote(d: WpnNoteDetail): Note {
  return {
    id: d.id,
    type: d.type,
    title: d.title,
    content: d.content,
    metadata: d.metadata,
    canWrite: d.canWrite,
  };
}

async function wpnResolveProjectIdForNote(
  headlessBaseUrl: string,
  noteId: string,
): Promise<string | null> {
  const d = await wpnFetchNoteDetail(headlessBaseUrl, noteId);
  return d?.project_id ?? null;
}

async function syncWpnFetch<T>(
  syncBase: string,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const url = `${syncBase.replace(/\/$/, "")}${path}`;
  const hasBody =
    body !== undefined &&
    method !== "GET" &&
    method !== "HEAD" &&
    method !== "DELETE";
  const headers: Record<string, string> = {};
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }
  let res: Response;
  try {
    res = await authedFetch({
      method,
      url,
      headersWithoutAuth: headers,
      body: hasBody ? JSON.stringify(body) : null,
      credentials: "omit",
    });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      // Unsigned read fallback: for GET-style calls with no usable refresh, still
      // serve a stub so the UI doesn't degrade to a raw error during a dev-only
      // stale-session scenario. Mutations must fail loudly.
      if (!isMutatingWpnHttpMethod(method)) {
        const stub = syncWpnUnsignedReadStub<T>(apiPath);
        if (stub !== undefined) {
          wpnTrace("wpnHttp.stub", {
            path: apiPath,
            method,
            reason: `session expired (${err.reason})`,
          });
          return stub;
        }
      }
      void terminateSession(
        err.reason === "refresh_failed_network"
          ? "refresh_failed_network"
          : "session_expired",
      );
      throw new Error(`${method} ${apiPath} failed (401)`);
    }
    throw err;
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = `${method} ${apiPath} failed (${res.status})`;
    try {
      const errObj = JSON.parse(text) as { error?: string };
      if (typeof errObj.error === "string" && errObj.error.length > 0) {
        msg = errObj.error;
      }
    } catch {
      if (text.trim().length > 0) {
        msg = text;
      }
    }
    throw new Error(msg);
  }
  if (res.status === 204 || text.length === 0) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

function hasCloudSyncSessionForWpn(): boolean {
  return !!readCloudSyncToken() || !!readCloudSyncRefreshToken();
}

function isMutatingWpnHttpMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PATCH" || m === "PUT" || m === "DELETE";
}

/**
 * When sync-api WPN is configured but the browser has no cloud tokens yet, avoid hitting
 * `/wpn/*` (401 + noisy unhandled rejections) and return the same empty shapes the API would
 * produce for reads. Mutations still throw so the user gets a clear sign-in message.
 */
function syncWpnUnsignedReadStub<T>(apiPath: string): T | undefined {
  const normalized = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  if (normalized === "/wpn/workspaces") {
    return { workspaces: [] } as T;
  }
  if (normalized === "/wpn/workspaces-and-projects") {
    return { workspaces: [], projects: [] } as T;
  }
  if (normalized === "/wpn/full-tree") {
    return {
      workspaces: [],
      projects: [],
      notesByProjectId: {},
      explorerStateByProjectId: {},
    } as T;
  }
  if (/^\/wpn\/workspaces\/[^/]+\/projects$/.test(normalized)) {
    return { projects: [] } as T;
  }
  if (/^\/wpn\/workspaces\/[^/]+\/settings$/.test(normalized)) {
    return { settings: {} } as T;
  }
  if (/^\/wpn\/projects\/[^/]+\/notes$/.test(normalized)) {
    return { notes: [] } as T;
  }
  if (/^\/wpn\/projects\/[^/]+\/settings$/.test(normalized)) {
    return { settings: {} } as T;
  }
  if (/^\/wpn\/projects\/[^/]+\/explorer-state$/.test(normalized)) {
    return { expanded_ids: [] } as T;
  }
  if (normalized === "/wpn/all-notes-list") {
    return { notes: [] } as T;
  }
  if (normalized === "/wpn/notes-with-context") {
    return { notes: [] } as T;
  }
  if (/^\/wpn\/backlinks\//.test(normalized)) {
    return { sources: [] } as T;
  }
  return undefined;
}

async function wpnHttp<T>(
  headlessBaseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (syncWpnUsesSyncApi()) {
    const syncBase = resolveSyncApiBase().trim().replace(/\/$/, "");
    if (syncBase.length > 0) {
      assertSignedInCloudWpnOnlineForMutation(method);
      if (!hasCloudSyncSessionForWpn()) {
        if (!isMutatingWpnHttpMethod(method)) {
          const stub = syncWpnUnsignedReadStub<T>(path);
          if (stub !== undefined) {
            wpnTrace("wpnHttp.stub", { path, method, reason: "no cloud session" });
            return stub;
          }
        }
        throw new Error(
          "Sign in with cloud sync to use the cloud-backed workspace in the browser.",
        );
      }
      wpnTrace("wpnHttp.fetch", { path, method, via: "sync-api" });
      return syncWpnFetch<T>(syncBase, method, path, body);
    }
  }
  wpnTrace("wpnHttp.fetch", { path, method, via: "headless" });
  return webRequest<T>(headlessBaseUrl, method, path, body);
}

/** Dispatched after headless marketplace session-install so UI refreshes note types. */
export const ARCHON_WEB_PLUGINS_CHANGED = "archon-web-plugins-changed";

/** Persisted headless API origin for `?web=1` (no `api=` query needed). */
export const ARCHON_WEB_HEADLESS_API_STORAGE_KEY = "archon-headless-api-base";

/** Persisted `?syncWpn=1` so new tabs with a bare URL still enable sync-api WPN + cloud auth paths. */
export const ARCHON_WEB_SYNC_WPN_STORAGE_KEY = "archon.web.syncWpn";

/** Clears persisted sync-WPN preference (e.g. cloud logout). Safe when env still forces sync API. */
export function clearPersistedWebSyncWpnPreference(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    localStorage.removeItem(ARCHON_WEB_SYNC_WPN_STORAGE_KEY);
  } catch {
    /* private mode */
  }
  const w = window as Window & { __ARCHON_WPN_USE_SYNC_API__?: boolean };
  if (w.__ARCHON_WPN_USE_SYNC_API__ === true) {
    delete w.__ARCHON_WPN_USE_SYNC_API__;
  }
}

export type HeadlessApiPreset = { label: string; value: string };

export function normalizeHeadlessApiBase(url: string): string {
  const t = url.trim();
  if (t === "") {
    return "";
  }
  return t.replace(/\/$/, "");
}

/** Presets for the web UI dropdown (call from client components so dev proxy uses current host). */
export function getHeadlessApiPresetOptions(): HeadlessApiPreset[] {
  const opts: HeadlessApiPreset[] = [];
  if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
    const origin = normalizeHeadlessApiBase(window.location.origin);
    opts.push({
      label: `${window.location.host} (dev proxy)`,
      value: origin,
    });
  }
  return opts;
}

/**
 * Resolve `window.__ARCHON_WEB_API_BASE__` before `installArchonWebShimIfNeeded` (Next / plain browser only).
 * Order: `api` query → localStorage → if `?web=1`: dev same-origin (proxy), else unset.
 * Without `web=1` and no saved `api`, leaves unset so the Market tab can prompt via dropdown.
 */
export function initHeadlessWebApiBaseFromUrlAndStorage(): void {
  if (typeof window === "undefined") {
    return;
  }
  if (archonWebBackendSyncOnly()) {
    window.__ARCHON_WEB_API_BASE__ = "";
    return;
  }
  const q = new URLSearchParams(window.location.search);
  const web = q.get("web") === "1" || q.get("web") === "true";

  try {
    if (localStorage.getItem(ARCHON_WEB_SYNC_WPN_STORAGE_KEY) === "1") {
      window.__ARCHON_WPN_USE_SYNC_API__ = true;
    }
  } catch {
    /* private mode */
  }
  const syncWpnQ = q.get("syncWpn");
  if (syncWpnQ === "1" || syncWpnQ === "true") {
    window.__ARCHON_WPN_USE_SYNC_API__ = true;
    try {
      localStorage.setItem(ARCHON_WEB_SYNC_WPN_STORAGE_KEY, "1");
    } catch {
      /* private mode */
    }
  } else if (syncWpnQ === "0" || syncWpnQ === "false") {
    try {
      localStorage.removeItem(ARCHON_WEB_SYNC_WPN_STORAGE_KEY);
    } catch {
      /* private mode */
    }
    const w = window as Window & { __ARCHON_WPN_USE_SYNC_API__?: boolean };
    delete w.__ARCHON_WPN_USE_SYNC_API__;
  }

  const api = q.get("api")?.trim();
  if (api) {
    window.__ARCHON_WEB_API_BASE__ = normalizeHeadlessApiBase(api);
    return;
  }
  try {
    const s = localStorage.getItem(ARCHON_WEB_HEADLESS_API_STORAGE_KEY)?.trim();
    if (s) {
      window.__ARCHON_WEB_API_BASE__ = normalizeHeadlessApiBase(s);
      return;
    }
  } catch {
    /* private mode */
  }
  if (
    process.env.NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN === "1" ||
    process.env.NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN === "true"
  ) {
    window.__ARCHON_WEB_API_BASE__ = "";
    return;
  }
  if (!web) {
    return;
  }
  if (process.env.NODE_ENV === "development") {
    window.__ARCHON_WEB_API_BASE__ = normalizeHeadlessApiBase(
      window.location.origin,
    );
  }
}

/** True when the UI runs in Electron (hide browser-only headless controls). */
export function isElectronUserAgent(): boolean {
  return (
    typeof navigator !== "undefined" && navigator.userAgent.includes("Electron")
  );
}

function pickOneFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve(null);
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      resolve(input.files && input.files.length > 0 ? input.files[0]! : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

async function webRequest<T>(
  baseUrl: string,
  method: string,
  apiPath: string,
  body?: unknown,
  attempt?: number,
): Promise<T> {
  if (archonWebBackendSyncOnly()) {
    throw new Error(
      "[Archon] Headless API calls are disabled (NEXT_PUBLIC_ARCHON_WEB_BACKEND=sync-only). Run sync routes: `npm run sync-api` (Fastify on :4010) or serve `/api/v1` from Next with Postgres + JWT (see docs/deploy-archon-sync.md).",
    );
  }
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const url =
    baseUrl.trim() === ""
      ? `/api/v1${path}`
      : `${baseUrl.replace(/\/$/, "")}/api/v1${path}`;
  const hasBody = body !== undefined && method !== "GET" && method !== "HEAD";
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: (() => {
      const token = getAccessToken();
      const h: Record<string, string> = {};
      if (hasBody) {
        h["Content-Type"] = "application/json";
      }
      if (token) {
        h.Authorization = `Bearer ${token}`;
      }
      return h;
    })(),
  };
  if (hasBody) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (res.status === 401 && (attempt ?? 0) < 1) {
    try {
      await authRefresh();
      return await webRequest<T>(baseUrl, method, apiPath, body, (attempt ?? 0) + 1);
    } catch {
      setAccessToken(null);
    }
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = `${method} ${apiPath} failed (${res.status})`;
    try {
      const j = JSON.parse(text) as { error?: string };
      if (typeof j.error === "string" && j.error.length > 0) {
        msg = j.error;
      }
    } catch {
      if (text.trim().length > 0) {
        msg = text;
      }
    }
    const isHtml = /<\s*html[\s>]/i.test(text) || /<\s*!doctype/i.test(text);
    if (isHtml && /cannot\s+post/i.test(msg)) {
      msg = `${msg.trim()}\n\nThe server has no route for this request. Use sync WPN: \`npm run sync-api\` + Postgres, or Next colocated \`/api/v1\` with \`NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN=1\` and Postgres in \`.env\`, and \`NEXT_PUBLIC_ARCHON_WEB_BACKEND=sync-only\` (see \`npm run dev:web\`, docs/deploy-archon-sync.md).`;
    }
    throw new Error(msg);
  }
  if (res.status === 204 || text.length === 0) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

/**
 * Minimal `window.Archon` for browser dev: HTTP to `/api/v1` (same-origin or `__ARCHON_WEB_API_BASE__`) or sync-api WPN when configured.
 * Set `window.__ARCHON_WEB_API_BASE__` via `initHeadlessWebApiBaseFromUrlAndStorage()` when not using `NEXT_PUBLIC_ARCHON_WEB_BACKEND=sync-only`.
 */
/** In-flight `GET /wpn/notes/:id` requests keyed by `${baseUrl}|${noteId}`. Lets concurrent subscribers share one fetch. */
const wpnGetNoteInFlight = new Map<string, Promise<{ note: WpnNoteDetail }>>();

export function createWebArchonApi(baseUrl: string): ArchonRendererApi {
  const req = <T>(method: string, path: string, body?: unknown) =>
    webRequest<T>(baseUrl, method, path, body);
  const wpnReq = <T>(method: string, path: string, body?: unknown) =>
    wpnHttp<T>(baseUrl, method, path, body);

  const impl: Partial<ArchonRendererApi> = {
    getNote: async (noteId?: string) => {
      if (syncWpnNotesBackend()) {
        if (!noteId) {
          return null;
        }
        const d = await wpnFetchNoteDetail(baseUrl, noteId);
        return d ? wpnDetailToNote(d) : null;
      }
      return req(
        "GET",
        noteId
          ? `/notes/detail?id=${encodeURIComponent(noteId)}`
          : "/notes/detail",
      );
    },
    getAllNotes: async () => {
      if (syncWpnNotesBackend()) {
        return wpnAggregateAllNoteListItems(baseUrl);
      }
      return req("GET", "/notes");
    },
    createNote: async (_payload) => {
      if (syncWpnNotesBackend()) {
        throw new Error(
          "Legacy flat createNote is not used with sync WPN — create notes from the Notes explorer (per-project tree).",
        );
      }
      return req("POST", "/notes", _payload);
    },
    renameNote: async (id, title, options) => {
      if (syncWpnNotesBackend()) {
        await wpnHttp(baseUrl, "PATCH", `/wpn/notes/${encodeURIComponent(id)}`, {
          title,
          ...(options?.updateVfsDependentLinks === false
            ? { updateVfsDependentLinks: false }
            : {}),
        });
        return;
      }
      return req("PATCH", `/notes/${encodeURIComponent(id)}`, {
        title,
        ...(options?.updateVfsDependentLinks === false
          ? { updateVfsDependentLinks: false }
          : {}),
      });
    },
    deleteNotes: async (ids) => {
      if (syncWpnNotesBackend()) {
        await wpnHttp(baseUrl, "POST", "/wpn/notes/delete", { ids });
        return;
      }
      return req("POST", "/notes/delete", { ids });
    },
    moveNote: async (draggedId, targetId, placement) => {
      if (syncWpnNotesBackend()) {
        const pd = await wpnResolveProjectIdForNote(baseUrl, draggedId);
        const pt = await wpnResolveProjectIdForNote(baseUrl, targetId);
        if (!pd || !pt || pd !== pt) {
          throw new Error(
            "moveNote: dragged and target notes must exist in the same WPN project",
          );
        }
        await wpnHttp(baseUrl, "POST", "/wpn/notes/move", {
          projectId: pd,
          draggedId,
          targetId,
          placement,
        });
        return;
      }
      return req("POST", "/notes/move", { draggedId, targetId, placement });
    },
    moveNotesBulk: async (ids, targetId, placement) => {
      if (syncWpnNotesBackend()) {
        for (const id of ids) {
          await impl.moveNote!(id, targetId, placement);
        }
        return;
      }
      return req("POST", "/notes/move-bulk", { ids, targetId, placement });
    },
    pasteSubtree: async (payload) => {
      if (syncWpnNotesBackend()) {
        const { sourceId, targetId, mode, placement } = payload;
        const projectId = await wpnResolveProjectIdForNote(baseUrl, sourceId);
        const pt = await wpnResolveProjectIdForNote(baseUrl, targetId);
        if (!projectId || !pt || projectId !== pt) {
          throw new Error(
            "pasteSubtree: source and target notes must be in the same WPN project",
          );
        }
        if (mode === "cut") {
          await wpnHttp(baseUrl, "POST", "/wpn/notes/move", {
            projectId,
            draggedId: sourceId,
            targetId,
            placement,
          });
          return {};
        }
        const dup = await wpnHttp<{ newRootId: string }>(
          baseUrl,
          "POST",
          `/wpn/projects/${encodeURIComponent(projectId)}/notes/${encodeURIComponent(sourceId)}/duplicate`,
          {},
        );
        const newRootId = dup?.newRootId;
        if (!newRootId) {
          throw new Error("pasteSubtree: duplicate failed");
        }
        await wpnHttp(baseUrl, "POST", "/wpn/notes/move", {
          projectId,
          draggedId: newRootId,
          targetId,
          placement,
        });
        return { newRootId };
      }
      return req("POST", "/notes/paste", payload);
    },
    saveNotePluginUiState: async (noteId, state) => {
      if (syncWpnNotesBackend()) {
        const err = validatePluginUiStateSize(state);
        if (err) {
          throw new Error(err);
        }
        const cur = await wpnFetchNoteDetail(baseUrl, noteId);
        if (!cur) {
          throw new Error("Note not found");
        }
        const meta = {
          ...(cur.metadata && typeof cur.metadata === "object" ? cur.metadata : {}),
          [PLUGIN_UI_METADATA_KEY]: state,
        };
        await wpnHttp(baseUrl, "PATCH", `/wpn/notes/${encodeURIComponent(noteId)}`, {
          metadata: meta,
        });
        return;
      }
      return req("PATCH", `/notes/${encodeURIComponent(noteId)}`, {
        pluginUiState: state,
      });
    },
    saveNoteContent: async (noteId, content) => {
      if (syncWpnNotesBackend()) {
        await wpnHttp(baseUrl, "PATCH", `/wpn/notes/${encodeURIComponent(noteId)}`, {
          content,
        });
        return;
      }
      return req("PATCH", `/notes/${encodeURIComponent(noteId)}`, { content });
    },
    patchNoteMetadata: async (noteId, patch) => {
      const cur = await wpnFetchNoteDetail(baseUrl, noteId);
      if (!cur) {
        throw new Error("patchNoteMetadata: WPN note not found");
      }
      const meta = {
        ...(cur.metadata && typeof cur.metadata === "object" ? cur.metadata : {}),
        ...patch,
      };
      await wpnHttp(baseUrl, "PATCH", `/wpn/notes/${encodeURIComponent(noteId)}`, {
        metadata: meta,
      });
    },
    getPluginHTML: async (type, note) => {
      if (syncWpnNotesBackend()) {
        const syncBase = resolveSyncApiBase().trim().replace(/\/$/, "");
        const r = await syncWpnFetch<{ html: string }>(syncBase, "POST", "/plugins/builtin-render", {
          type,
          note,
        });
        return r.html;
      }
      const r = await req<{ html: string }>("POST", "/plugins/render-html", {
        type,
        note,
      });
      return r.html;
    },
    getRegisteredTypes: async () => {
      if (syncWpnNotesBackend()) {
        return [...WPN_BUILTIN_NOTE_TYPES];
      }
      const r = await req<{ types: string[] }>("GET", "/notes/types/registered");
      return r.types;
    },
    getSelectableNoteTypes: async () => {
      // Hide `code` and `text` from the new-note picker. They remain valid
      // registered types (existing notes still render), but users no longer
      // see them as creatable options. `markdown` and `mdx` cover the
      // text/code authoring use cases more richly.
      const HIDDEN_FROM_PICKER = new Set(["code", "text"]);
      if (syncWpnNotesBackend()) {
        return WPN_BUILTIN_NOTE_TYPES.filter((t) => !HIDDEN_FROM_PICKER.has(t));
      }
      const r = await req<{ types: string[] }>(
        "GET",
        "/notes/types/selectable",
      );
      return r.types.filter((t) => !HIDDEN_FROM_PICKER.has(t));
    },
    getProjectState: async () => {
      const emptyRoots = {
        rootPath: null as string | null,
        notesDbPath: null as string | null,
        workspaceRoots: [] as string[],
        workspaceLabels: {} as Record<string, string>,
      };
      if (syncWpnUsesSyncApi()) {
        const syncBase = resolveSyncApiBase().trim().replace(/\/$/, "");
        if (syncBase.length > 0) {
          /**
           * Always report a virtual root when sync WPN is configured so the Notes explorer mounts
           * and can list/create workspaces (including auto-created Scratch). Previously we waited
           * until `/wpn/workspaces` was non-empty, which blocked the first scratch provision.
           */
          return {
            rootPath: null,
            notesDbPath: null,
            workspaceRoots: ["archon-sync-wpn"],
            workspaceLabels: {},
          };
        }
        return emptyRoots;
      }
      return req("GET", "/project/state");
    },
    getShellLayout: async () => {
      if (syncWpnUsesSyncApi()) {
        const syncBase = resolveSyncApiBase().trim().replace(/\/$/, "");
        if (syncBase.length > 0) {
          const hasCloudSession =
            !!readCloudSyncToken() || !!readCloudSyncRefreshToken();
          if (!hasCloudSession) {
            return null;
          }
          try {
            const r = await syncWpnFetch<{ layout: unknown }>(
              syncBase,
              "GET",
              "/me/shell-layout",
            );
            return r?.layout ?? null;
          } catch {
            return null;
          }
        }
      }
      const r = await req<{ layout: unknown }>("GET", "/project/shell-layout");
      return r?.layout ?? null;
    },
    setShellLayout: async (layout) => {
      if (syncWpnUsesSyncApi()) {
        const syncBase = resolveSyncApiBase().trim().replace(/\/$/, "");
        if (syncBase.length > 0) {
          const hasCloudSession =
            !!readCloudSyncToken() || !!readCloudSyncRefreshToken();
          if (!hasCloudSession) {
            return { ok: true as const };
          }
          try {
            await syncWpnFetch(syncBase, "PUT", "/me/shell-layout", { layout });
            return { ok: true as const };
          } catch {
            /* Unreachable sync API (e.g. dev:web without archon-sync-api on 4010) — keep layout in memory only. */
            return { ok: true as const };
          }
        }
      }
      try {
        await req("POST", "/project/shell-layout", { layout });
        return { ok: true as const };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false as const, error: msg };
      }
    },
    getAppPrefs: async () => ({ seedSampleNotes: true }),
    archonUndo: async () => {
      if (syncWpnNotesBackend()) {
        return {
          ok: false as const,
          error: "Undo is not available in the browser sync client. Use the desktop app for full undo.",
          touchedNotes: false as const,
        };
      }
      return req("POST", "/undo");
    },
    archonRedo: async () => {
      if (syncWpnNotesBackend()) {
        return {
          ok: false as const,
          error: "Redo is not available in the browser sync client. Use the desktop app for full redo.",
          touchedNotes: false as const,
        };
      }
      return req("POST", "/redo");
    },
    wpnListWorkspaces: () => wpnReq("GET", "/wpn/workspaces"),
    wpnListWorkspacesAndProjects: () => wpnReq("GET", "/wpn/workspaces-and-projects"),
    wpnGetFullTree: () => wpnReq("GET", "/wpn/full-tree"),
    wpnCreateWorkspace: (name) =>
      wpnReq("POST", "/wpn/workspaces", { name: name ?? "Workspace" }),
    wpnUpdateWorkspace: (id, patch) =>
      wpnReq("PATCH", `/wpn/workspaces/${encodeURIComponent(id)}`, patch),
    wpnDeleteWorkspace: (id) =>
      wpnReq("DELETE", `/wpn/workspaces/${encodeURIComponent(id)}`),
    wpnDeleteWorkspaces: (ids) =>
      wpnReq("POST", "/wpn/workspaces/delete", { ids }),
    wpnListProjects: (workspaceId) =>
      wpnReq(
        "GET",
        `/wpn/workspaces/${encodeURIComponent(workspaceId)}/projects`,
      ),
    wpnCreateProject: (workspaceId, name) =>
      wpnReq(
        "POST",
        `/wpn/workspaces/${encodeURIComponent(workspaceId)}/projects`,
        { name: name ?? "Project" },
      ),
    wpnUpdateProject: (id, patch) =>
      wpnReq("PATCH", `/wpn/projects/${encodeURIComponent(id)}`, patch),
    wpnDeleteProject: (id) =>
      wpnReq("DELETE", `/wpn/projects/${encodeURIComponent(id)}`),
    wpnDeleteProjects: (ids) =>
      wpnReq("POST", "/wpn/projects/delete", { ids }),
    wpnListNotes: (projectId) =>
      wpnReq("GET", `/wpn/projects/${encodeURIComponent(projectId)}/notes`),
    wpnListAllNotesWithContext: () => wpnReq("GET", "/wpn/notes-with-context"),
    wpnListBacklinksToNote: (targetNoteId) =>
      wpnReq("GET", `/wpn/backlinks/${encodeURIComponent(targetNoteId)}`),
    wpnGetNote: (noteId) => {
      const key = `${baseUrl}|${noteId}`;
      const existing = wpnGetNoteInFlight.get(key);
      if (existing) {
        return existing as Promise<{ note: WpnNoteDetail }>;
      }
      const p = wpnReq<{ note: WpnNoteDetail }>(
        "GET",
        `/wpn/notes/${encodeURIComponent(noteId)}`,
      ).finally(() => {
        wpnGetNoteInFlight.delete(key);
      });
      wpnGetNoteInFlight.set(key, p);
      return p;
    },
    wpnGetExplorerState: (projectId) =>
      wpnReq("GET", `/wpn/projects/${encodeURIComponent(projectId)}/explorer-state`),
    wpnSetExplorerState: (projectId, expandedIds) =>
      wpnReq("PATCH", `/wpn/projects/${encodeURIComponent(projectId)}/explorer-state`, {
        expanded_ids: expandedIds,
      }),
    wpnCreateNoteInProject: (projectId, payload) =>
      wpnReq("POST", `/wpn/projects/${encodeURIComponent(projectId)}/notes`, payload),
    wpnPreviewNoteTitleVfsImpact: async (noteId, newTitle) => {
      try {
        const j = await wpnReq<{
          dependentNoteCount?: number;
          dependentNoteIds?: string[];
        }>(
          "POST",
          `/wpn/notes/${encodeURIComponent(noteId)}/preview-title-change`,
          { title: newTitle },
        );
        const n = typeof j?.dependentNoteCount === "number" ? j.dependentNoteCount : 0;
        const ids = Array.isArray(j?.dependentNoteIds)
          ? j!.dependentNoteIds!.filter((x): x is string => typeof x === "string")
          : [];
        return { dependentNoteCount: n, dependentNoteIds: ids };
      } catch {
        return { dependentNoteCount: 0, dependentNoteIds: [] as string[] };
      }
    },
    wpnPatchNote: (noteId, patch) =>
      wpnReq("PATCH", `/wpn/notes/${encodeURIComponent(noteId)}`, patch),
    wpnDeleteNotes: (ids) => wpnReq("POST", "/wpn/notes/delete", { ids }),
    wpnMoveNote: (payload) => wpnReq("POST", "/wpn/notes/move", payload),
    wpnMoveNoteCrossProject: (payload) =>
      wpnReq("POST", "/wpn/notes/move-to-project", {
        noteId: payload.noteId,
        targetProjectId: payload.targetProjectId,
        targetParentId: payload.targetParentId ?? null,
      }),
    wpnDuplicateNoteSubtree: (projectId, noteId) =>
      wpnReq(
        "POST",
        `/wpn/projects/${encodeURIComponent(projectId)}/notes/${encodeURIComponent(noteId)}/duplicate`,
        {},
      ),
    wpnDuplicateProject: (projectId, opts) =>
      wpnReq(
        "POST",
        `/wpn/projects/${encodeURIComponent(projectId)}/duplicate`,
        {
          ...(opts?.targetWorkspaceId !== undefined
            ? { targetWorkspaceId: opts.targetWorkspaceId }
            : {}),
          ...(opts?.newName !== undefined ? { newName: opts.newName } : {}),
        },
      ),
    wpnDuplicateWorkspace: (workspaceId, opts) =>
      wpnReq(
        "POST",
        `/wpn/workspaces/${encodeURIComponent(workspaceId)}/duplicate`,
        {
          ...(opts?.newName !== undefined ? { newName: opts.newName } : {}),
          ...(opts?.targetSpaceId !== undefined
            ? { targetSpaceId: opts.targetSpaceId }
            : {}),
        },
      ),
    wpnExportWorkspaces: async (workspaceIds) => {
      const syncBase = resolveSyncApiBase().trim().replace(/\/$/, "");
      const token = readCloudSyncToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${syncBase}/wpn/export`, {
        method: "POST",
        headers,
        credentials: "omit",
        body: JSON.stringify({ workspaceIds: workspaceIds ?? [] }),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "Export failed");
        throw new Error(err);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "archon-export.zip";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    },
    wpnImportWorkspaces: async (file, options) => {
      let zipFile = file;
      if (!zipFile) {
        zipFile = await new Promise<File>((resolve, reject) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".zip";
          input.onchange = () => {
            const f = input.files?.[0];
            if (f) resolve(f); else reject(new Error("No file selected"));
          };
          input.click();
        });
      }
      const syncBase = resolveSyncApiBase().trim().replace(/\/$/, "");
      const token = readCloudSyncToken();
      const fd = new FormData();
      fd.append("file", zipFile);
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const query = options?.conflict
        ? `?conflict=${encodeURIComponent(options.conflict)}`
        : "";
      const res = await fetch(`${syncBase}/wpn/import${query}`, {
        method: "POST",
        headers,
        credentials: "omit",
        body: fd,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "Import failed");
        throw new Error(err);
      }
      const json = (await res.json()) as { imported: { workspaces: number; projects: number; notes: number } };
      return json.imported;
    },
    pullWorkspaceRxdbMirrorPayload: async () => ({
      ok: false as const,
      error: "Workspace mirror is only available in Electron with a file vault.",
    }),
    flushWorkspaceRxdbMirrorToDisk: async () => ({
      ok: false as const,
      error: "Workspace mirror flush is only available in Electron with a file vault.",
    }),
    listMarketplacePlugins: () => {
      if (syncWpnNotesBackend()) {
        return Promise.resolve({
          filesBasePath: "",
          generatedAt: new Date().toISOString(),
          plugins: [] as MarketplaceListResponse["plugins"],
          indexError:
            "Marketplace is not available on sync web. Use the desktop app to browse and install plugins.",
        });
      }
      return req<MarketplaceListResponse>("GET", "/marketplace/plugins");
    },
    installMarketplacePlugin: async (packageFile) => {
      if (syncWpnNotesBackend()) {
        return {
          success: false,
          error: "Marketplace install requires the Archon desktop app.",
        };
      }
      const out = await req<{
        success: boolean;
        error?: string;
        warnings?: string[];
      }>("POST", "/marketplace/session-install", { packageFile });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(ARCHON_WEB_PLUGINS_CHANGED));
      }
      return (
        out ?? {
          success: false,
          error: "Empty response from marketplace/session-install",
        }
      );
    },
    getPluginRendererUiMeta: async (noteType) => {
      if (syncWpnNotesBackend()) {
        const syncBase = resolveSyncApiBase().trim().replace(/\/$/, "");
        try {
          const j = await syncWpnFetch<{
            theme?: string;
            deferDisplayUntilContentReady?: boolean;
            designSystemVersion?: string | null;
          } | null>(
            syncBase,
            "GET",
            `/plugins/builtin-renderer-meta?type=${encodeURIComponent(noteType)}`,
          );
          if (!j || typeof j !== "object") {
            return null;
          }
          return {
            theme: j.theme === "isolated" ? "isolated" : "inherit",
            deferDisplayUntilContentReady: j.deferDisplayUntilContentReady === true,
            designSystemVersion: j.designSystemVersion ?? undefined,
          };
        } catch {
          return null;
        }
      }
      const root = baseUrl.trim() === "" ? "" : baseUrl.replace(/\/$/, "");
      const u =
        root === ""
          ? `/api/v1/plugins/renderer-meta?type=${encodeURIComponent(noteType)}`
          : `${root}/api/v1/plugins/renderer-meta?type=${encodeURIComponent(noteType)}`;
      const res = await fetch(u);
      if (!res.ok) {
        return null;
      }
      const text = await res.text();
      if (!text.length) {
        return null;
      }
      const j = JSON.parse(text) as {
        theme?: string;
        deferDisplayUntilContentReady?: boolean;
        designSystemVersion?: string | null;
      } | null;
      if (!j || typeof j !== "object") {
        return null;
      }
      return {
        theme: j.theme === "isolated" ? "isolated" : "inherit",
        deferDisplayUntilContentReady: j.deferDisplayUntilContentReady === true,
        designSystemVersion: j.designSystemVersion ?? undefined,
      };
    },
    getUserPluginsDirectory: async () => ({
      path: "",
      error: "User plugin folder is only available in the Archon desktop app.",
    }),
    selectZipFile: async () => null,
    validatePluginZip: async () => ({
      valid: false,
      errors: ["Not available in web mode — use the desktop app to validate zips."],
      warnings: [],
    }),
    importPlugin: async () => ({
      success: false,
      error: "Plugin import requires the Archon desktop app.",
    }),
    deletePluginBinAndCaches: async () => ({
      success: false,
      error: "Not available in web mode.",
    }),
    deleteAllPluginSources: async () => ({
      success: false,
      error: "Not available in web mode.",
    }),
    formatArchonPluginData: async () => ({
      success: false,
      error: "Not available in web mode.",
    }),
    getInstalledPlugins: async () => {
      if (syncWpnNotesBackend()) {
        return [];
      }
      try {
        const r = await req<{ ids: string[] }>("GET", "/plugins/session-installed");
        return Array.isArray(r?.ids) ? r.ids : [];
      } catch {
        return [];
      }
    },
    getPluginInventory: async () => [],
    getDisabledPluginIds: async () => [],
    setPluginEnabled: async () => ({
      success: false,
      error: "Not available in web mode.",
    }),
    uninstallPlugin: async () => ({
      success: false,
      error: "Not available in web mode.",
    }),
    onPluginsChanged: (callback) => {
      if (typeof window === "undefined") {
        return noopUnsub;
      }
      const fn = () => callback();
      window.addEventListener(ARCHON_WEB_PLUGINS_CHANGED, fn);
      return () => window.removeEventListener(ARCHON_WEB_PLUGINS_CHANGED, fn);
    },
    onProjectRootChanged: () => noopUnsub,
    onPluginProgress: () => noopUnsub,
    onIdeWorkspaceFsChanged: () => noopUnsub,
    onMainDebugLog: () => noopUnsub,
    onNativeThemeChanged: (callback) => {
      if (typeof window === "undefined") {
        return noopUnsub;
      }
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const fn = () => callback(mq.matches);
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    onRunContributionCommand: () => noopUnsub,
    sendClientLog: () => {},
    openExternalUrl: async (url: string) => {
      const t = typeof url === "string" ? url.trim() : "";
      if (!t) {
        return { ok: false as const, error: "Invalid url" };
      }
      let parsed: URL;
      try {
        parsed = new URL(t);
      } catch {
        return { ok: false as const, error: "Invalid URL" };
      }
      const proto = parsed.protocol.toLowerCase();
      if (proto !== "http:" && proto !== "https:" && proto !== "mailto:") {
        return { ok: false as const, error: "Unsupported protocol" };
      }
      window.open(t, "_blank", "noopener,noreferrer");
      return { ok: true as const };
    },
    startScratchSession: async () => ({
      ok: false as const,
      error: "Scratch workspace is only available in the Archon desktop app.",
    }),
    saveScratchSessionToFolder: async () => ({
      ok: false as const,
      error: "Scratch workspace is only available in the Archon desktop app.",
    }),
    newScratchSession: async () => ({
      ok: false as const,
      error: "Scratch workspace is only available in the Archon desktop app.",
    }),
    pullLegacyScratchWpnMigrationPayload: async () => ({
      ok: false as const,
      reason: "none" as const,
    }),
    ackLegacyScratchWpnMigrationImported: async () => ({
      ok: false as const,
      error: "Legacy scratch migration is Electron-only.",
    }),
    assetUrl: (relativePath) => {
      if (syncWpnNotesBackend()) {
        const syncBase = resolveSyncApiBase().trim().replace(/\/$/, "");
        if (syncBase.length > 0) {
          const rel = String(relativePath || "").replace(/^\/+/, "");
          return `${syncBase}/me/assets/file?path=${encodeURIComponent(rel)}`;
        }
      }
      return "archon-asset:web-unsupported";
    },
    getNativeThemeDark: async () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
    applyElectronPrimaryWpnBackend: async () => ({
      ok: false as const,
      error: "Electron only",
    }),
    openCloudWpnWindowCloseSender: async () => ({
      ok: false as const,
      error: "Electron only",
    }),
    openFileWpnWindowCloseSender: async () => ({
      ok: false as const,
      error: "Electron only",
    }),
    setElectronWpnBackendForSession: async () => ({
      ok: false as const,
      error: "Electron only",
    }),
    clearElectronWorkspaceRoots: async () => ({
      ok: false as const,
      error: "Electron only",
    }),
  };

  if (useWebTryoutWpnIndexedDb()) {
    Object.assign(impl, webScratchPlainStubOverrides());
  }

  return new Proxy(impl as ArchonRendererApi, {
    get(target, prop, receiver) {
      if (prop === "then") {
        return undefined;
      }
      if (prop in target && target[prop as keyof ArchonRendererApi] !== undefined) {
        return Reflect.get(target, prop, receiver);
      }
      const key = String(prop);
      if (key.startsWith("on") && key.length > 3) {
        return () => noopUnsub;
      }
      return (..._args: unknown[]) =>
        Promise.reject(
          new Error(
            `[Archon Web] Not implemented over HTTP: ${key}. Run the Electron app for full API.`,
          ),
        );
    },
  });
}

/** Switch headless API origin at runtime (Next web shell); persists to localStorage. */
export function applyHeadlessApiBase(raw: string): void {
  if (typeof window === "undefined") {
    return;
  }
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "same-origin") {
    try {
      localStorage.removeItem(ARCHON_WEB_HEADLESS_API_STORAGE_KEY);
    } catch {
      /* private mode */
    }
    window.__ARCHON_WEB_API_BASE__ = "";
    window.Archon = createWebArchonApi("");
    window.dispatchEvent(new Event(ARCHON_WEB_PLUGINS_CHANGED));
    return;
  }
  const base = normalizeHeadlessApiBase(trimmed);
  if (!/^https?:\/\/.+/i.test(base)) {
    return;
  }
  window.__ARCHON_WEB_API_BASE__ = base;
  try {
    localStorage.setItem(ARCHON_WEB_HEADLESS_API_STORAGE_KEY, base);
  } catch {
    /* private mode */
  }
  window.Archon = createWebArchonApi(base);
  window.dispatchEvent(new Event(ARCHON_WEB_PLUGINS_CHANGED));
}

/**
 * Offline-safe `window.Archon` for plain browser (e.g. `next dev` without Electron and without `?web=1&api=`).
 * Enough for the shell to mount; host actions show as cancelled / empty until you use Electron or the HTTP API.
 */
export function createPlainBrowserDevStub(): ArchonRendererApi {
  const impl: Partial<ArchonRendererApi> = {
    getNote: async () => null,
    getAllNotes: async () => [],
    getProjectState: async () => ({
      rootPath: null,
      notesDbPath: null,
      workspaceRoots: [],
      workspaceLabels: {},
      scratchSession: false,
    }),
    getShellLayout: async () => null,
    setShellLayout: async () => ({ ok: false as const, error: "No host" }),
    getSelectableNoteTypes: async () => [],
    getRegisteredTypes: async () => [],
    getAppPrefs: async () => ({ seedSampleNotes: true }),
    setSeedSampleNotes: async () => ({
      ok: false as const,
      error: "Not available in plain browser — use Electron or ?web=1&api=…",
    }),
    getNativeThemeDark: async () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
    onNativeThemeChanged: (callback) => {
      if (typeof window === "undefined") {
        return noopUnsub;
      }
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const fn = () => callback(mq.matches);
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    getMainDebugLogBuffer: async () => [],
    onMainDebugLog: () => noopUnsub,
    clearMainDebugLogBuffer: async () => ({ success: true }),
    onPluginsChanged: () => noopUnsub,
    onProjectRootChanged: () => noopUnsub,
    onPluginProgress: () => noopUnsub,
    onIdeWorkspaceFsChanged: () => noopUnsub,
    onRunContributionCommand: () => noopUnsub,
    sendClientLog: () => {},
    assetUrl: (relativePath) => {
      if (typeof window === "undefined") {
        return "archon-asset:browser-dev-unavailable";
      }
      const rel = String(relativePath || "").replace(/^\/+/, "");
      const parts = rel.split("/").map((p) => encodeURIComponent(p));
      return `${window.location.origin}/api/v1/assets/file/${parts.join("/")}`;
    },
    archonUndo: async () => ({
      ok: false as const,
      error: "No host",
      touchedNotes: false as const,
    }),
    archonRedo: async () => ({
      ok: false as const,
      error: "No host",
      touchedNotes: false as const,
    }),
    addWorkspaceFolder: async () => ({ ok: false as const, cancelled: true }),
    selectProjectFolder: async () => ({ ok: false as const, cancelled: true }),
    startScratchSession: async () => ({
      ok: false as const,
      error: "Desktop app only",
    }),
    saveScratchSessionToFolder: async () => ({
      ok: false as const,
      error: "Desktop app only",
    }),
    newScratchSession: async () => ({
      ok: false as const,
      error: "Desktop app only",
    }),
    pullLegacyScratchWpnMigrationPayload: async () => ({
      ok: false as const,
      reason: "none" as const,
    }),
    ackLegacyScratchWpnMigrationImported: async () => ({
      ok: false as const,
      error: "Legacy scratch migration is Electron-only.",
    }),
    openProjectPath: async () => ({
      ok: false as const,
      error: "Not available in plain browser",
    }),
    refreshWorkspace: async () => ({
      ok: false as const,
      error: "Not available in plain browser",
    }),
    removeWorkspaceRoot: async () => ({
      ok: false as const,
      error: "Not available in plain browser",
    }),
    swapWorkspaceBlock: async () => ({
      ok: false as const,
      error: "Not available in plain browser",
    }),
    setWorkspaceFolderLabel: async () => ({
      ok: false as const,
      error: "Not available in plain browser",
    }),
    revealProjectFolderInExplorer: async () => ({
      ok: false as const,
      error: "Not available in plain browser",
    }),
    toggleDeveloperTools: async () => ({ success: false }),
    quitApp: async () => ({ success: false }),
    reloadWindow: async () => ({ success: false }),
    applyElectronPrimaryWpnBackend: async () => ({
      ok: false as const,
      error: "Not available in plain browser",
    }),
    openCloudWpnWindowCloseSender: async () => ({
      ok: false as const,
      error: "Not available in plain browser",
    }),
    openFileWpnWindowCloseSender: async () => ({
      ok: false as const,
      error: "Not available in plain browser",
    }),
    setElectronWpnBackendForSession: async () => ({
      ok: false as const,
      error: "Not available in plain browser",
    }),
    clearElectronWorkspaceRoots: async () => ({
      ok: false as const,
      error: "Not available in plain browser",
    }),
    openExternalUrl: async (url: string) => {
      const t = typeof url === "string" ? url.trim() : "";
      if (!t) {
        return { ok: false as const, error: "Invalid url" };
      }
      let parsed: URL;
      try {
        parsed = new URL(t);
      } catch {
        return { ok: false as const, error: "Invalid URL" };
      }
      const proto = parsed.protocol.toLowerCase();
      if (proto !== "http:" && proto !== "https:" && proto !== "mailto:") {
        return { ok: false as const, error: "Unsupported protocol" };
      }
      window.open(t, "_blank", "noopener,noreferrer");
      return { ok: true as const };
    },
    listAssets: async () => ({
      ok: true as const,
      entries: [],
    }),
    listAssetsByCategory: async () => ({
      ok: true as const,
      files: [],
    }),
    getAssetInfo: async () => null,
    readAssetText: async () => ({
      ok: false as const,
      error: "Not available in plain browser",
    }),
    openAssetExternal: async () => ({
      ok: false as const,
      error: "Not available in plain browser",
    }),
    moveProjectAsset: async () => ({
      ok: false as const,
      error: "Not available in plain browser",
    }),
    revealAssetInFileManager: async () => ({
      ok: false as const,
      error: "Not available in plain browser",
    }),
    pickImportMediaFile: async (category) => {
      if (typeof window === "undefined") {
        return { ok: false as const, error: "No window" };
      }
      const file = await pickOneFile("*/*");
      if (!file) {
        return { ok: false as const, error: "Cancelled" };
      }
      const b = window.__ARCHON_WEB_API_BASE__?.trim();
      const url =
        b === undefined || b === ""
          ? "/api/v1/assets/import-media"
          : `${normalizeHeadlessApiBase(b)}/api/v1/assets/import-media`;
      const form = new FormData();
      form.append("category", String(category));
      form.append("file", file, file.name);
      const res = await fetch(url, { method: "POST", body: form });
      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false as const,
          error: text || `Import failed (${res.status})`,
        };
      }
      const j = JSON.parse(text) as { ok: boolean; assetRel?: string; error?: string };
      if (!j.ok || !j.assetRel) {
        return { ok: false as const, error: j.error || "Import failed" };
      }
      return { ok: true as const, assetRel: j.assetRel };
    },
    getInstalledPlugins: async () => {
      if (typeof window === "undefined") return [];
      try {
        const b = window.__ARCHON_WEB_API_BASE__?.trim();
        const url =
          b === undefined || b === ""
            ? "/api/v1/plugins/session-installed"
            : `${normalizeHeadlessApiBase(b)}/api/v1/plugins/session-installed`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const j = (await res.json()) as { ids?: string[] };
        return Array.isArray(j.ids) ? j.ids : [];
      } catch {
        return [];
      }
    },
    getPluginInventory: async () => [],
    getDisabledPluginIds: async () => [],
    getPluginLoadIssues: async () => [],
    getPluginCacheStats: async () => ({
      root: "",
      totalBytes: 0,
      plugins: [],
    }),
    getUserPluginsDirectory: async () => ({
      path: "",
      error: "Not available in plain browser",
    }),
    validatePluginZip: async () => ({
      valid: false,
      errors: ["Not available in plain browser"],
      warnings: [],
    }),
    importPlugin: async () => ({
      success: false,
      error: "Not available in plain browser",
    }),
    listMarketplacePlugins: async () => ({
      filesBasePath: "",
      generatedAt: "",
      plugins: [],
      indexError:
        "Start the sync API (`npm run sync-api` or Next `/api/v1` with Postgres + JWT), sign in, or set NEXT_PUBLIC_ARCHON_SYNC_API_URL.",
    }),
    installMarketplacePlugin: async () => ({
      success: false,
      error: "Not available in plain browser",
    }),
    setPluginEnabled: async () => ({
      success: false,
      error: "Not available in plain browser",
    }),
    reloadPluginRegistry: async () => ({
      success: false,
      error: "Not available in plain browser",
    }),
    uninstallPlugin: async () => ({
      success: false,
      error: "Not available in plain browser",
    }),
    selectZipFile: async () => null,
    getPluginHTML: async () => null,
    getPluginRendererUiMeta: async () => null,
    getPluginManifestUi: async () => null,
    createNote: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    renameNote: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    deleteNotes: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    moveNote: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    moveNotesBulk: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    pasteSubtree: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    saveNotePluginUiState: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    saveNoteContent: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnListWorkspaces: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnListWorkspacesAndProjects: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnGetFullTree: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnCreateWorkspace: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnUpdateWorkspace: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnDeleteWorkspace: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnDeleteWorkspaces: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnListProjects: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnCreateProject: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnUpdateProject: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnDeleteProject: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnDeleteProjects: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnListNotes: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnListAllNotesWithContext: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnListBacklinksToNote: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnGetNote: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnGetExplorerState: async () => ({ expanded_ids: [] as string[] }),
    wpnSetExplorerState: async () => ({ expanded_ids: [] as string[] }),
    wpnCreateNoteInProject: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnPreviewNoteTitleVfsImpact: async () => ({
      dependentNoteCount: 0,
      dependentNoteIds: [] as string[],
    }),
    wpnPatchNote: async () => {
      throw new Error(
        "Not available in plain browser — use Electron or ?web=1&api=…",
      );
    },
    wpnDeleteNotes: async () => ({ ok: true as const }),
    wpnMoveNote: async () => ({ ok: true as const }),
    wpnMoveNoteCrossProject: async () => ({ ok: true as const }),
    wpnDuplicateNoteSubtree: async () => ({
      newRootId: "00000000-0000-4000-8000-000000000000",
    }),
    wpnDuplicateProject: async () => {
      throw new Error("Not available in plain browser — use Electron or ?web=1&api=…");
    },
    wpnDuplicateWorkspace: async () => {
      throw new Error("Not available in plain browser — use Electron or ?web=1&api=…");
    },
    wpnExportWorkspaces: async () => {
      throw new Error("Not available in plain browser — use Electron or ?web=1&api=…");
    },
    wpnImportWorkspaces: async () => {
      throw new Error("Not available in plain browser — use Electron or ?web=1&api=…");
    },
    pullWorkspaceRxdbMirrorPayload: async () => ({
      ok: false as const,
      error: "Not available in plain browser — use Electron or ?web=1&api=…",
    }),
    flushWorkspaceRxdbMirrorToDisk: async () => ({
      ok: false as const,
      error: "Not available in plain browser — use Electron or ?web=1&api=…",
    }),
  };

  if (isWebScratchSession()) {
    Object.assign(impl, webScratchPlainStubOverrides());
  }

  return new Proxy(impl as ArchonRendererApi, {
    get(target, prop, receiver) {
      if (prop === "then") {
        return undefined;
      }
      if (
        prop in target &&
        target[prop as keyof ArchonRendererApi] !== undefined
      ) {
        return Reflect.get(target, prop, receiver);
      }
      const key = String(prop);
      if (key.startsWith("on") && key.length > 3) {
        return () => noopUnsub;
      }
      return (..._args: unknown[]) =>
        Promise.reject(
          new Error(
            `[Archon] ${key} is only available in Electron or with a configured web backend (?web=1 and sync-api or same-origin /api/v1).`,
          ),
        );
    },
  });
}

/**
 * Reads `GET /api/v1/session` using the same origin / base as the web API shim (for UI labels).
 */
export async function fetchHeadlessWpnSession(): Promise<{ wpnOwnerId: string } | null> {
  if (typeof window === "undefined") {
    return null;
  }
  if (syncWpnUsesSyncApi()) {
    const syncBase = resolveSyncApiBase().trim().replace(/\/$/, "");
    if (syncBase.length > 0) {
      try {
        const token = readCloudSyncToken();
        if (!token) {
          return null;
        }
        const res = await fetch(`${syncBase}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          return null;
        }
        const j = (await res.json()) as { userId: string };
        return { wpnOwnerId: j.userId };
      } catch {
        return null;
      }
    }
  }
  const raw = window.__ARCHON_WEB_API_BASE__;
  const base = typeof raw === "string" ? raw.trim() : "";
  const url =
    base === ""
      ? "/api/v1/session"
      : `${normalizeHeadlessApiBase(base)}/api/v1/session`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as { wpnOwnerId: string };
  } catch {
    return null;
  }
}

export function installArchonWebShimIfNeeded(): void {
  if (typeof window === "undefined") {
    return;
  }
  const w = window as Window & { Archon?: ArchonRendererApi };
  if (w.Archon) {
    return;
  }
  if (typeof window.__ARCHON_WEB_API_BASE__ === "string") {
    window.Archon = createWebArchonApi(normalizeHeadlessApiBase(window.__ARCHON_WEB_API_BASE__));
    return;
  }
  if (syncWpnUsesSyncApi() && resolveSyncApiBase().trim().length > 0) {
    window.Archon = createWebArchonApi("");
    return;
  }
  const sameOrigin =
    process.env.NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN === "1" ||
    process.env.NEXT_PUBLIC_ARCHON_API_SAME_ORIGIN === "true";
  window.Archon = sameOrigin ? createWebArchonApi("") : createPlainBrowserDevStub();
}
