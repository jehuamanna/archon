import type { McpTokenHolder } from "./mcp-token-holder.js";

/** Default TTL for `GET /wpn/notes-with-context` in-process cache (ms). */
const DEFAULT_NOTES_WITH_CONTEXT_TTL_MS = 2500;

export type WpnHttpClientOptions = {
  /** How long to reuse the notes-with-context catalog; invalidated on note PATCH/POST. */
  notesWithContextTtlMs?: number;
  /** Called after refresh (or login) updates tokens so MCP can persist. */
  onTokensUpdated?: (access: string, refresh: string | null) => void;
};

/**
 * Row shape from `GET /wpn/notes-with-context`. Post-migration the explorer
 * tree is `Org → Project → Note`; the MCP find-pass surfaces project
 * context (id + name) only. Workspace/space context columns were removed
 * with the org/team migration.
 */
export type WpnNoteWithContextRow = {
  id: string;
  title: string;
  type: string;
  project_id: string;
  project_name: string;
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

/** Public project row (snake_case) returned by `/wpn/projects` + `/wpn/full-tree`. */
export type WpnProjectRow = {
  id: string;
  org_id: string;
  creator_user_id: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

/** Org membership row from `GET /orgs/me`. */
export type OrgMembershipRow = {
  orgId: string;
  name: string;
  slug: string;
  role: "admin" | "member";
  isDefault: boolean;
};

/** Team row from `GET /orgs/:orgId/teams`. */
export type TeamRow = {
  teamId: string;
  orgId: string;
  departmentId: string;
  name: string;
  colorToken: string | null;
  memberCount: number;
  createdAt: string;
};

/** Department row from `GET /orgs/:orgId/departments`. */
export type DepartmentRow = {
  departmentId: string;
  orgId: string;
  name: string;
  colorToken: string | null;
  teamCount: number;
  memberCount: number;
  createdAt: string;
};

/** Team→project grant row from `GET /teams/:teamId/projects`. */
export type TeamProjectGrant = {
  projectId: string;
  projectName: string;
  role: "owner" | "contributor" | "viewer";
  grantedAt: string;
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

  /**
   * The HTTP base URL the client was configured with (already includes the
   * `/api/v1` v1 prefix for cloud sessions). Exposed so callers can derive
   * the matching Yjs WS URL via `deriveYjsWsUrl`.
   */
  getBaseUrl(): string {
    return this.baseUrl;
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

  // ── Org / team / department surface ────────────────────────────────────

  /** List orgs the authenticated user belongs to (and active selection). */
  async listMyOrgs(): Promise<{
    orgs: OrgMembershipRow[];
    activeOrgId: string | null;
    defaultOrgId: string | null;
  }> {
    return this.getJson(
      "/orgs/me",
      "GET /orgs/me",
    );
  }

  /** List teams in an org (caller must be an org member). */
  async listTeamsForOrg(orgId: string): Promise<TeamRow[]> {
    const body = await this.getJson<{ teams?: unknown }>(
      `/orgs/${encodeURIComponent(orgId)}/teams`,
      "GET org teams",
    );
    const t = body.teams;
    if (!Array.isArray(t)) {
      throw new Error("GET org teams: missing teams array");
    }
    return t as TeamRow[];
  }

  /** List departments in an org (caller must be an org member). */
  async listDepartmentsForOrg(orgId: string): Promise<DepartmentRow[]> {
    const body = await this.getJson<{ departments?: unknown }>(
      `/orgs/${encodeURIComponent(orgId)}/departments`,
      "GET org departments",
    );
    const d = body.departments;
    if (!Array.isArray(d)) {
      throw new Error("GET org departments: missing departments array");
    }
    return d as DepartmentRow[];
  }

  /** Admin-only: create a team in a department. */
  async createTeam(
    orgId: string,
    departmentId: string,
    name: string,
    colorToken?: string | null,
  ): Promise<{
    teamId: string;
    orgId: string;
    departmentId: string;
    name: string;
    colorToken: string | null;
  }> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/orgs/${encodeURIComponent(orgId)}/teams`,
      "POST",
      "POST team",
      colorToken !== undefined
        ? { departmentId, name, colorToken }
        : { departmentId, name },
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`POST team failed (${res.status}): ${err}`);
    }
    return parsed as {
      teamId: string;
      orgId: string;
      departmentId: string;
      name: string;
      colorToken: string | null;
    };
  }

  /** Admin-only: rename / recolor / move team to a different department. */
  async updateTeam(
    teamId: string,
    patch: { name?: string; colorToken?: string | null; departmentId?: string },
  ): Promise<void> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/teams/${encodeURIComponent(teamId)}`,
      "PATCH",
      "PATCH team",
      patch,
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`PATCH team failed (${res.status}): ${err}`);
    }
  }

  /** Admin-only: delete a team. */
  async deleteTeam(teamId: string): Promise<void> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/teams/${encodeURIComponent(teamId)}`,
      "DELETE",
      "DELETE team",
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`DELETE team failed (${res.status}): ${err}`);
    }
  }

  /** Admin-only: create a department. */
  async createDepartment(
    orgId: string,
    name: string,
    colorToken?: string | null,
  ): Promise<{
    departmentId: string;
    orgId: string;
    name: string;
    colorToken: string | null;
  }> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/orgs/${encodeURIComponent(orgId)}/departments`,
      "POST",
      "POST department",
      colorToken !== undefined ? { name, colorToken } : { name },
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`POST department failed (${res.status}): ${err}`);
    }
    return parsed as {
      departmentId: string;
      orgId: string;
      name: string;
      colorToken: string | null;
    };
  }

  /** Admin-only: rename / recolor a department. */
  async updateDepartment(
    departmentId: string,
    patch: { name?: string; colorToken?: string | null },
  ): Promise<void> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/departments/${encodeURIComponent(departmentId)}`,
      "PATCH",
      "PATCH department",
      patch,
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`PATCH department failed (${res.status}): ${err}`);
    }
  }

  /** Admin-only: delete a department (refused while teams reference it). */
  async deleteDepartment(departmentId: string): Promise<void> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/departments/${encodeURIComponent(departmentId)}`,
      "DELETE",
      "DELETE department",
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`DELETE department failed (${res.status}): ${err}`);
    }
  }

  /** List a team's project grants. */
  async listTeamProjects(teamId: string): Promise<TeamProjectGrant[]> {
    const body = await this.getJson<{ grants?: unknown }>(
      `/teams/${encodeURIComponent(teamId)}/projects`,
      "GET team projects",
    );
    const g = body.grants;
    if (!Array.isArray(g)) {
      throw new Error("GET team projects: missing grants array");
    }
    return g as TeamProjectGrant[];
  }

  /** Admin-only: grant the team a role on a project (idempotent upsert). */
  async grantTeamProject(
    teamId: string,
    projectId: string,
    role: "owner" | "contributor" | "viewer",
  ): Promise<void> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/teams/${encodeURIComponent(teamId)}/projects`,
      "POST",
      "POST team project grant",
      { projectId, role },
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`POST team project grant failed (${res.status}): ${err}`);
    }
  }

  /** Admin-only: revoke a team's project grant. */
  async revokeTeamProject(teamId: string, projectId: string): Promise<void> {
    const { res, text, body: parsed } = await this.fetchWpn(
      `/teams/${encodeURIComponent(teamId)}/projects/${encodeURIComponent(projectId)}`,
      "DELETE",
      "DELETE team project grant",
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`DELETE team project grant failed (${res.status}): ${err}`);
    }
  }

  /**
   * Switch active org for this session. `POST /orgs/active` returns a fresh
   * access token whose claims carry the new `activeOrgId` and (when
   * resolvable) `activeTeamId`. Applies the new token + org/team context to
   * the holder, invalidates the notes-with-context cache, and fires
   * `onTokensUpdated` so callers can persist.
   */
  async switchActiveOrg(orgId: string): Promise<{
    activeOrgId: string;
    activeTeamId: string | null;
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
      activeTeamId?: string | null;
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
    const teamId =
      typeof b.activeTeamId === "string" && b.activeTeamId.trim()
        ? b.activeTeamId.trim()
        : null;
    this.holder.setActiveTeam(teamId);
    this.onTokensUpdated?.(this.holder.accessToken, this.holder.refreshToken);
    this.invalidateNotesWithContextCacheInternal();
    return { activeOrgId: b.activeOrgId.trim(), activeTeamId: teamId };
  }

  // ── Project / note surface ─────────────────────────────────────────────

  /** List all projects readable to the caller in the active org. */
  async listProjects(): Promise<WpnProjectRow[]> {
    const body = await this.getJson<{ projects?: unknown }>(
      "/wpn/projects",
      "WPN GET projects",
    );
    const p = body.projects;
    if (!Array.isArray(p)) {
      throw new Error("WPN GET projects: missing projects array");
    }
    return p as WpnProjectRow[];
  }

  /** Single round-trip: projects + notesByProjectId + explorerStateByProjectId. */
  async getFullTree(): Promise<{
    projects: WpnProjectRow[];
    notesByProjectId: Record<string, WpnNoteListItem[]>;
    explorerStateByProjectId: Record<string, { expanded_ids: string[] }>;
  }> {
    return this.getJson(
      "/wpn/full-tree",
      "WPN GET full-tree",
    );
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
   * Resolve a noteId to its scope chain via `GET /wpn/notes/:id/scope`.
   * Post-migration the scope is just `(projectId, orgId)` — workspaces and
   * spaces are gone. Returns `null` when the note doesn't exist or is
   * unreadable (404). Pair with {@link ensureScopeForNote} for the
   * "switch then retry" flow used by every noteId-taking MCP tool.
   */
  async getNoteScope(noteId: string): Promise<{
    noteId: string;
    projectId: string;
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
      orgId?: unknown;
    };
    if (
      typeof b.noteId !== "string" ||
      typeof b.projectId !== "string"
    ) {
      throw new Error("WPN GET note scope: missing fields in response");
    }
    return {
      noteId: b.noteId,
      projectId: b.projectId,
      orgId: typeof b.orgId === "string" && b.orgId.length > 0 ? b.orgId : null,
    };
  }

  /**
   * Ensure the active org matches the home of `noteId`, switching when
   * needed so a downstream `notes-with-context`-style call (e.g. the
   * `archon_execute_note` find pass) can see the note. Returns a record of
   * what changed — `switched: false` when already in scope, otherwise the
   * before/after orgId so the calling tool can surface it.
   *
   * Org change requires re-minting the JWT (`switchActiveOrg`), which also
   * updates the JWT-carried `activeTeamId` claim. When the note is
   * unreadable (404), returns `{ switched: false, found: false }` and lets
   * the caller decide whether to fall through.
   */
  async ensureScopeForNote(noteId: string): Promise<{
    switched: boolean;
    found: boolean;
    fromOrgId: string | null;
    toOrgId: string | null;
  }> {
    const fromOrgId = this.holder.activeOrgId;
    let scope: Awaited<ReturnType<WpnHttpClient["getNoteScope"]>>;
    try {
      scope = await this.getNoteScope(noteId);
    } catch {
      return {
        switched: false,
        found: false,
        fromOrgId,
        toOrgId: fromOrgId,
      };
    }
    if (!scope) {
      return {
        switched: false,
        found: false,
        fromOrgId,
        toOrgId: fromOrgId,
      };
    }
    const targetOrgId = scope.orgId;
    const orgMatches = targetOrgId === null || targetOrgId === fromOrgId;
    if (orgMatches) {
      return {
        switched: false,
        found: true,
        fromOrgId,
        toOrgId: fromOrgId,
      };
    }
    if (targetOrgId) {
      await this.switchActiveOrg(targetOrgId);
    }
    return {
      switched: true,
      found: true,
      fromOrgId,
      toOrgId: this.holder.activeOrgId,
    };
  }

  /**
   * Mint a short-TTL `spaceWs` JWT via `POST /realtime/ws-token`. Used by
   * `archon_write_note` to open a Hocuspocus client connection for content
   * updates. Per-note authorisation runs at WS open time on the server; the
   * minted token only proves identity. The `typ: "spaceWs"` JWT name is
   * vestigial — preserved for client compat after the spaces squash.
   */
  async mintRealtimeWsToken(): Promise<string | null> {
    const { res, text, body } = await this.fetchWpn(
      "/realtime/ws-token",
      "POST",
      "WPN mint ws-token",
      {},
    );
    if (res.status === 403 || res.status === 404) return null;
    if (!res.ok) {
      const err = (body as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`POST /realtime/ws-token failed (${res.status}): ${err}`);
    }
    const b = body as { token?: unknown };
    if (typeof b.token !== "string" || !b.token.trim()) {
      throw new Error("POST /realtime/ws-token: missing token");
    }
    return b.token;
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

  async createProject(
    name: string,
    opts: { teamId?: string; teamRole?: "owner" | "contributor" | "viewer" } = {},
  ): Promise<WpnProjectRow> {
    const body: Record<string, unknown> = { name };
    if (opts.teamId !== undefined) body.teamId = opts.teamId;
    if (opts.teamRole !== undefined) body.teamRole = opts.teamRole;
    const { res, text, body: parsed } = await this.fetchWpn(
      "/wpn/projects",
      "POST",
      "WPN create project",
      body,
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN POST project failed (${res.status}): ${err}`);
    }
    const project = (parsed as { project?: WpnProjectRow }).project;
    if (!project || typeof project.id !== "string") {
      throw new Error("WPN POST project: missing project in response");
    }
    this.invalidateNotesWithContextCacheInternal();
    return project;
  }

  async updateProject(
    projectId: string,
    patch: { name?: string; sortIndex?: number; colorToken?: string | null },
  ): Promise<WpnProjectRow> {
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
    const project = (parsed as { project?: WpnProjectRow }).project;
    if (!project) {
      throw new Error("WPN PATCH project: missing project in response");
    }
    return project;
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
    draggedId: string,
    targetId: string,
    placement: "before" | "after" | "into",
  ): Promise<void> {
    const { res, text, body: parsed } = await this.fetchWpn(
      "/wpn/notes/move",
      "POST",
      "WPN move note",
      { draggedId, targetId, placement },
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
    targetParentId: string | null,
  ): Promise<void> {
    const { res, text, body: parsed } = await this.fetchWpn(
      "/wpn/notes/move-to-project",
      "POST",
      "WPN move note to project",
      { noteId, targetProjectId, targetParentId },
    );
    if (!res.ok) {
      const err = (parsed as { error?: string })?.error ?? text.slice(0, 200);
      throw new Error(`WPN move-to-project failed (${res.status}): ${err}`);
    }
    this.invalidateNotesWithContextCacheInternal();
  }

  async duplicateProject(
    projectId: string,
    opts: { teamId?: string; newName?: string } = {},
  ): Promise<{ projectId: string; name: string }> {
    const body: Record<string, string> = {};
    if (opts.teamId !== undefined) body.teamId = opts.teamId;
    if (opts.newName !== undefined) body.newName = opts.newName;
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

  /**
   * Stream the org's bundle export as a ZIP. Optionally restrict to a
   * subset of `projectIds`; the server enforces read access per project
   * and rejects any unreadable id.
   */
  async exportProjects(projectIds?: string[]): Promise<ArrayBuffer> {
    const doFetch = () =>
      fetch(this.url("/wpn/export"), {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(projectIds ? { projectIds } : {}),
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

  /**
   * Import a v3 bundle ZIP into a target team. The server pins the
   * imported projects' org to the team's org and creates `team_projects`
   * grants for each newly imported project against that team.
   */
  async importProjects(zipBuffer: ArrayBuffer, teamId: string): Promise<unknown> {
    const boundary = `----archon${Date.now()}`;
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="import.zip"\r\nContent-Type: application/zip\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const headerBuf = new TextEncoder().encode(header);
    const footerBuf = new TextEncoder().encode(footer);
    const bodyBuf = new Uint8Array(headerBuf.length + zipBuffer.byteLength + footerBuf.length);
    bodyBuf.set(headerBuf, 0);
    bodyBuf.set(new Uint8Array(zipBuffer), headerBuf.length);
    bodyBuf.set(footerBuf, headerBuf.length + zipBuffer.byteLength);

    const buildHeaders = (): Record<string, string> => {
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
      return h;
    };
    const importUrl = `${this.url("/wpn/import")}?teamId=${encodeURIComponent(teamId)}`;
    const doFetch = () =>
      fetch(importUrl, {
        method: "POST",
        headers: buildHeaders(),
        body: bodyBuf,
      });
    let res = await doFetch();
    if (res.status === 401 && this.holder.refreshToken) {
      const ok = await this.tryRefresh();
      if (ok) {
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

  /**
   * Mint a signed R2 GET URL for an image-asset key owned by the caller.
   * The server enforces key-scope ACLs (org/project must match the JWT's
   * active org and the project's org_id) — this client only ferries key +
   * optional TTL.
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
