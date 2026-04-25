import type { McpTokenHolder } from "./mcp-token-holder.js";

/** Default TTL for `GET /wpn/notes-with-context` in-process cache (ms). */
const DEFAULT_NOTES_WITH_CONTEXT_TTL_MS = 2500;

export type WpnHttpClientOptions = {
  /** How long to reuse the notes-with-context catalog; invalidated on note PATCH/POST. */
  notesWithContextTtlMs?: number;
  /** Called after refresh (or login) updates tokens so MCP can persist. */
  onTokensUpdated?: (access: string, refresh: string | null) => void;
};

export type WpnNoteWithContextRow = {
  id: string;
  title: string;
  type: string;
  project_id: string;
  project_name: string;
  workspace_id: string;
  workspace_name: string;
};

export type WpnNoteDetail = {
  id: string;
  project_id: string;
  parent_id: string | null;
  type: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  sibling_index: number;
  created_at_ms: number;
  updated_at_ms: number;
};

/** One row from `GET /wpn/projects/:projectId/notes` (preorder flat list). */
export type WpnNoteListItem = {
  id: string;
  project_id: string;
  parent_id: string | null;
  type: string;
  title: string;
  depth: number;
  sibling_index: number;
};

function isWpnNoteListItem(x: unknown): x is WpnNoteListItem {
  if (x === null || typeof x !== "object") {
    return false;
  }
  const o = x as Record<string, unknown>;
  const pid = o.parent_id;
  return (
    typeof o.id === "string" &&
    typeof o.project_id === "string" &&
    (pid === null || typeof pid === "string") &&
    typeof o.type === "string" &&
    typeof o.title === "string" &&
    typeof o.depth === "number" &&
    Number.isFinite(o.depth) &&
    typeof o.sibling_index === "number" &&
    Number.isFinite(o.sibling_index)
  );
}

export function parseWpnNoteListItems(raw: unknown[], errLabel: string): WpnNoteListItem[] {
  const out: WpnNoteListItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isWpnNoteListItem(item)) {
      throw new Error(`${errLabel}: invalid note list item at index ${i}`);
    }
    out.push(item);
  }
  return out;
}

export class WpnHttpClient {
  private readonly notesWithContextTtlMs: number;
  private readonly onTokensUpdated?: WpnHttpClientOptions["onTokensUpdated"];
  private notesWithContextCache: { fetchedAtMs: number; rows: WpnNoteWithContextRow[] } | null =
    null;

  constructor(
    private readonly baseUrl: string,
    private readonly holder: McpTokenHolder,
    opts: WpnHttpClientOptions = {},
  ) {
    this.notesWithContextTtlMs =
      opts.notesWithContextTtlMs ?? DEFAULT_NOTES_WITH_CONTEXT_TTL_MS;
    this.onTokensUpdated = opts.onTokensUpdated;
  }

  getHolder(): McpTokenHolder {
    return this.holder;
  }

  /** Clear notes-with-context cache (e.g. after logout). */
  invalidateNotesWithContextCache(): void {
    this.notesWithContextCache = null;
  }

  private invalidateNotesWithContextCacheInternal(): void {
    this.notesWithContextCache = null;
  }

  private url(path: string): string {
    const p = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseUrl}${p}`;
  }

  private authHeaders(): HeadersInit {
    const h: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (this.holder.accessToken) {
      h.Authorization = `Bearer ${this.holder.accessToken}`;
    }
    if (this.holder.activeOrgId) {
      h["X-Archon-Org"] = this.holder.activeOrgId;
    }
    if (this.holder.activeSpaceId) {
      h["X-Archon-Space"] = this.holder.activeSpaceId;
    }
    return h;
  }

  private async tryRefresh(): Promise<boolean> {
    const rt = this.holder.refreshToken;
    if (!rt) {
      return false;
    }
    const res = await fetch(this.url("/auth/refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: rt }),
    });
    if (!res.ok) {
      return false;
    }
    let body: { token?: string; refreshToken?: string };
    try {
      body = (await res.json()) as { token?: string; refreshToken?: string };
    } catch {
      return false;
    }
    if (typeof body.token !== "string" || !body.token.trim()) {
      return false;
    }
    const newRt =
      typeof body.refreshToken === "string" && body.refreshToken.trim()
        ? body.refreshToken.trim()
        : rt;
    this.holder.setTokens(body.token.trim(), newRt);
    this.onTokensUpdated?.(this.holder.accessToken, this.holder.refreshToken);
    return true;
  }

  private async fetchWpn(
    path: string,
    method: string,
    errLabel: string,
    body?: unknown,
  ): Promise<{ res: Response; text: string; body: unknown }> {
    const doFetch = () =>
      fetch(this.url(path), {
        method,
        headers: this.authHeaders(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    let res = await doFetch();
    let text = await res.text();
    if (res.status === 401 && this.holder.refreshToken) {
      const ok = await this.tryRefresh();
      if (ok) {
        res = await doFetch();
        text = await res.text();
      }
    }
    if (res.status === 401) {
      let apiDetail = "";
      try {
        const errBody = JSON.parse(text) as { error?: string };
        if (typeof errBody.error === "string" && errBody.error.trim()) {
          apiDetail = `: ${errBody.error.trim()}`;
        }
      } catch {
        // non-JSON 401 body; ignore
      }
      throw new Error(`ARCHON_UNAUTHORIZED${apiDetail}`);
    }
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${errLabel}: invalid JSON (${res.status})`);
    }
    return { res, text, body: parsed };
  }

  private async getJson<T>(path: string, errLabel: string): Promise<T> {
    const { res, text, body } = await this.fetchWpn(path, "GET", errLabel);
    if (!res.ok) {
      const err = (body as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`${errLabel} failed (${res.status}): ${err}`);
    }
    return body as T;
  }

  async getWorkspaces(): Promise<unknown[]> {
    const body = await this.getJson<{ workspaces?: unknown }>(
      "/wpn/workspaces",
      "WPN GET workspaces",
    );
    const ws = body.workspaces;
    if (!Array.isArray(ws)) {
      throw new Error("WPN GET workspaces: missing workspaces array");
    }
    return ws;
  }

  /** Phase 1 — list orgs the authenticated user belongs to (and active selection). */
  async listMyOrgs(): Promise<{
    orgs: Array<{
      orgId: string;
      name: string;
      slug: string;
      role: "admin" | "member";
      isDefault: boolean;
    }>;
    activeOrgId: string | null;
    defaultOrgId: string | null;
  }> {
    return this.getJson(
      "/orgs/me",
      "GET /orgs/me",
    );
  }

  /** Phase 2 — list spaces the user belongs to across all orgs. */
  async listMySpaces(): Promise<{
    spaces: Array<{
      spaceId: string;
      orgId: string | null;
      name: string;
      kind: "default" | "normal";
      role: "owner" | "member";
    }>;
    activeSpaceId: string | null;
  }> {
    return this.getJson("/spaces/me", "GET /spaces/me");
  }

  /**
   * Switch active org for this session: POST /orgs/active returns a fresh access token
   * whose claims carry the new `activeOrgId` and (when resolvable) `activeSpaceId`.
   * Applies the new token and org/space context to the holder, invalidates the
   * notes-with-context cache, and fires `onTokensUpdated` so callers can persist.
   */
  async switchActiveOrg(orgId: string): Promise<{
    activeOrgId: string;
    activeSpaceId: string | null;
  }> {
    const { res, text, body } = await this.fetchWpn(
      "/orgs/active",
      "POST",
      "POST /orgs/active",
      { orgId },
    );
    if (!res.ok) {
      const err = (body as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`POST /orgs/active failed (${res.status}): ${err}`);
    }
    const b = body as {
      token?: string;
      activeOrgId?: string;
      activeSpaceId?: string | null;
    };
    if (typeof b.token !== "string" || !b.token.trim()) {
      throw new Error("POST /orgs/active: missing token in response");
    }
    if (typeof b.activeOrgId !== "string" || !b.activeOrgId.trim()) {
      throw new Error("POST /orgs/active: missing activeOrgId in response");
    }
    const prevRefresh = this.holder.refreshToken;
    this.holder.setTokens(b.token.trim(), prevRefresh);
    this.holder.setActiveOrg(b.activeOrgId.trim());
    const spaceId =
      typeof b.activeSpaceId === "string" && b.activeSpaceId.trim()
        ? b.activeSpaceId.trim()
        : null;
    this.holder.setActiveSpace(spaceId);
    this.onTokensUpdated?.(this.holder.accessToken, this.holder.refreshToken);
    this.invalidateNotesWithContextCacheInternal();
    return { activeOrgId: b.activeOrgId.trim(), activeSpaceId: spaceId };
  }

  async getProjects(workspaceId: string): Promise<unknown[]> {
    const body = await this.getJson<{ projects?: unknown }>(
      `/wpn/workspaces/${encodeURIComponent(workspaceId)}/projects`,
      "WPN GET projects",
    );
    const p = body.projects;
    if (!Array.isArray(p)) {
      throw new Error("WPN GET projects: missing projects array");
    }
    return p;
  }

  async getNotesFlat(projectId: string): Promise<WpnNoteListItem[]> {
    const body = await this.getJson<{ notes?: unknown }>(
      `/wpn/projects/${encodeURIComponent(projectId)}/notes`,
      "WPN GET notes",
    );
    const n = body.notes;
    if (!Array.isArray(n)) {
      throw new Error("WPN GET notes: missing notes array");
    }
    return parseWpnNoteListItems(n, "WPN GET notes");
  }

  async getNotesWithContext(): Promise<WpnNoteWithContextRow[]> {
    const now = Date.now();
    const c = this.notesWithContextCache;
    if (
      c !== null &&
      this.notesWithContextTtlMs > 0 &&
      now - c.fetchedAtMs < this.notesWithContextTtlMs
    ) {
      return c.rows;
    }
    const body = await this.getJson<{ notes?: unknown }>(
      "/wpn/notes-with-context",
      "WPN GET notes-with-context",
    );
    const notes = body.notes;
    if (!Array.isArray(notes)) {
      throw new Error("WPN GET notes-with-context: missing notes array");
    }
    const rows = notes as WpnNoteWithContextRow[];
    this.notesWithContextCache = { fetchedAtMs: now, rows };
    return rows;
  }

  /**
   * Resolve a noteId to its scope chain via `GET /wpn/notes/:id/scope`. Returns
   * `null` when the note doesn't exist or is unreadable (404). Read-only — does
   * not mutate session state. Pair with {@link ensureScopeForNote} for the
   * "switch then retry" flow used by every noteId-taking MCP tool.
   */
  async getNoteScope(noteId: string): Promise<{
    noteId: string;
    projectId: string;
    workspaceId: string;
    spaceId: string | null;
    orgId: string | null;
  } | null> {
    const { res, text, body } = await this.fetchWpn(
      `/wpn/notes/${encodeURIComponent(noteId)}/scope`,
      "GET",
      "WPN get note scope",
    );
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      const err = (body as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN GET note scope failed (${res.status}): ${err}`);
    }
    const b = body as {
      noteId?: unknown;
      projectId?: unknown;
      workspaceId?: unknown;
      spaceId?: unknown;
      orgId?: unknown;
    };
    if (
      typeof b.noteId !== "string" ||
      typeof b.projectId !== "string" ||
      typeof b.workspaceId !== "string"
    ) {
      throw new Error("WPN GET note scope: missing fields in response");
    }
    return {
      noteId: b.noteId,
      projectId: b.projectId,
      workspaceId: b.workspaceId,
      spaceId: typeof b.spaceId === "string" && b.spaceId.length > 0 ? b.spaceId : null,
      orgId: typeof b.orgId === "string" && b.orgId.length > 0 ? b.orgId : null,
    };
  }

  /**
   * Ensure the active org/space matches the home of `noteId`, switching when
   * needed so a downstream `notes-with-context`-style call (e.g. the
   * `archon_execute_note` find pass) can see the note. Returns a record of
   * what changed — `switched: false` when already in scope, otherwise the
   * before/after orgId and spaceId so the calling tool can surface it.
   *
   * Org change requires re-minting the JWT (`switchActiveOrg`); same-org space
   * change just updates the header in the holder. When the note is unreadable
   * (404), returns `{ switched: false, found: false }` and lets the caller
   * decide whether to fall through (most tools will still attempt the original
   * call so the existing 404 / "not found" surfaces normally).
   */
  async ensureScopeForNote(noteId: string): Promise<{
    switched: boolean;
    found: boolean;
    fromOrgId: string | null;
    toOrgId: string | null;
    fromSpaceId: string | null;
    toSpaceId: string | null;
  }> {
    const fromOrgId = this.holder.activeOrgId;
    const fromSpaceId = this.holder.activeSpaceId;
    let scope: Awaited<ReturnType<WpnHttpClient["getNoteScope"]>>;
    try {
      scope = await this.getNoteScope(noteId);
    } catch {
      // Network / server error — don't block the original tool call; let it
      // surface the underlying error itself.
      return {
        switched: false,
        found: false,
        fromOrgId,
        toOrgId: fromOrgId,
        fromSpaceId,
        toSpaceId: fromSpaceId,
      };
    }
    if (!scope) {
      return {
        switched: false,
        found: false,
        fromOrgId,
        toOrgId: fromOrgId,
        fromSpaceId,
        toSpaceId: fromSpaceId,
      };
    }
    const targetOrgId = scope.orgId;
    const targetSpaceId = scope.spaceId;
    const orgMatches = targetOrgId === null || targetOrgId === fromOrgId;
    const spaceMatches = targetSpaceId === null || targetSpaceId === fromSpaceId;
    if (orgMatches && spaceMatches) {
      return {
        switched: false,
        found: true,
        fromOrgId,
        toOrgId: fromOrgId,
        fromSpaceId,
        toSpaceId: fromSpaceId,
      };
    }
    if (!orgMatches && targetOrgId) {
      await this.switchActiveOrg(targetOrgId);
    }
    if (targetSpaceId && this.holder.activeSpaceId !== targetSpaceId) {
      this.holder.setActiveSpace(targetSpaceId);
      this.invalidateNotesWithContextCacheInternal();
    }
    return {
      switched: true,
      found: true,
      fromOrgId,
      toOrgId: this.holder.activeOrgId,
      fromSpaceId,
      toSpaceId: this.holder.activeSpaceId,
    };
  }

  async getNote(noteId: string): Promise<WpnNoteDetail> {
    const { res, text, body } = await this.fetchWpn(
      `/wpn/notes/${encodeURIComponent(noteId)}`,
      "GET",
      "WPN get note",
    );
    if (!res.ok) {
      const err = (body as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN GET note failed (${res.status}): ${err}`);
    }
    const note = (body as { note?: WpnNoteDetail }).note;
    if (!note || typeof note !== "object") {
      throw new Error("WPN GET note: missing note object");
    }
    return note;
  }

  async patchNote(
    noteId: string,
    patch: {
      title?: string;
      content?: string;
      type?: string;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<WpnNoteDetail> {
    const { res, text, body } = await this.fetchWpn(
      `/wpn/notes/${encodeURIComponent(noteId)}`,
      "PATCH",
      "WPN patch note",
      patch,
    );
    if (!res.ok) {
      if (res.status === 409) {
        const msg = (body as { error?: string })?.error;
        if (typeof msg === "string" && msg.trim()) {
          throw new Error(msg.trim());
        }
      }
      const err = (body as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN PATCH note failed (${res.status}): ${err}`);
    }
    const note = (body as { note?: WpnNoteDetail }).note;
    if (!note) {
      throw new Error("WPN PATCH note: missing note in response");
    }
    this.invalidateNotesWithContextCacheInternal();
    return note;
  }

  async updateWorkspace(
    workspaceId: string,
    patch: { name?: string; sort_index?: number; color_token?: string | null },
  ): Promise<unknown> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/wpn/workspaces/${encodeURIComponent(workspaceId)}`,
      "PATCH",
      "WPN update workspace",
      patch,
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN PATCH workspace failed (${res.status}): ${err}`);
    }
    return (parsed as { workspace?: unknown }).workspace ?? parsed;
  }

  async moveWorkspaceToSpace(
    workspaceId: string,
    targetSpaceId: string,
  ): Promise<unknown> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/wpn/workspaces/${encodeURIComponent(workspaceId)}/space`,
      "PATCH",
      "WPN move workspace to space",
      { targetSpaceId },
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(
        `WPN PATCH workspace/space failed (${res.status}): ${err}`,
      );
    }
    this.invalidateNotesWithContextCacheInternal();
    return (parsed as { workspace?: unknown }).workspace ?? parsed;
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/wpn/workspaces/${encodeURIComponent(workspaceId)}`,
      "DELETE",
      "WPN delete workspace",
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN DELETE workspace failed (${res.status}): ${err}`);
    }
  }

  async createProject(workspaceId: string, name: string): Promise<{ id: string; name: string }> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/wpn/workspaces/${encodeURIComponent(workspaceId)}/projects`,
      "POST",
      "WPN create project",
      { name },
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN POST project failed (${res.status}): ${err}`);
    }
    const project = (parsed as { project?: { id: string; name: string } }).project;
    if (!project || typeof project.id !== "string") {
      throw new Error("WPN POST project: missing project in response");
    }
    this.invalidateNotesWithContextCacheInternal();
    return project;
  }

  async updateProject(
    projectId: string,
    patch: { name?: string; sort_index?: number; color_token?: string | null; workspace_id?: string },
  ): Promise<unknown> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/wpn/projects/${encodeURIComponent(projectId)}`,
      "PATCH",
      "WPN update project",
      patch,
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN PATCH project failed (${res.status}): ${err}`);
    }
    this.invalidateNotesWithContextCacheInternal();
    return (parsed as { project?: unknown }).project ?? parsed;
  }

  async deleteProject(projectId: string): Promise<void> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/wpn/projects/${encodeURIComponent(projectId)}`,
      "DELETE",
      "WPN delete project",
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN DELETE project failed (${res.status}): ${err}`);
    }
    this.invalidateNotesWithContextCacheInternal();
  }

  async deleteNotes(ids: string[]): Promise<void> {
    const { res, text, body: parsed } = await this.fetchWpn(
      "/wpn/notes/delete",
      "POST",
      "WPN delete notes",
      { ids },
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN delete notes failed (${res.status}): ${err}`);
    }
    this.invalidateNotesWithContextCacheInternal();
  }

  async moveNote(
    projectId: string,
    draggedId: string,
    targetId: string,
    placement: "before" | "after" | "into",
  ): Promise<void> {
    const { res, text, body: parsed } = await this.fetchWpn(
      "/wpn/notes/move",
      "POST",
      "WPN move note",
      { projectId, draggedId, targetId, placement },
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN move note failed (${res.status}): ${err}`);
    }
    this.invalidateNotesWithContextCacheInternal();
  }

  async duplicateSubtree(
    projectId: string,
    noteId: string,
  ): Promise<unknown> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/wpn/projects/${encodeURIComponent(projectId)}/notes/${encodeURIComponent(noteId)}/duplicate`,
      "POST",
      "WPN duplicate subtree",
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN duplicate subtree failed (${res.status}): ${err}`);
    }
    this.invalidateNotesWithContextCacheInternal();
    return parsed;
  }

  async moveNoteToProject(
    noteId: string,
    targetProjectId: string,
    targetParentId?: string | null,
  ): Promise<void> {
    const payload: {
      noteId: string;
      targetProjectId: string;
      targetParentId?: string | null;
    } = { noteId, targetProjectId };
    if (targetParentId !== undefined) {
      payload.targetParentId = targetParentId;
    }
    const { res, text, body: parsed } = await this.fetchWpn(
      "/wpn/notes/move-to-project",
      "POST",
      "WPN move note to project",
      payload,
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN move-to-project failed (${res.status}): ${err}`);
    }
    this.invalidateNotesWithContextCacheInternal();
  }

  async duplicateProject(
    projectId: string,
    opts: { targetWorkspaceId?: string; newName?: string } = {},
  ): Promise<{ projectId: string; name: string }> {
    const body: Record<string, string> = {};
    if (opts.targetWorkspaceId !== undefined) {
      body.targetWorkspaceId = opts.targetWorkspaceId;
    }
    if (opts.newName !== undefined) {
      body.newName = opts.newName;
    }
    const { res, text, body: parsed } = await this.fetchWpn(
      `/wpn/projects/${encodeURIComponent(projectId)}/duplicate`,
      "POST",
      "WPN duplicate project",
      body,
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN duplicate project failed (${res.status}): ${err}`);
    }
    const p = parsed as { projectId?: unknown; name?: unknown };
    if (typeof p.projectId !== "string" || typeof p.name !== "string") {
      throw new Error("WPN duplicate project: missing projectId/name in response");
    }
    this.invalidateNotesWithContextCacheInternal();
    return { projectId: p.projectId, name: p.name };
  }

  async duplicateWorkspace(
    workspaceId: string,
    opts: { newName?: string; targetSpaceId?: string } = {},
  ): Promise<{
    workspaceId: string;
    name: string;
    projects: { projectId: string; name: string; sourceProjectId: string }[];
  }> {
    const body: Record<string, string> = {};
    if (opts.newName !== undefined) {
      body.newName = opts.newName;
    }
    if (opts.targetSpaceId !== undefined) {
      body.targetSpaceId = opts.targetSpaceId;
    }
    const { res, text, body: parsed } = await this.fetchWpn(
      `/wpn/workspaces/${encodeURIComponent(workspaceId)}/duplicate`,
      "POST",
      "WPN duplicate workspace",
      body,
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN duplicate workspace failed (${res.status}): ${err}`);
    }
    const p = parsed as {
      workspaceId?: unknown;
      name?: unknown;
      projects?: unknown;
    };
    if (typeof p.workspaceId !== "string" || typeof p.name !== "string") {
      throw new Error(
        "WPN duplicate workspace: missing workspaceId/name in response",
      );
    }
    const projects = Array.isArray(p.projects)
      ? (p.projects as {
          projectId: string;
          name: string;
          sourceProjectId: string;
        }[])
      : [];
    this.invalidateNotesWithContextCacheInternal();
    return { workspaceId: p.workspaceId, name: p.name, projects };
  }

  async getBacklinks(noteId: string): Promise<{ id: string; title: string; project_id: string }[]> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/wpn/backlinks/${encodeURIComponent(noteId)}`,
      "GET",
      "WPN get backlinks",
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN GET backlinks failed (${res.status}): ${err}`);
    }
    const sources = (parsed as { sources?: unknown[] }).sources;
    return Array.isArray(sources)
      ? (sources as { id: string; title: string; project_id: string }[])
      : [];
  }

  async exportWorkspaces(workspaceIds?: string[]): Promise<ArrayBuffer> {
    const doFetch = () =>
      fetch(this.url("/wpn/export"), {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(workspaceIds ? { workspaceIds } : {}),
      });
    let res = await doFetch();
    if (res.status === 401 && this.holder.refreshToken) {
      const ok = await this.tryRefresh();
      if (ok) res = await doFetch();
    }
    if (!res.ok) {
      throw new Error(`WPN export failed (${res.status})`);
    }
    return res.arrayBuffer();
  }

  async importWorkspaces(zipBuffer: ArrayBuffer): Promise<unknown> {
    const boundary = `----archon${Date.now()}`;
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="import.zip"\r\nContent-Type: application/zip\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const headerBuf = new TextEncoder().encode(header);
    const footerBuf = new TextEncoder().encode(footer);
    const bodyBuf = new Uint8Array(headerBuf.length + zipBuffer.byteLength + footerBuf.length);
    bodyBuf.set(headerBuf, 0);
    bodyBuf.set(new Uint8Array(zipBuffer), headerBuf.length);
    bodyBuf.set(footerBuf, headerBuf.length + zipBuffer.byteLength);

    const h: Record<string, string> = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      Accept: "application/json",
    };
    if (this.holder.accessToken) {
      h.Authorization = `Bearer ${this.holder.accessToken}`;
    }
    if (this.holder.activeOrgId) {
      h["X-Archon-Org"] = this.holder.activeOrgId;
    }
    if (this.holder.activeSpaceId) {
      h["X-Archon-Space"] = this.holder.activeSpaceId;
    }
    const doFetch = () =>
      fetch(this.url("/wpn/import"), {
        method: "POST",
        headers: h,
        body: bodyBuf,
      });
    let res = await doFetch();
    if (res.status === 401 && this.holder.refreshToken) {
      const ok = await this.tryRefresh();
      if (ok) {
        h.Authorization = `Bearer ${this.holder.accessToken}`;
        if (this.holder.activeOrgId) {
          h["X-Archon-Org"] = this.holder.activeOrgId;
        }
        if (this.holder.activeSpaceId) {
          h["X-Archon-Space"] = this.holder.activeSpaceId;
        }
        res = await doFetch();
      }
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`WPN import failed (${res.status}): ${text.slice(0, 200)}`);
    }
    this.invalidateNotesWithContextCacheInternal();
    return res.json();
  }

  async createWorkspace(name: string): Promise<{ id: string; name: string }> {
    const { res, text, body: parsed } = await this.fetchWpn(
      "/wpn/workspaces",
      "POST",
      "WPN create workspace",
      { name },
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN POST workspace failed (${res.status}): ${err}`);
    }
    const workspace = (parsed as { workspace?: { id: string; name: string } }).workspace;
    if (!workspace || typeof workspace.id !== "string") {
      throw new Error("WPN POST workspace: missing workspace in response");
    }
    this.invalidateNotesWithContextCacheInternal();
    return workspace;
  }

  async createSpace(
    orgId: string,
    name: string,
  ): Promise<{
    spaceId: string;
    orgId: string;
    name: string;
    kind: string;
    role: string;
  }> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/orgs/${encodeURIComponent(orgId)}/spaces`,
      "POST",
      "WPN create space",
      { name },
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN POST space failed (${res.status}): ${err}`);
    }
    const space = parsed as {
      spaceId?: string;
      orgId?: string;
      name?: string;
      kind?: string;
      role?: string;
    };
    if (!space || typeof space.spaceId !== "string") {
      throw new Error("WPN POST space: missing spaceId in response");
    }
    return {
      spaceId: space.spaceId,
      orgId: typeof space.orgId === "string" ? space.orgId : orgId,
      name: typeof space.name === "string" ? space.name : name,
      kind: typeof space.kind === "string" ? space.kind : "normal",
      role: typeof space.role === "string" ? space.role : "owner",
    };
  }

  /**
   * Mint a signed R2 GET URL for an image-asset key owned by the caller.
   * The server enforces key-scope ACLs (org/space/workspace must match JWT claims
   * and project ownership) — this client only ferries key + optional TTL.
   */
  async signAssetKey(
    key: string,
    ttlSec?: number,
  ): Promise<{ url: string; expiresAt: number }> {
    const { res, text, body: parsed } = await this.fetchWpn(
      "/me/assets/sign",
      "POST",
      "sign asset key",
      ttlSec !== undefined ? { key, ttlSec } : { key },
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`POST /me/assets/sign failed (${res.status}): ${err}`);
    }
    const b = parsed as { url?: unknown; expiresAt?: unknown };
    if (typeof b.url !== "string" || typeof b.expiresAt !== "number") {
      throw new Error("POST /me/assets/sign: missing url/expiresAt in response");
    }
    return { url: b.url, expiresAt: b.expiresAt };
  }

  async createNote(
    projectId: string,
    body: {
      type: string;
      relation: "root" | "child" | "sibling";
      anchorId?: string;
      title?: string;
      content?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ id: string }> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/wpn/projects/${encodeURIComponent(projectId)}/notes`,
      "POST",
      "WPN create note",
      body,
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN POST note failed (${res.status}): ${err}`);
    }
    const id = (parsed as { id?: string }).id;
    if (typeof id !== "string" || !id) {
      throw new Error("WPN POST note: missing id in response");
    }
    this.invalidateNotesWithContextCacheInternal();
    return { id };
  }
}
