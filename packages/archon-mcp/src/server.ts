import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadMcpAuthRuntime, type McpAuthRuntime } from "./config.js";
import {
  clearPersistedMcpAuth,
  writePersistedMcpAuth,
} from "./mcp-cloud-auth-persist.js";
import { mapWpnCaughtError, unauthenticatedToolResult } from "./mcp-unauthenticated.js";
import { findNotesByQuery, findProjectsByQuery, isLikelyUuid } from "./find-wpn.js";
import { parseParentWpnPath, resolveParentInTree } from "./resolve-parent-in-tree.js";
import { norm, resolveNoteFromCatalog } from "./resolve-note.js";
import { errorResult, jsonResult, type ToolReturn } from "./text-result.js";
import {
  WpnHttpClient,
  type WpnNoteDetail,
  type WpnNoteListItem,
  type WpnNoteWithContextRow,
} from "./wpn-client.js";
import { deriveYjsWsUrl, writeNoteContentViaYjs } from "./yjs-write.js";
import {
  DEFAULT_MAX_BYTES as GET_IMAGE_NOTE_DEFAULT_MAX_BYTES,
  handleGetImageNote,
} from "./get-image-note.js";
import { installSkill } from "./install-skill.js";
import { extractReferencedLinksFromMarkdown } from "./note-link-extract.js";
import {
  canonicalVfsPathFromRow,
  resolveVfsHrefToNoteId,
} from "./note-vfs-resolve.js";

const resolveInput = z.object({
  projectName: z.string().describe("Project name (trimmed, case-insensitive match)"),
  noteTitle: z.string().describe("Note title (trimmed, case-insensitive match)"),
});

const getNoteInput = z.object({
  noteId: z.string().describe("Canonical note UUID"),
});

const getImageNoteInput = z.object({
  noteId: z.string().describe("Canonical note UUID of an image-type note"),
  mode: z
    .enum(["auto", "inline", "base64", "url", "thumbnail"])
    .optional()
    .describe(
      "Delivery mode. 'auto' (default) returns a native MCP image block unless the file exceeds maxBytes, in which case a signed URL is returned instead. 'inline' forces a native image block. 'base64' returns bytes as a JSON string. 'url' returns only a time-limited signed URL (no bytes). 'thumbnail' returns the PLAN-04 WebP thumb if present.",
    ),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Size ceiling for inline/base64 delivery. Over cap, falls back to 'url' with a reason string. Default 524288 (512 KiB).",
    ),
});

const getNoteTitleInput = z.object({
  noteId: z.string().describe("Canonical note UUID"),
});

const getNoteWithLinksInput = z.object({
  noteId: z.string().describe("Canonical note UUID of the target note"),
  maxNotes: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Hard cap on total notes fetched (target + linked). Defaults to 200. When the cap is hit, stats.truncated is true and remaining ids are not fetched.",
    ),
  includeBacklinks: z
    .boolean()
    .optional()
    .describe(
      "When true (default), also include one-hop backlinks for the target note (notes referencing it).",
    ),
});

const noteRenameInput = z.object({
  noteId: z.string().describe("Canonical note UUID"),
  title: z.string().describe("Full new title for the note (same as WPN PATCH title)."),
});

const findProjectsInput = z.object({
  query: z.string().describe("Project name or project UUID"),
});

const findNotesInput = z.object({
  query: z.string().describe("Note title or note UUID"),
  projectQuery: z
    .string()
    .optional()
    .describe("Optional project name or UUID to narrow results"),
});

const executeNoteInput = z.object({
  noteQuery: z
    .string()
    .describe("Note title or canonical note UUID (same matching rules as archon_find_notes)."),
  projectQuery: z
    .string()
    .optional()
    .describe("Optional project name or UUID to narrow results before fetch."),
});

const listOrgTreeInput = z.object({
  scope: z
    .enum(["projects", "notes", "full_tree"])
    .describe(
      "projects: list all projects readable to the caller in the active org. notes: flat note tree of a project (requires projectId). full_tree: all projects and notes in one payload.",
    ),
  projectId: z
    .string()
    .optional()
    .describe("Required when scope=notes. Project UUID."),
  orgId: z
    .string()
    .optional()
    .describe(
      "Optional: override active org for this single call. Does not change the session's active org; use archon_set_active_org for that.",
    ),
});

function validateListOrgTreeArgs(
  args: z.infer<typeof listOrgTreeInput>,
): { ok: true } | { ok: false; error: string } {
  if (args.scope === "notes") {
    if (!args.projectId || !args.projectId.trim()) {
      return { ok: false, error: "scope=notes requires projectId." };
    }
  }
  return { ok: true };
}

const setActiveOrgInput = z.object({
  orgId: z.string().min(1).describe("Target organization UUID (from archon_list_orgs)."),
});

const writeBackChildInput = z.object({
  taskNoteId: z
    .string()
    .describe(
      "The Archon note id the agent worked from; the write-back is created as a new direct child of this note.",
    ),
  title: z.string().describe("Title for the new child note (e.g. session summary or task outcome)."),
  content: z.string().describe("Body for the new child note (markdown or plain text)."),
  type: z
    .string()
    .optional()
    .describe("Note type; defaults to markdown when omitted."),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const createChildNoteInput = z.object({
  parentNoteId: z
    .string()
    .optional()
    .describe("Parent note UUID. When set, project/path fields are ignored."),
  projectName: z
    .string()
    .optional()
    .describe("With parentPathTitles, names the project (trim, case-insensitive)."),
  parentPathTitles: z
    .array(z.string())
    .optional()
    .describe("Titles from a project root note down to the parent; each step is among direct children."),
  parentWpnPath: z
    .string()
    .optional()
    .describe('Convenience: "Project / Title1 / …" split on ` / ` (space-slash-space).'),
  title: z.string().describe("Title for the new child note."),
  content: z.string().describe("Body for the new child note."),
  type: z.string().optional().describe("Note type; defaults to markdown when omitted."),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function validateCreateChildNoteParent(
  data: z.infer<typeof createChildNoteInput>,
): { ok: true } | { ok: false; error: string } {
  const idTrim = data.parentNoteId?.trim() ?? "";
  const hasId = idTrim.length > 0;
  const pathTrim = data.parentWpnPath?.trim() ?? "";
  const hasWpnPath = pathTrim.length > 0;
  const proj = data.projectName?.trim() ?? "";
  const titles = data.parentPathTitles;
  const hasStruct =
    proj.length > 0 && Array.isArray(titles) && titles.length > 0;

  const modes = (hasId ? 1 : 0) + (hasWpnPath ? 1 : 0) + (hasStruct ? 1 : 0);
  if (modes !== 1) {
    return {
      ok: false,
      error:
        "Provide exactly one parent selector: parentNoteId, OR parentWpnPath, OR projectName + parentPathTitles (non-empty array).",
    };
  }
  if (hasStruct && titles) {
    for (let i = 0; i < titles.length; i++) {
      if (typeof titles[i] !== "string" || titles[i]!.trim() === "") {
        return { ok: false, error: `parentPathTitles[${i}] must be a non-empty string.` };
      }
    }
  }
  return { ok: true };
}

const writeNoteInput = z.object({
  mode: z
    .enum(["patch_existing", "create_root", "create_child", "create_sibling"])
    .describe(
      "patch_existing: PATCH an existing note (requires noteId). create_root: POST a new root note in a project (requires projectId, type). create_child / create_sibling: POST a new note relative to an anchor (requires projectId, anchorId, type).",
    ),
  noteId: z
    .string()
    .optional()
    .describe("Required when mode=patch_existing. Note UUID to patch."),
  projectId: z
    .string()
    .optional()
    .describe("Required when mode is create_root | create_child | create_sibling. Project UUID."),
  anchorId: z
    .string()
    .optional()
    .describe("Required when mode is create_child | create_sibling. Anchor note UUID for the relation."),
  type: z
    .string()
    .optional()
    .describe("Note type. Required when mode is create_root | create_child | create_sibling. Optional patch when mode=patch_existing."),
  title: z.string().optional().describe("Note title (optional patch when mode=patch_existing)."),
  content: z.string().optional().describe("Note body (optional patch when mode=patch_existing)."),
  metadata: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe("Note metadata. null clears it on patch_existing; omit to leave unchanged."),
});

function validateWriteNoteArgs(
  args: z.infer<typeof writeNoteInput>,
): { ok: true } | { ok: false; error: string } {
  if (args.mode === "patch_existing") {
    if (!args.noteId || !args.noteId.trim()) {
      return { ok: false, error: "mode=patch_existing requires noteId." };
    }
    return { ok: true };
  }
  if (!args.projectId || !args.projectId.trim()) {
    return { ok: false, error: `mode=${args.mode} requires projectId.` };
  }
  if (!args.type || !args.type.trim()) {
    return { ok: false, error: `mode=${args.mode} requires type.` };
  }
  if (args.mode === "create_child" || args.mode === "create_sibling") {
    if (!args.anchorId || !args.anchorId.trim()) {
      return { ok: false, error: `mode=${args.mode} requires anchorId.` };
    }
  }
  return { ok: true };
}

const listTeamsInput = z.object({
  orgId: z
    .string()
    .optional()
    .describe(
      "Org UUID. Defaults to the active org for the current session.",
    ),
});

const listDepartmentsInput = z.object({
  orgId: z
    .string()
    .optional()
    .describe(
      "Org UUID. Defaults to the active org for the current session.",
    ),
});

const createTeamInput = z.object({
  name: z.string().min(1).describe("Name for the new team."),
  departmentId: z
    .string()
    .describe(
      "Parent department UUID. Every team belongs to a department; use archon_list_departments to find one.",
    ),
  orgId: z
    .string()
    .optional()
    .describe("Org UUID. Defaults to the active org for the current session."),
  colorToken: z.string().nullable().optional().describe("Optional color token, or null to clear."),
});

const updateTeamInput = z.object({
  teamId: z.string().describe("Team UUID."),
  name: z.string().optional().describe("New name for the team."),
  colorToken: z
    .string()
    .nullable()
    .optional()
    .describe("Color token string, or null to clear."),
  departmentId: z
    .string()
    .optional()
    .describe(
      "Move the team to a different department. The new department must belong to the same org.",
    ),
});

const deleteTeamInput = z.object({
  teamId: z
    .string()
    .describe(
      "Team UUID to delete. Memberships and project grants cascade. Projects themselves are NOT deleted (team_projects is many-to-many).",
    ),
});

const createDepartmentInput = z.object({
  name: z.string().min(1).describe("Name for the new department."),
  orgId: z
    .string()
    .optional()
    .describe("Org UUID. Defaults to the active org for the current session."),
  colorToken: z.string().nullable().optional().describe("Optional color token, or null to clear."),
});

const updateDepartmentInput = z.object({
  departmentId: z.string().describe("Department UUID."),
  name: z.string().optional().describe("New name for the department."),
  colorToken: z
    .string()
    .nullable()
    .optional()
    .describe("Color token string, or null to clear."),
});

const deleteDepartmentInput = z.object({
  departmentId: z
    .string()
    .describe(
      "Department UUID to delete. Refused while teams still belong to it — move or delete those teams first.",
    ),
});

const grantTeamProjectInput = z.object({
  teamId: z.string().describe("Team UUID."),
  projectId: z.string().describe("Project UUID. Must belong to the team's org."),
  role: z
    .enum(["owner", "contributor", "viewer"])
    .describe("Role to grant the team on the project. Idempotent — upserts on (teamId, projectId)."),
});

const revokeTeamProjectInput = z.object({
  teamId: z.string().describe("Team UUID."),
  projectId: z.string().describe("Project UUID."),
});

const installSkillInput = z.object({
  noteId: z
    .string()
    .optional()
    .describe(
      "Install one specific note by UUID. When given, takes precedence over scan. Note content may be a raw SKILL.md (starts with `---\\nname: …`) or a wrapper note with a ```markdown` fence containing the SKILL.md.",
    ),
  skillName: z
    .string()
    .optional()
    .describe(
      "Install only the skill whose frontmatter `name` matches this value. Ignored when noteId is given.",
    ),
  projectName: z
    .string()
    .optional()
    .describe(
      'Project to scan for skills. Default: "Skills". Ignored when noteId is given.',
    ),
  noteName: z
    .string()
    .optional()
    .describe(
      'Parent note whose direct children are the skill notes. Default: "SKILLS.md". Ignored when noteId is given.',
    ),
  repoPath: z
    .string()
    .describe(
      "Absolute path to the caller's project repo root. Required. Skills are written under this path into the provider dot-dirs (`.claude/skills`, `.cursor/rules`, `.windsurf/rules`, `.github/instructions`, `.agents/skills`, `.opencode/agents`). The MCP server runs as a long-lived global process and cannot infer the caller's cwd — pass the agent's current working directory.",
    ),
  providers: z
    .array(
      z.enum([
        "claude",
        "cursor",
        "windsurf",
        "copilot",
        "antigravity",
        "opencode",
      ]),
    )
    .optional()
    .describe(
      "Editors/IDEs to install the skill for. Available options: \"claude\" (.claude/skills), \"cursor\" (.cursor/rules), \"windsurf\" (.windsurf/rules), \"copilot\" (.github/instructions), \"antigravity\" (.agents/skills), \"opencode\" (.opencode/agents). If OMITTED, the tool returns a `needsUserInput` response listing the editor options — the agent must surface those options to the user in chat, get their pick, and re-invoke with `providers` set. Default-on-no-preference is [\"claude\"]. Pass an array to target multiple editors at once.",
    ),
});

const createProjectInput = z.object({
  name: z.string().min(1).describe("Name for the new project."),
  teamId: z
    .string()
    .optional()
    .describe(
      "Optional team UUID to grant initial access. When omitted, the project is created with no team grants — only the creator can read/write it via the per-creator role.",
    ),
  teamRole: z
    .enum(["owner", "contributor", "viewer"])
    .optional()
    .describe("Role granted to the team. Default 'owner' when teamId is set."),
});

const updateProjectInput = z.object({
  projectId: z.string().describe("Project UUID."),
  name: z.string().optional().describe("New name for the project."),
  sortIndex: z.number().optional().describe("Sort order index."),
  colorToken: z.string().nullable().optional().describe("Color token string, or null to clear."),
});

const deleteProjectInput = z.object({
  projectId: z.string().describe("Project UUID to delete. Deletes all contained notes."),
});

const deleteNotesInput = z.object({
  ids: z.array(z.string()).min(1).describe("Array of note UUIDs to delete (bulk). Descendants are also removed."),
});

const moveNoteInput = z.object({
  draggedId: z.string().describe("Note UUID to move."),
  targetId: z.string().describe("Note UUID that is the drop target."),
  placement: z.enum(["before", "after", "into"]).describe(
    "Where to place relative to target: before (sibling above), after (sibling below), into (first child of target).",
  ),
});

const duplicateSubtreeInput = z.object({
  projectId: z.string().describe("Project UUID."),
  noteId: z.string().describe("Root note UUID of the subtree to duplicate."),
});

const backlinksInput = z.object({
  noteId: z.string().describe("Note UUID to find backlinks for (notes whose content references this note)."),
});

const copyIdInput = z.object({
  kind: z
    .enum(["org", "department", "team", "project", "note"])
    .describe("What kind of id to resolve."),
  query: z
    .string()
    .min(1)
    .describe("Name (trim + case-insensitive) or UUID. UUIDs pass through as-is."),
  projectQuery: z
    .string()
    .optional()
    .describe("Narrow note searches to a project name or UUID."),
  orgQuery: z
    .string()
    .optional()
    .describe(
      "Narrow team / department searches to an org name, slug, or UUID. Defaults to the active org.",
    ),
  departmentQuery: z
    .string()
    .optional()
    .describe("Narrow team searches to a department name or UUID."),
});

const moveNoteToProjectInput = z.object({
  noteId: z.string().describe("Note UUID to move (root of the subtree)."),
  targetProjectId: z.string().describe("Destination project UUID."),
  targetParentId: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Optional parent note UUID in the target project. Null (or omitted) inserts at the project root.",
    ),
});

const duplicateProjectInput = z.object({
  projectId: z.string().describe("Project UUID to duplicate."),
  teamId: z
    .string()
    .optional()
    .describe(
      "Optional team UUID to grant 'owner' on the duplicate (idempotent). When omitted, the duplicate has no team grants.",
    ),
  newName: z
    .string()
    .optional()
    .describe("Optional name for the duplicate. Defaults to the source project name."),
});

const exportOrgInput = z.object({
  projectIds: z
    .array(z.string())
    .optional()
    .describe(
      "Optional list of project UUIDs to export. Omit to export every project the caller can read in the active org.",
    ),
});

const importOrgInput = z.object({
  zipBase64: z.string().describe("Base64-encoded ZIP file content from a previous export."),
  teamId: z
    .string()
    .describe(
      "Target team UUID. Imported projects get an 'owner' team_projects grant for this team and inherit the team's org.",
    ),
});

const archonLoginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const archonLoginBrowserPollInput = z.object({
  device_code: z.string().min(10).describe("Secret from archon_login_browser_start; do not log."),
});

function requireCloudAccess(runtime: McpAuthRuntime, client: WpnHttpClient): ToolReturn | null {
  if (runtime.cloudSession && !client.getHolder().hasAccess()) {
    return unauthenticatedToolResult(
      "No access token. Call archon_login_browser_start (open verification_uri, complete login in browser, then archon_login_browser_poll), or archon_login, or set ARCHON_ACCESS_TOKEN.",
    );
  }
  return null;
}

function wpnCatch(e: unknown, runtime: McpAuthRuntime): ToolReturn {
  const mapped = mapWpnCaughtError(e, runtime.cloudSession);
  if (mapped) {
    return mapped;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return errorResult(msg);
}

/**
 * Surfaced on tool results when a noteId-driven call automatically switched
 * the active org to make the note discoverable. Lets the calling agent
 * (and the user) see that session state changed.
 */
type ScopeSwitch = {
  fromOrgId: string | null;
  toOrgId: string | null;
};

/**
 * Ensure the active org matches the home of `noteId` before the tool
 * proceeds. Returns the switch record when state changed, or `null` when
 * already in scope (or when noteId is empty / not a UUID — in which case
 * the caller should fall through to its normal lookup logic). Never throws
 * — a scope-resolution error is swallowed and the caller's downstream call
 * is allowed to surface the underlying failure on its own.
 */
async function ensureNoteScope(
  client: WpnHttpClient,
  noteId: string | null | undefined,
): Promise<ScopeSwitch | null> {
  if (!noteId) return null;
  const trimmed = noteId.trim();
  if (!trimmed || !isLikelyUuid(trimmed)) return null;
  try {
    const r = await client.ensureScopeForNote(trimmed);
    if (!r.switched) return null;
    return {
      fromOrgId: r.fromOrgId,
      toOrgId: r.toOrgId,
    };
  } catch {
    return null;
  }
}

/** Merge `scopeSwitched` into a tool result payload only when a switch occurred. */
function withScopeSwitched<T extends Record<string, unknown>>(
  payload: T,
  switched: ScopeSwitch | null,
): T | (T & { scopeSwitched: ScopeSwitch }) {
  if (!switched) return payload;
  return { ...payload, scopeSwitched: switched };
}

/** Compose "Project / Title" for an image note, or null when the catalog misses it. */
async function resolveNotePathForImage(
  client: WpnHttpClient,
  note: WpnNoteDetail,
): Promise<string | null> {
  try {
    const rows = await client.getNotesWithContext();
    const row = rows.find((r) => r.id === note.id);
    if (!row) return null;
    return `${row.project_name} / ${row.title}`;
  } catch {
    return null;
  }
}

/** GET a signed R2 URL and return its raw bytes. */
async function fetchSignedImageBytes(
  url: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`signed-URL GET failed (${res.status})`);
  }
  const mimeType = res.headers.get("content-type") ?? "";
  const buf = await res.arrayBuffer();
  return { bytes: new Uint8Array(buf), mimeType };
}

function persistIfNeeded(runtime: McpAuthRuntime): void {
  if (runtime.mode !== "cloud_session" || !runtime.persistPath) {
    return;
  }
  const h = runtime.holder;
  if (!h.hasAccess()) {
    return;
  }
  writePersistedMcpAuth(runtime.persistPath, {
    accessToken: h.accessToken,
    refreshToken: h.refreshToken ?? "",
  });
}

async function postJsonUnauthed(
  baseUrl: string,
  apiPath: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const p = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const url = `${baseUrl}${p}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text.trim() ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { ok: res.ok, status: res.status, json };
}

function parseJwtUnverified(accessToken: string): {
  unverified_sub?: string;
  access_expires_at_ms?: number;
} {
  const parts = accessToken.split(".");
  if (parts.length < 2) {
    return {};
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      sub?: string;
      exp?: number;
    };
    const out: { unverified_sub?: string; access_expires_at_ms?: number } = {};
    if (typeof payload.sub === "string") {
      out.unverified_sub = payload.sub;
    }
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
      out.access_expires_at_ms = payload.exp * 1000;
    }
    return out;
  } catch {
    return {};
  }
}

const MCP_INSTRUCTIONS =
  "Archon WPN tools: archon_list_org_tree lists projects / notes / full_tree in the active org; " +
  "archon_create_team / archon_update_team / archon_delete_team manage teams; " +
  "archon_create_department / archon_update_department / archon_delete_department manage departments; " +
  "archon_list_teams / archon_list_departments enumerate the active org's teams and departments; " +
  "archon_grant_team_project / archon_revoke_team_project manage team↔project access grants; " +
  "archon_create_project / archon_update_project / archon_delete_project manage projects; " +
  "archon_find_projects / archon_find_notes resolve by name or UUID with path (Project / Title) and ambiguity hints; " +
  "archon_resolve_note finds a noteId from project+title; archon_get_note reads a note (markdown + metadata, never image bytes); " +
  "archon_get_image_note delivers an image-type note's bytes (auto|inline|base64|url|thumbnail), defaulting to a native MCP image block and falling back to a signed URL over the 512 KiB cap — EXIF/text metadata is stripped for JPEG/PNG/WebP in byte-returning modes (url mode streams raw R2 bytes); " +
  "archon_get_note_title returns only { noteId, title } for composing renames; archon_note_rename PATCHes the full title (duplicate sibling title → error); " +
  "archon_execute_note resolves by title or id, returns ambiguity (path + noteId per candidate) for the user to pick, or returns the full note when unique — then the agent follows note.content; " +
  "archon_create_child_note creates a direct child under a parent given by parentNoteId OR by project+nested title path OR parentWpnPath string; " +
  "archon_write_note patches or creates notes; archon_delete_notes bulk-deletes notes by id; archon_move_note reparents/reorders a note (before/after/into); archon_duplicate_subtree copies a note branch; " +
  "archon_backlinks finds notes referencing a given note id; archon_export_org / archon_import_org handle ZIP-based backup and restore (import targets a team via teamId); " +
  "archon_write_back_child creates a child under a task note after completing work scoped to that note. " +
  "Write-back policy: when you finish work that was driven by a specific Archon note, call archon_write_back_child with taskNoteId equal to that note so the outcome is attached as a new direct child (audit trail). " +
  "If that note already has other children, still attach the write-back as a new direct child of the same task note unless the user asked for a different placement. " +
  "Tool overlap is intentional: archon_execute_note equals find_notes then get_note when unique; archon_write_back_child equals get_note then write_note create_child when you only have taskNoteId; archon_create_child_note overlaps write_back when you need path-based parent resolution. " +
  "Auth: use ARCHON_SYNC_API_BASE + ARCHON_ACCESS_TOKEN (cloud), ARCHON_LOCAL_WPN_URL + ARCHON_LOCAL_WPN_TOKEN (Electron loopback), or ARCHON_MCP_CLOUD_SESSION=1 for browser (archon_login_browser_*) or password (archon_login). " +
  "If any tool returns JSON with error \"unauthenticated\" and suggested_tools, call archon_login_browser_start first (preferred), complete the browser step, use archon_login_browser_poll with device_code until authorized, or use archon_login — do not use archon_logout for that case. " +
  "archon_auth_status reports session state without exposing secrets. " +
  "Cross-org: archon_list_orgs lists the user's orgs; archon_set_active_org flips the session to another org (re-issues JWT with activeOrgId + activeTeamId); archon_list_org_tree accepts optional orgId for a one-shot read against a different org without changing the session. " +
  "Auto scope-switch: tools that take a noteId (get_note, get_image_note, get_note_with_links, get_note_title, note_rename, execute_note (UUID), find_notes (UUID), create_child_note (parentNoteId), write_back_child, write_note (patch_existing or create_child/sibling with anchorId), delete_notes (first id), move_note, move_note_to_project, duplicate_subtree, backlinks) automatically switch the active org to the note's home before running, so you don't have to call archon_set_active_org first. When a switch happens, the tool result includes a `scopeSwitched` field with the before/after orgId.";

/**
 * Create a fully-configured McpServer with all Archon WPN tools registered.
 * Reusable across transports (stdio, SSE, Streamable HTTP).
 */
export function createArchonMcpServer(
  runtime: McpAuthRuntime,
  client: WpnHttpClient,
): McpServer {
  const mcp = new McpServer(
    { name: "archon-mcp", version: "0.0.0" },
    {
      capabilities: {
        tools: {},
      },
      instructions: MCP_INSTRUCTIONS,
    },
  );

  /** Resolve the org id to use for an org-scoped tool call. */
  const resolveOrgIdForCall = async (
    overrideOrgId?: string,
  ): Promise<string> => {
    const trimmed = overrideOrgId?.trim();
    if (trimmed) return trimmed;
    if (runtime.holder.activeOrgId) return runtime.holder.activeOrgId;
    const r = await client.listMyOrgs();
    const orgId = r.activeOrgId ?? r.defaultOrgId ?? null;
    if (!orgId) {
      throw new Error(
        "No active org available. Pass orgId explicitly or call archon_set_active_org first.",
      );
    }
    runtime.holder.setActiveOrg(orgId);
    return orgId;
  };

  mcp.registerTool(
    "archon_find_projects",
    {
      description:
        "Find project(s) by name or id within the active org. Returns status unique | ambiguous | none; " +
        "each match includes projectId and path \"Project\". On clash, all candidates are listed.",
      inputSchema: findProjectsInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) {
        return denied;
      }
      try {
        const result = await findProjectsByQuery(client, args.query);
        return jsonResult(result);
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_find_notes",
    {
      description:
        "Find note(s) by title or id using GET /wpn/notes-with-context. Optional projectQuery narrows scope. " +
        "Returns status unique | ambiguous | none | project_ambiguous; " +
        "each match includes noteId, title, and path \"Project / Title\". " +
        "When query is a UUID, the active org is auto-switched to the note's home before searching (response includes scopeSwitched).",
      inputSchema: findNotesInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) {
        return denied;
      }
      try {
        const switched = await ensureNoteScope(client, args.query);
        const rows = await client.getNotesWithContext();
        const result = findNotesByQuery(
          rows,
          args.query,
          args.projectQuery,
        );
        return jsonResult(withScopeSwitched(result as Record<string, unknown>, switched));
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_list_org_tree",
    {
      description:
        "List active-org content: projects (GET /wpn/projects), flat note tree for a project (requires projectId), or full_tree (all projects + notes in one payload via GET /wpn/full-tree). " +
        "Optional orgId overrides the active org for this single call only (restored afterwards).",
      inputSchema: listOrgTreeInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) {
        return denied;
      }
      const validation = validateListOrgTreeArgs(args);
      if (!validation.ok) {
        return errorResult(validation.error);
      }
      const orgOverride = args.orgId?.trim() || null;
      const prevOrg = runtime.holder.activeOrgId;
      const restoreHolder = orgOverride !== null;
      if (restoreHolder) {
        runtime.holder.setActiveOrg(orgOverride);
        client.invalidateNotesWithContextCache();
      }
      try {
        if (args.scope === "projects") {
          const projects = await client.listProjects();
          return jsonResult({ scope: "projects", projects });
        }
        if (args.scope === "notes") {
          const notes = await client.getNotesFlat(args.projectId!);
          return jsonResult({ scope: "notes", projectId: args.projectId, notes });
        }
        const tree = await client.getFullTree();
        return jsonResult({ scope: "full_tree", ...tree });
      } catch (e) {
        return wpnCatch(e, runtime);
      } finally {
        if (restoreHolder) {
          runtime.holder.setActiveOrg(prevOrg);
          client.invalidateNotesWithContextCache();
        }
      }
    },
  );

  mcp.registerTool(
    "archon_list_teams",
    {
      description:
        "List teams in an org. Returns { teams: [{ teamId, orgId, departmentId, name, colorToken, memberCount, createdAt }] }.",
      inputSchema: listTeamsInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const orgId = await resolveOrgIdForCall(args.orgId);
        const teams = await client.listTeamsForOrg(orgId);
        return jsonResult({ orgId, teams });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_list_departments",
    {
      description:
        "List departments in an org. Returns { departments: [{ departmentId, orgId, name, colorToken, teamCount, memberCount, createdAt }] }.",
      inputSchema: listDepartmentsInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const orgId = await resolveOrgIdForCall(args.orgId);
        const departments = await client.listDepartmentsForOrg(orgId);
        return jsonResult({ orgId, departments });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_create_team",
    {
      description:
        "Admin-only: create a new team inside a department of the active (or named) org. Caller must be org-admin or master-admin.",
      inputSchema: createTeamInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const orgId = await resolveOrgIdForCall(args.orgId);
        const team = await client.createTeam(
          orgId,
          args.departmentId,
          args.name,
          args.colorToken,
        );
        return jsonResult({ ok: true as const, team });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_update_team",
    {
      description:
        "Admin-only: rename a team, change its color, or move it to a different department in the same org.",
      inputSchema: updateTeamInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const patch: { name?: string; colorToken?: string | null; departmentId?: string } = {};
        if (args.name !== undefined) patch.name = args.name;
        if (args.colorToken !== undefined) patch.colorToken = args.colorToken;
        if (args.departmentId !== undefined) patch.departmentId = args.departmentId;
        await client.updateTeam(args.teamId, patch);
        return jsonResult({ ok: true as const, teamId: args.teamId });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_delete_team",
    {
      description:
        "Admin-only: delete a team. Memberships and project grants cascade; projects themselves are unaffected (team_projects is many-to-many).",
      inputSchema: deleteTeamInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        await client.deleteTeam(args.teamId);
        return jsonResult({ ok: true as const });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_create_department",
    {
      description:
        "Admin-only: create a new department in the active (or named) org. Caller must be org-admin or master-admin.",
      inputSchema: createDepartmentInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const orgId = await resolveOrgIdForCall(args.orgId);
        const dept = await client.createDepartment(orgId, args.name, args.colorToken);
        return jsonResult({ ok: true as const, department: dept });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_update_department",
    {
      description: "Admin-only: rename a department or change its color.",
      inputSchema: updateDepartmentInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const patch: { name?: string; colorToken?: string | null } = {};
        if (args.name !== undefined) patch.name = args.name;
        if (args.colorToken !== undefined) patch.colorToken = args.colorToken;
        await client.updateDepartment(args.departmentId, patch);
        return jsonResult({ ok: true as const, departmentId: args.departmentId });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_delete_department",
    {
      description:
        "Admin-only: delete a department. Refused while teams still belong to it — move or delete those teams first.",
      inputSchema: deleteDepartmentInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        await client.deleteDepartment(args.departmentId);
        return jsonResult({ ok: true as const });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_grant_team_project",
    {
      description:
        "Admin-only: grant a team a role on a project (idempotent — upserts on (teamId, projectId)). The project must be in the team's org.",
      inputSchema: grantTeamProjectInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        await client.grantTeamProject(args.teamId, args.projectId, args.role);
        return jsonResult({ ok: true as const });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_revoke_team_project",
    {
      description:
        "Admin-only: revoke a team's project grant. Returns 404 if the grant doesn't exist.",
      inputSchema: revokeTeamProjectInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        await client.revokeTeamProject(args.teamId, args.projectId);
        return jsonResult({ ok: true as const });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_install_skill",
    {
      description:
        "Install skills from Archon into the caller's local repo. Caller must pass `repoPath` (absolute path to their project repo root); the MCP server runs as a long-lived global process and does not know the caller's cwd. IMPORTANT — interactive editor pick: if `providers` is OMITTED on the call, the tool short-circuits and returns `{ ok: false, needsUserInput: true, field: \"providers\", question, options[] }`. When the agent receives that response it MUST present the options to the user in chat (claude / cursor / windsurf / copilot / antigravity / opencode), let them pick one or more, and then re-invoke with `providers: [...]`. The default if the user has no preference is `[\"claude\"]`. Only when `providers` is set does the tool actually install. Default scan path (no scan args, active-org-scoped): Project \"Skills\" → Note \"SKILLS.md\" and install every direct child. If that canonical path is missing or empty, the tool returns a guided error telling the user how to populate it (no migration, no fallback). Pass `skillName` to filter to one child by title. Pass `noteId` to install a single specific note (overrides the resolve path). Each install writes the SKILL.md content into each selected provider's dot-directory (`.claude/skills/<name>/SKILL.md`, `.cursor/rules/<name>.mdc`, `.windsurf/rules/<name>.md`, `.github/instructions/<name>.instructions.md`, `.agents/skills/<name>/SKILL.md`, `.opencode/agents/<name>.md`). No canonical `<repo>/skills/` source and no repo-root `AGENTS.md` are written. Returns per-skill write reports; children that do not contain a valid SKILL.md block are reported under `failed` without aborting the run.",
      inputSchema: installSkillInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const repoPath = path.resolve(args.repoPath);
        const home = path.resolve(os.homedir());
        const fsRoot = path.parse(repoPath).root;
        if (repoPath === home || repoPath === fsRoot) {
          throw new Error(
            `archon_install_skill: refusing to install into ${repoPath}. Pass repoPath as your project repo root, not your home directory or filesystem root.`,
          );
        }

        // Elicit-in-chat: when the caller did not specify `providers`, return a
        // structured "needs user input" response so the LLM asks the user which
        // editor(s) to install for. The LLM then re-invokes this tool with the
        // chosen providers. Default-on-no-preference is ["claude"].
        if (args.providers === undefined) {
          return jsonResult({
            ok: false as const,
            needsUserInput: true as const,
            field: "providers",
            question:
              "Which editor(s) should this skill be installed for? Pick one or more.",
            options: [
              {
                value: "claude",
                label: "Claude Code",
                path: ".claude/skills/<name>/SKILL.md",
                default: true,
              },
              {
                value: "cursor",
                label: "Cursor",
                path: ".cursor/rules/<name>.mdc",
              },
              {
                value: "windsurf",
                label: "Windsurf",
                path: ".windsurf/rules/<name>.md",
              },
              {
                value: "copilot",
                label: "GitHub Copilot",
                path: ".github/instructions/<name>.instructions.md",
              },
              {
                value: "antigravity",
                label: "Google Antigravity",
                path: ".agents/skills/<name>/SKILL.md",
              },
              {
                value: "opencode",
                label: "OpenCode",
                path: ".opencode/agents/<name>.md",
              },
            ],
            instruction:
              "Present the above options to the user in chat. Ask which editor(s) they want this skill installed for. After they answer, re-invoke `archon_install_skill` with `providers` set to an array of the chosen `value`s (e.g. [\"claude\"], [\"claude\",\"cursor\"]). If the user has no preference or asks for the default, pass [\"claude\"].",
          });
        }

        // Branch 1: explicit noteId — install that one note, bypass scan.
        if (args.noteId && args.noteId.length > 0) {
          await ensureNoteScope(client, args.noteId);
          const note = await client.getNote(args.noteId);
          if (typeof note.content !== "string" || note.content.length === 0) {
            throw new Error(
              `archon_install_skill: note ${args.noteId} has empty content`,
            );
          }
          const report = installSkill({
            noteContent: note.content,
            repoPath,
            providers: args.providers,
          });
          return jsonResult({
            ok: true as const,
            mode: "single" as const,
            installed: [report],
            warnings: [] as string[],
          });
        }

        // Branch 2/3: resolve Project → Note in the active org, install
        // children of the resolved parent note. When the caller passes no
        // path overrides (pure defaults), resolution failures are rewritten
        // as a single guided error telling them how to populate the
        // canonical source. When overrides are passed, step-specific
        // diagnostics are preserved.
        const projectName = args.projectName ?? "Skills";
        const noteName = args.noteName ?? "SKILLS.md";

        const isAllDefaults =
          args.projectName === undefined && args.noteName === undefined;

        const canonicalPath = `${projectName} / ${noteName}`;
        const guidedError = (reason: string) =>
          new Error(
            `archon_install_skill: no skills found at '${canonicalPath}'.\n\n${reason}\n\nTo populate the canonical source:\n  1. In Archon, navigate to (or create) project '${projectName}' in your active org.\n  2. Create a root note titled '${noteName}' (markdown).\n  3. Under that note, create one child per skill (markdown). Each child's content is a full SKILL.md — YAML frontmatter (name, description) plus the body the agent will follow.\n  4. Re-run archon_install_skill.\n\nIf your skills live elsewhere, pass projectName / noteName overrides, or pass noteId directly.`,
          );

        const projects = await client.listProjects();
        const projMatches = projects.filter(
          (p) => norm(p.name) === norm(projectName),
        );
        if (projMatches.length === 0) {
          if (isAllDefaults) {
            throw guidedError(`Project '${projectName}' does not exist in the active org.`);
          }
          throw new Error(
            `archon_install_skill: Project "${projectName}" not found in the active org. Available: ${projects.map((p) => p.name).filter(Boolean).join(", ") || "(none)"}`,
          );
        }
        if (projMatches.length > 1) {
          throw new Error(
            `archon_install_skill: Project "${projectName}" is ambiguous (${projMatches.length} matches) in the active org.`,
          );
        }
        const projectId = projMatches[0]!.id;

        const flat = await client.getNotesFlat(projectId);
        const parentMatches = flat.filter(
          (n) =>
            norm(n.title) === norm(noteName) && n.parent_id === null,
        );
        if (parentMatches.length === 0) {
          if (isAllDefaults) {
            throw guidedError(`Top-level note '${noteName}' does not exist in Project '${projectName}'.`);
          }
          throw new Error(
            `archon_install_skill: top-level Note "${noteName}" not found in Project "${projectName}".`,
          );
        }
        if (parentMatches.length > 1) {
          throw new Error(
            `archon_install_skill: top-level Note "${noteName}" is ambiguous (${parentMatches.length} matches) in Project "${projectName}".`,
          );
        }
        const parentNoteId = parentMatches[0]!.id;

        const children = flat
          .filter((n) => n.parent_id === parentNoteId)
          .sort((a, b) => a.sibling_index - b.sibling_index);
        if (children.length === 0) {
          if (isAllDefaults) {
            throw guidedError(`Note '${noteName}' exists but has no children — no skills to install.`);
          }
          throw new Error(
            `archon_install_skill: Note "${noteName}" has no children.`,
          );
        }

        // Optionally filter to a single child by title (skillName match against the note title).
        const selected =
          args.skillName && args.skillName.length > 0
            ? children.filter(
                (c) => norm(c.title) === norm(args.skillName!),
              )
            : children;
        if (args.skillName && selected.length === 0) {
          throw new Error(
            `archon_install_skill: no child titled "${args.skillName}" under Note "${noteName}".`,
          );
        }

        // Install each child. Skills without a valid SKILL.md block are reported
        // under `failed` but do not abort the run.
        type FailedEntry = { noteId: string; title: string; error: string };
        const installed: Array<ReturnType<typeof installSkill>> = [];
        const failed: FailedEntry[] = [];
        for (const child of selected) {
          try {
            const note = await client.getNote(child.id);
            if (typeof note.content !== "string" || note.content.length === 0) {
              failed.push({
                noteId: child.id,
                title: child.title,
                error: "empty content",
              });
              continue;
            }
            const report = installSkill({
              noteContent: note.content,
              repoPath,
              providers: args.providers,
            });
            installed.push(report);
          } catch (err) {
            failed.push({
              noteId: child.id,
              title: child.title,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return jsonResult({
          ok: true as const,
          mode: (args.skillName ? "filtered" : "scan") as
            | "filtered"
            | "scan",
          resolved: {
            projectName,
            projectId,
            noteName,
            parentNoteId,
            childCount: children.length,
          },
          installed,
          failed,
        });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_create_project",
    {
      description:
        "Create a new project in the active org. Optionally grant a team initial access via teamId + teamRole. Returns the project row.",
      inputSchema: createProjectInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const opts: { teamId?: string; teamRole?: "owner" | "contributor" | "viewer" } = {};
        if (args.teamId !== undefined) opts.teamId = args.teamId;
        if (args.teamRole !== undefined) opts.teamRole = args.teamRole;
        const project = await client.createProject(args.name, opts);
        return jsonResult({ ok: true as const, project });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_update_project",
    {
      description:
        "Update a project (rename, reorder, change color). Project ↔ team membership is changed via archon_grant_team_project / archon_revoke_team_project. Returns the updated project.",
      inputSchema: updateProjectInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const patch: { name?: string; sortIndex?: number; colorToken?: string | null } = {};
        if (args.name !== undefined) patch.name = args.name;
        if (args.sortIndex !== undefined) patch.sortIndex = args.sortIndex;
        if (args.colorToken !== undefined) patch.colorToken = args.colorToken;
        const project = await client.updateProject(args.projectId, patch);
        return jsonResult({ ok: true as const, project });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_delete_project",
    {
      description:
        "Delete a project and all its notes. This is irreversible.",
      inputSchema: deleteProjectInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        await client.deleteProject(args.projectId);
        return jsonResult({ ok: true as const });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_delete_notes",
    {
      description:
        "Bulk delete notes by id. Descendants of each note are also removed. This is irreversible. " +
        "Active org auto-switches to the home of the first id before the call (response includes scopeSwitched when changed).",
      inputSchema: deleteNotesInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const switched = await ensureNoteScope(client, args.ids[0]);
        await client.deleteNotes(args.ids);
        return jsonResult(withScopeSwitched({ ok: true as const, deletedIds: args.ids }, switched));
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_move_note",
    {
      description:
        "Move a note within its project tree. Placement: 'before' (sibling above target), 'after' (sibling below target), 'into' (first child of target). " +
        "Active org auto-switches to the dragged note's home before the call (response includes scopeSwitched when changed).",
      inputSchema: moveNoteInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const switched = await ensureNoteScope(client, args.draggedId);
        await client.moveNote(args.draggedId, args.targetId, args.placement);
        return jsonResult(withScopeSwitched({ ok: true as const }, switched));
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_duplicate_subtree",
    {
      description:
        "Duplicate a note and all its descendants within the same project. Returns the new root note id. " +
        "Active org auto-switches to the source note's home before the call (response includes scopeSwitched when changed).",
      inputSchema: duplicateSubtreeInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const switched = await ensureNoteScope(client, args.noteId);
        const result = await client.duplicateSubtree(args.projectId, args.noteId);
        return jsonResult(withScopeSwitched(
          { ok: true as const, ...((result && typeof result === "object") ? result : {}) },
          switched,
        ));
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_copy_id",
    {
      description:
        "Resolve a name (or passthrough UUID) to a copy-friendly id for org / department / team / project / note. " +
        "Returns { status: 'unique' | 'ambiguous' | 'none', matches: [{ id, name, path }] }. " +
        "UUID queries short-circuit to a single match. Use projectQuery to narrow notes, departmentQuery to narrow teams, orgQuery to point at a different org. " +
        "Cross-org lookups operate within the active org by default; pass orgQuery to search a different org.",
      inputSchema: copyIdInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const q = args.query.trim();

        // org
        if (args.kind === "org") {
          const r = await client.listMyOrgs();
          if (isLikelyUuid(q)) {
            const hit = r.orgs.find((o) => o.orgId === q);
            return jsonResult(
              hit
                ? {
                    status: "unique" as const,
                    matches: [{ id: hit.orgId, name: hit.name, path: hit.name }],
                  }
                : { status: "none" as const, matches: [] },
            );
          }
          const nq = norm(q);
          const hits = r.orgs.filter(
            (o) => norm(o.name) === nq || norm(o.slug) === nq,
          );
          if (hits.length === 0) {
            return jsonResult({ status: "none" as const, matches: [] });
          }
          const matches = hits.map((o) => ({
            id: o.orgId,
            name: o.name,
            path: o.name,
          }));
          return jsonResult({
            status: (hits.length === 1 ? "unique" : "ambiguous") as
              | "unique"
              | "ambiguous",
            matches,
          });
        }

        // Resolve effective org for org-scoped lookups (department / team / project)
        const orgIdForLookup = await (async () => {
          const oq = args.orgQuery?.trim() ?? "";
          if (!oq) {
            return runtime.holder.activeOrgId ?? (await client.listMyOrgs()).activeOrgId ?? null;
          }
          if (isLikelyUuid(oq)) return oq;
          const orgs = (await client.listMyOrgs()).orgs;
          const noq = norm(oq);
          const orgHits = orgs.filter(
            (o) => norm(o.name) === noq || norm(o.slug) === noq,
          );
          return orgHits[0]?.orgId ?? null;
        })();

        if (args.kind === "department") {
          if (!orgIdForLookup) {
            return jsonResult({ status: "none" as const, matches: [] });
          }
          const departments = await client.listDepartmentsForOrg(orgIdForLookup);
          if (isLikelyUuid(q)) {
            const hit = departments.find((d) => d.departmentId === q);
            return jsonResult(
              hit
                ? {
                    status: "unique" as const,
                    matches: [{ id: hit.departmentId, name: hit.name, path: hit.name }],
                  }
                : { status: "none" as const, matches: [] },
            );
          }
          const nq = norm(q);
          const hits = departments.filter((d) => norm(d.name) === nq);
          if (hits.length === 0) {
            return jsonResult({ status: "none" as const, matches: [] });
          }
          const matches = hits.map((d) => ({
            id: d.departmentId,
            name: d.name,
            path: d.name,
          }));
          return jsonResult({
            status: (hits.length === 1 ? "unique" : "ambiguous") as
              | "unique"
              | "ambiguous",
            matches,
          });
        }

        if (args.kind === "team") {
          if (!orgIdForLookup) {
            return jsonResult({ status: "none" as const, matches: [] });
          }
          let rows = await client.listTeamsForOrg(orgIdForLookup);
          // Optional: narrow by department
          const dq = args.departmentQuery?.trim() ?? "";
          if (dq.length > 0) {
            if (isLikelyUuid(dq)) {
              rows = rows.filter((t) => t.departmentId === dq);
            } else {
              const departments = await client.listDepartmentsForOrg(orgIdForLookup);
              const ndq = norm(dq);
              const deptIds = new Set(
                departments.filter((d) => norm(d.name) === ndq).map((d) => d.departmentId),
              );
              rows = rows.filter((t) => deptIds.has(t.departmentId));
            }
          }
          if (isLikelyUuid(q)) {
            const hit = rows.find((t) => t.teamId === q);
            return jsonResult(
              hit
                ? {
                    status: "unique" as const,
                    matches: [{ id: hit.teamId, name: hit.name, path: hit.name }],
                  }
                : { status: "none" as const, matches: [] },
            );
          }
          const nq = norm(q);
          const hits = rows.filter((t) => norm(t.name) === nq);
          if (hits.length === 0) {
            return jsonResult({ status: "none" as const, matches: [] });
          }
          const matches = hits.map((t) => ({
            id: t.teamId,
            name: t.name,
            path: t.name,
          }));
          return jsonResult({
            status: (hits.length === 1 ? "unique" : "ambiguous") as
              | "unique"
              | "ambiguous",
            matches,
          });
        }

        if (args.kind === "project") {
          const result = await findProjectsByQuery(client, q);
          if (result.status === "unique" || result.status === "ambiguous") {
            return jsonResult({
              status: result.status,
              matches: result.matches.map((m) => ({
                id: m.projectId,
                name: m.projectName,
                path: m.path,
              })),
            });
          }
          return jsonResult({
            status: "none" as const,
            matches: [],
            message: "message" in result ? result.message : undefined,
          });
        }

        // note
        const rows = await client.getNotesWithContext();
        const result = findNotesByQuery(rows, q, args.projectQuery);
        if (result.status === "unique" || result.status === "ambiguous") {
          return jsonResult({
            status: result.status,
            matches: result.matches.map((m) => ({
              id: m.noteId,
              name: m.title,
              path: m.path,
            })),
          });
        }
        return jsonResult({
          status: "none" as const,
          matches: [],
          message: "message" in result ? result.message : undefined,
        });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_move_note_to_project",
    {
      description:
        "Move a note (with its entire subtree) to a different project, optionally nested under a parent note in the target project. " +
        "Caller needs write access on both the source and destination projects (via team grants or per-creator role). " +
        "Cross-org moves are not supported — use archon_export_org / archon_import_org instead. " +
        "Active org auto-switches to the source note's home before the call (response includes scopeSwitched when changed).",
      inputSchema: moveNoteToProjectInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const switched = await ensureNoteScope(client, args.noteId);
        await client.moveNoteToProject(
          args.noteId,
          args.targetProjectId,
          args.targetParentId ?? null,
        );
        return jsonResult(withScopeSwitched({ ok: true as const }, switched));
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_duplicate_project",
    {
      description:
        "Deep-copy a project (every note in the tree gets a fresh id) within the active org. Optionally grant the duplicate to a team via teamId. " +
        "Cross-org duplicates are not supported — use archon_export_org / archon_import_org for that case.",
      inputSchema: duplicateProjectInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const opts: { teamId?: string; newName?: string } = {};
        if (args.teamId !== undefined) opts.teamId = args.teamId;
        if (args.newName !== undefined) opts.newName = args.newName;
        const result = await client.duplicateProject(args.projectId, opts);
        return jsonResult({ ok: true as const, ...result });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_backlinks",
    {
      description:
        "Find all notes that reference a given note id in their content (backlinks / incoming references). Returns source note ids, titles, and project ids. " +
        "Active org auto-switches to the target note's home before the call (response includes scopeSwitched when changed).",
      inputSchema: backlinksInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const switched = await ensureNoteScope(client, args.noteId);
        const sources = await client.getBacklinks(args.noteId);
        return jsonResult(withScopeSwitched({ noteId: args.noteId, sources }, switched));
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_export_org",
    {
      description:
        "Export readable projects in the active org as a ZIP archive (base64-encoded). Optionally filter by project ids. Returns base64 string of the ZIP.",
      inputSchema: exportOrgInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const buf = await client.exportProjects(args.projectIds);
        const b64 = Buffer.from(buf).toString("base64");
        return jsonResult({ ok: true as const, zipBase64Length: b64.length, zipBase64: b64 });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_import_org",
    {
      description:
        "Import projects from a base64-encoded ZIP archive (from a previous archon_export_org). The target team grants 'owner' on every imported project and pins the projects' org to the team's org.",
      inputSchema: importOrgInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const buf = Buffer.from(args.zipBase64, "base64");
        const result = await client.importProjects(
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          args.teamId,
        );
        return jsonResult({ ok: true as const, result });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.tool(
    "archon_resolve_note",
    "Resolve a note to its canonical UUID using project name and note title. " +
      "Matching is trim + case-insensitive within the active org. Returns an error if zero or multiple notes match.",
    resolveInput.shape,
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) {
        return denied;
      }
      try {
        const rows = await client.getNotesWithContext();
        const r = resolveNoteFromCatalog(rows, {
          projectName: args.projectName,
          noteTitle: args.noteTitle,
        });
        if (!r.ok) {
          return errorResult(
            JSON.stringify(
              {
                error:
                  r.reason === "none"
                    ? "No note matched project/title."
                    : "Multiple notes matched; disambiguate titles or use noteId from candidates.",
                reason: r.reason,
                candidates: r.candidates,
              },
              null,
              2,
            ),
          );
        }
        return jsonResult({
          noteId: r.noteId,
          projectId: r.projectId,
          projectName: r.projectName,
          title: r.title,
          type: r.type,
        });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.tool(
    "archon_get_note",
    "Fetch a single note by id (includes content and metadata). Active org auto-switches to the note's home before the read (response includes scopeSwitched when changed).",
    getNoteInput.shape,
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) {
        return denied;
      }
      try {
        const switched = await ensureNoteScope(client, args.noteId);
        const note = await client.getNote(args.noteId);
        return jsonResult(withScopeSwitched({ note } as Record<string, unknown>, switched));
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.tool(
    "archon_get_image_note",
    `Fetch an image-type note's bytes in an MCP-friendly form. Modes: 'auto' (native image block, falls back to signed URL over ${GET_IMAGE_NOTE_DEFAULT_MAX_BYTES} bytes), 'inline' (force native image block), 'base64' (JSON with dataBase64), 'url' (no bytes, just a short-lived signed URL), 'thumbnail' (PLAN-04 WebP thumb). Always returns metadata { noteId, title, path, mimeType, sizeBytes, width, height }. Byte-returning modes strip EXIF / text metadata for JPEG / PNG / WebP (url mode streams raw R2 bytes). Errors on non-image notes; callers should use archon_get_note for markdown. Active org auto-switches to the note's home before the read.`,
    getImageNoteInput.shape,
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) {
        return denied;
      }
      try {
        await ensureNoteScope(client, args.noteId);
        return await handleGetImageNote(args, {
          getNote: (id) => client.getNote(id),
          resolvePath: (note) => resolveNotePathForImage(client, note),
          signAssetKey: (key) => client.signAssetKey(key),
          fetchBytes: fetchSignedImageBytes,
        });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_get_note_with_links",
    {
      description:
        "Fetch a note plus the full transitive set of notes it links to (forward refs in markdown content), deduped by noteId, with optional one-hop backlinks. " +
        "Walks both `[label](#/n/<id>)` and `[label](#/w/<vfsPath>)` references breadth-first. VFS paths support canonical (`Project/Title`), same-project-relative (`./Title`), and tree-relative (`../sibling`) forms. " +
        "Skips already-visited ids (cycle-safe). Stops fetching when the hard cap is reached and reports stats.truncated=true. Id-fetch errors land in `unresolved`; unresolvable VFS paths land in `unresolvedVfsLinks`.",
      inputSchema: getNoteWithLinksInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      const cap = args.maxNotes ?? 200;
      const includeBacklinks = args.includeBacklinks ?? true;
      try {
        const switched = await ensureNoteScope(client, args.noteId);
        const catalog = await client.getNotesWithContext();
        const catalogById = new Map<string, WpnNoteWithContextRow>();
        const catalogByCanonical = new Map<string, string>();
        for (const r of catalog) {
          catalogById.set(r.id, r);
          catalogByCanonical.set(canonicalVfsPathFromRow(r), r.id);
        }
        const projectTreeCache = new Map<string, WpnNoteListItem[]>();
        const getProjectTree = async (projectId: string): Promise<WpnNoteListItem[]> => {
          const hit = projectTreeCache.get(projectId);
          if (hit) return hit;
          const tree = await client.getNotesFlat(projectId);
          projectTreeCache.set(projectId, tree);
          return tree;
        };

        const seed = await client.getNote(args.noteId);
        const visited = new Set<string>([seed.id]);
        const linkedNotes: Record<string, WpnNoteDetail> = {};
        const unresolved: { id: string; error: string }[] = [];
        const unresolvedVfsLinks: {
          vfsPath: string;
          baseNoteId: string;
          reason: string;
        }[] = [];
        const queue: string[] = [];
        let truncated = false;

        const enqueueLinksFrom = async (n: WpnNoteDetail) => {
          const { noteIds, vfsHrefPaths } = extractReferencedLinksFromMarkdown(
            n.content ?? "",
          );
          for (const id of noteIds) {
            if (!visited.has(id)) queue.push(id);
          }
          if (vfsHrefPaths.length === 0) return;
          const baseRow = catalogById.get(n.id);
          if (!baseRow) {
            for (const p of vfsHrefPaths) {
              unresolvedVfsLinks.push({
                vfsPath: p,
                baseNoteId: n.id,
                reason: "base note missing from catalog",
              });
            }
            return;
          }
          for (const p of vfsHrefPaths) {
            const res = await resolveVfsHrefToNoteId(p, baseRow, {
              catalogByCanonical,
              getProjectTree,
            });
            if (res.ok) {
              if (!visited.has(res.noteId)) queue.push(res.noteId);
            } else {
              unresolvedVfsLinks.push({
                vfsPath: p,
                baseNoteId: n.id,
                reason: res.reason,
              });
            }
          }
        };

        await enqueueLinksFrom(seed);

        while (queue.length > 0) {
          if (visited.size >= cap) {
            truncated = true;
            break;
          }
          const id = queue.shift()!;
          if (visited.has(id)) continue;
          visited.add(id);
          try {
            const detail = await client.getNote(id);
            linkedNotes[id] = detail;
            await enqueueLinksFrom(detail);
          } catch (e) {
            unresolved.push({
              id,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        const backlinks = includeBacklinks
          ? await client.getBacklinks(args.noteId).catch(() => [])
          : [];

        return jsonResult(withScopeSwitched(
          {
            note: seed,
            linkedNotes,
            backlinks,
            unresolved,
            unresolvedVfsLinks,
            stats: {
              fetched: 1 + Object.keys(linkedNotes).length,
              unresolvedCount: unresolved.length,
              unresolvedVfsCount: unresolvedVfsLinks.length,
              truncated,
              cap,
            },
          } as Record<string, unknown>,
          switched,
        ));
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_get_note_title",
    {
      description:
        "Return the current title for a note id without fetching full content. Use with archon_note_rename to prepend e.g. DONE or fix typos. " +
        "Active org auto-switches to the note's home before the read.",
      inputSchema: getNoteTitleInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) {
        return denied;
      }
      try {
        const switched = await ensureNoteScope(client, args.noteId);
        const note = await client.getNote(args.noteId);
        return jsonResult(withScopeSwitched(
          { noteId: note.id, title: note.title } as Record<string, unknown>,
          switched,
        ));
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_note_rename",
    {
      description:
        "Rename a note by id (PATCH title only). Fails with a clear error if another sibling under the same parent already uses that title. " +
        "Active org auto-switches to the note's home before the call.",
      inputSchema: noteRenameInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) {
        return denied;
      }
      try {
        const switched = await ensureNoteScope(client, args.noteId);
        const note = await client.patchNote(args.noteId, { title: args.title });
        return jsonResult(withScopeSwitched({ ok: true as const, note }, switched));
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_execute_note",
    {
      description:
        "Resolve a task note by title or UUID (optional projectQuery), then fetch it when the match is unique. " +
        "If multiple notes share the title, returns status ambiguous with each candidate's full path and noteId — have the user pick one, then call again with noteQuery set to that UUID (or narrow filters). " +
        "On success, the agent should read note.content and follow those instructions in the session. " +
        "When noteQuery is a UUID, the active org is auto-switched to the note's home before searching (response includes scopeSwitched).",
      inputSchema: executeNoteInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) {
        return denied;
      }
      try {
        const switched = await ensureNoteScope(client, args.noteQuery);
        const rows = await client.getNotesWithContext();
        const resolved = findNotesByQuery(
          rows,
          args.noteQuery,
          args.projectQuery,
        );
        if (resolved.status !== "unique") {
          return jsonResult(withScopeSwitched(
            {
              stage: "needs_resolution" as const,
              ...resolved,
              nextStep:
                "If ambiguous, show the user each path and noteId from matches; after they choose, call archon_execute_note again with noteQuery equal to the chosen noteId (or narrow projectQuery).",
            } as Record<string, unknown>,
            switched,
          ));
        }
        const note = await client.getNote(resolved.matches[0]!.noteId);
        return jsonResult(withScopeSwitched(
          {
            stage: "fetched" as const,
            match: resolved.matches[0],
            note,
          } as Record<string, unknown>,
          switched,
        ));
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_create_child_note",
    {
      description:
        "Create a new note as direct child of a parent resolved by parentNoteId, OR projectName+parentPathTitles (root-to-parent title chain), OR parentWpnPath (\"Project / Title / …\"). " +
        "Returns project ambiguity like archon_find_projects or path ambiguity with candidate noteIds. Uses GET /wpn/projects/:id/notes for tree walk (same norm as archon_resolve_note).",
      inputSchema: createChildNoteInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) {
        return denied;
      }
      const parentCheck = validateCreateChildNoteParent(args);
      if (!parentCheck.ok) {
        return errorResult(parentCheck.error);
      }
      try {
        const idTrim = args.parentNoteId?.trim() ?? "";
        if (idTrim.length > 0) {
          const switched = await ensureNoteScope(client, idTrim);
          const parent = await client.getNote(idTrim);
          const noteType = (args.type ?? "markdown").trim() || "markdown";
          const created = await client.createNote(parent.project_id, {
            type: noteType,
            relation: "child",
            anchorId: parent.id,
            title: args.title,
            content: args.content,
            metadata: args.metadata,
          });
          return jsonResult(withScopeSwitched(
            {
              ok: true as const,
              parentNoteId: parent.id,
              projectId: parent.project_id,
              createdNoteId: created.id,
            },
            switched,
          ));
        }

        let projectName: string;
        let parentPathTitles: string[];

        const wpnTrim = args.parentWpnPath?.trim() ?? "";
        if (wpnTrim.length > 0) {
          const parsed = parseParentWpnPath(wpnTrim);
          if (!parsed.ok) {
            return errorResult(parsed.error);
          }
          projectName = parsed.projectName;
          parentPathTitles = parsed.parentPathTitles;
        } else {
          projectName = args.projectName!.trim();
          parentPathTitles = args.parentPathTitles!;
        }

        const proj = await findProjectsByQuery(client, projectName);
        if (proj.status !== "unique") {
          return jsonResult({ ok: false as const, stage: "project_resolution" as const, ...proj });
        }
        const projectId = proj.matches[0]!.projectId;
        const flat = await client.getNotesFlat(projectId);
        const resolved = resolveParentInTree(flat, parentPathTitles);
        if (!resolved.ok) {
          return jsonResult({ stage: "parent_path" as const, ...resolved });
        }
        const noteType = (args.type ?? "markdown").trim() || "markdown";
        const created = await client.createNote(resolved.projectId, {
          type: noteType,
          relation: "child",
          anchorId: resolved.parentId,
          title: args.title,
          content: args.content,
          metadata: args.metadata,
        });
        return jsonResult({
          ok: true as const,
          parentNoteId: resolved.parentId,
          projectId: resolved.projectId,
          createdNoteId: created.id,
        });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_write_back_child",
    {
      description:
        "After completing work scoped to a Archon task note, persist results as a new direct child of that note (GET task note for project, then POST create child). " +
        "Prefer this over archon_write_note create_child when you only know taskNoteId. " +
        "Active org auto-switches to the task note's home before the call.",
      inputSchema: writeBackChildInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) {
        return denied;
      }
      try {
        const switched = await ensureNoteScope(client, args.taskNoteId);
        const task = await client.getNote(args.taskNoteId);
        const noteType = (args.type ?? "markdown").trim() || "markdown";
        const created = await client.createNote(task.project_id, {
          type: noteType,
          relation: "child",
          anchorId: args.taskNoteId,
          title: args.title,
          content: args.content,
          metadata: args.metadata,
        });
        return jsonResult(withScopeSwitched(
          {
            ok: true as const,
            taskNoteId: args.taskNoteId,
            projectId: task.project_id,
            createdNoteId: created.id,
          },
          switched,
        ));
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_write_note",
    {
      description:
        "Create or patch a note. Modes: patch_existing (PATCH), create_root | create_child | create_sibling (POST with relation). " +
        "For patch_existing, active org auto-switches to the note's home before the patch.",
      inputSchema: writeNoteInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) {
        return denied;
      }
      const validation = validateWriteNoteArgs(args);
      if (!validation.ok) {
        return errorResult(validation.error);
      }
      try {
        if (args.mode === "patch_existing") {
          const switched = await ensureNoteScope(client, args.noteId);
          const patch: {
            title?: string;
            content?: string;
            type?: string;
            metadata?: Record<string, unknown> | null;
          } = {};
          if (args.title !== undefined) {
            patch.title = args.title;
          }
          if (args.content !== undefined) {
            patch.content = args.content;
          }
          if (args.type !== undefined) {
            patch.type = args.type;
          }
          if (args.metadata !== undefined) {
            patch.metadata = args.metadata;
          }
          // Push content through the live Yjs doc first so an open editor's
          // next autosave can't silently revert this write. The sync-api
          // PATCH path also has a defensive in-process bridge
          // (`applyContentToYjsDoc`), but that only fires when the editor
          // and the REST hit the same process — going through a real WS
          // client survives multi-instance deployments. Cloud sessions
          // only; the local Electron file-vault has no Yjs at all.
          if (
            patch.content !== undefined &&
            runtime.mode !== "local"
          ) {
            const wsToken = await client
              .mintRealtimeWsToken()
              .catch(() => null);
            if (wsToken) {
              try {
                await writeNoteContentViaYjs({
                  wsUrl: deriveYjsWsUrl(client.getBaseUrl()),
                  wsToken,
                  noteId: args.noteId!,
                  content: patch.content,
                });
              } catch (err) {
                // Don't fail the whole tool — fall through to REST PATCH
                // and let the in-process bridge cover us.
                // eslint-disable-next-line no-console
                console.warn(
                  "[archon_write_note] Yjs WS write failed, falling back to REST:",
                  (err as Error).message,
                );
              }
            }
          }
          const note = await client.patchNote(args.noteId!, patch);
          return jsonResult(withScopeSwitched({ ok: true as const, note }, switched));
        }
        const relation =
          args.mode === "create_root"
            ? ("root" as const)
            : args.mode === "create_child"
              ? ("child" as const)
              : ("sibling" as const);
        const anchorId = args.mode === "create_root" ? undefined : args.anchorId;
        // For create_child / create_sibling with an anchorId, switch to the anchor's home
        // so the create lands in the right scope.
        const switched =
          args.mode !== "create_root" && anchorId
            ? await ensureNoteScope(client, anchorId)
            : null;
        const body = {
          type: args.type!,
          relation,
          anchorId,
          title: args.title,
          content: args.content,
          metadata: args.metadata ?? undefined,
        };
        const created = await client.createNote(args.projectId!, body);
        return jsonResult(withScopeSwitched({ ok: true as const, created }, switched));
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_login",
    {
      description:
        "Cloud session only: sign in with email and password against ARCHON_SYNC_API_BASE. Tokens are stored in-memory and optionally on disk (see README). Passwords may appear in host logs.",
      inputSchema: archonLoginInput,
    },
    async (args) => {
      if (!runtime.cloudSession) {
        return errorResult("archon_login is only available when ARCHON_MCP_CLOUD_SESSION=1.");
      }
      const r = await postJsonUnauthed(runtime.baseUrl, "/auth/login", {
        email: args.email,
        password: args.password,
        client: "mcp",
      });
      if (!r.ok) {
        const err = (r.json as { error?: string })?.error ?? `login failed (${r.status})`;
        return errorResult(typeof err === "string" ? err : JSON.stringify(err));
      }
      const j = r.json as { token?: string; refreshToken?: string; userId?: string };
      if (typeof j.token !== "string" || !j.token.trim()) {
        return errorResult("Login response missing token.");
      }
      const rt =
        typeof j.refreshToken === "string" && j.refreshToken.trim()
          ? j.refreshToken.trim()
          : null;
      runtime.holder.setTokens(j.token.trim(), rt);
      persistIfNeeded(runtime);
      return jsonResult({
        ok: true,
        userId: typeof j.userId === "string" ? j.userId : undefined,
        message: "Session established. WPN tools are available.",
      });
    },
  );

  mcp.registerTool(
    "archon_login_browser_start",
    {
      description:
        "Start browser-based MCP login. Returns verification_uri (open in browser), device_code (secret — pass only to archon_login_browser_poll), user_code, expires_in. Requires ARCHON_MCP_CLOUD_SESSION=1.",
      inputSchema: z.object({}),
    },
    async () => {
      if (!runtime.cloudSession) {
        return errorResult(
          "archon_login_browser_start requires ARCHON_MCP_CLOUD_SESSION=1 and ARCHON_SYNC_API_BASE.",
        );
      }
      const r = await postJsonUnauthed(runtime.baseUrl, "/auth/mcp/device/start", {});
      if (!r.ok) {
        const err = (r.json as { error?: string })?.error ?? `start failed (${r.status})`;
        return errorResult(typeof err === "string" ? err : JSON.stringify(err));
      }
      const j = r.json as {
        device_code?: string;
        verification_uri?: string;
        user_code?: string;
        expires_in?: number;
        interval?: number;
      };
      if (typeof j.device_code !== "string" || typeof j.verification_uri !== "string") {
        return errorResult("Invalid device/start response.");
      }
      return jsonResult({
        nextStep:
          "Open verification_uri in a browser, sign in, authorize MCP access, then call archon_login_browser_poll with device_code until status is authorized.",
        device_code: j.device_code,
        verification_uri: j.verification_uri,
        user_code: j.user_code,
        expires_in: j.expires_in,
        interval: j.interval ?? 2,
      });
    },
  );

  mcp.registerTool(
    "archon_login_browser_poll",
    {
      description:
        "Poll after browser login. Pass device_code from archon_login_browser_start. On status authorized, session is stored (and persisted when configured).",
      inputSchema: archonLoginBrowserPollInput,
    },
    async (args) => {
      if (!runtime.cloudSession) {
        return errorResult("archon_login_browser_poll requires ARCHON_MCP_CLOUD_SESSION=1.");
      }
      const r = await postJsonUnauthed(runtime.baseUrl, "/auth/mcp/device/token", {
        device_code: args.device_code,
      });
      if (!r.ok) {
        return errorResult(`token poll failed (${r.status})`);
      }
      const j = r.json as {
        status?: string;
        token?: string;
        refreshToken?: string;
        userId?: string;
      };
      if (j.status === "pending" || j.status === "invalid") {
        return jsonResult({
          status: j.status,
          message:
            j.status === "pending"
              ? "Still waiting for browser authorization."
              : "Invalid or expired device_code.",
        });
      }
      if (j.status === "expired") {
        return jsonResult({ status: "expired", message: "Login request expired; start again." });
      }
      if (j.status !== "authorized") {
        return jsonResult({ status: j.status ?? "unknown", raw: j });
      }
      if (typeof j.token !== "string" || !j.token.trim()) {
        return errorResult("Authorized response missing token.");
      }
      const rt =
        typeof j.refreshToken === "string" && j.refreshToken.trim()
          ? j.refreshToken.trim()
          : null;
      runtime.holder.setTokens(j.token.trim(), rt);
      persistIfNeeded(runtime);
      return jsonResult({
        ok: true,
        status: "authorized",
        userId: typeof j.userId === "string" ? j.userId : undefined,
        message: "Session established. WPN tools are available.",
      });
    },
  );

  mcp.registerTool(
    "archon_logout",
    {
      description: "Clear MCP cloud session (memory and persisted file when applicable).",
      inputSchema: z.object({}),
    },
    async () => {
      runtime.holder.clear();
      client.invalidateNotesWithContextCache();
      if (runtime.persistPath) {
        clearPersistedMcpAuth(runtime.persistPath);
      }
      return jsonResult({ ok: true as const });
    },
  );

  mcp.registerTool(
    "archon_list_orgs",
    {
      description:
        "List organizations the authenticated user belongs to. Returns { orgs, activeOrgId, defaultOrgId, activeTeamId }. " +
        "Use archon_set_active_org to switch, or pass orgId on archon_list_org_tree for a one-shot read.",
      inputSchema: z.object({}),
    },
    async () => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const r = await client.listMyOrgs();
        return jsonResult({
          orgs: r.orgs,
          activeOrgId: runtime.holder.activeOrgId ?? r.activeOrgId ?? r.defaultOrgId ?? null,
          defaultOrgId: r.defaultOrgId,
          activeTeamId: runtime.holder.activeTeamId,
        });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_set_active_org",
    {
      description:
        "Switch the active organization for this MCP session. Re-issues the JWT (preserves refresh token), " +
        "resets the active team to the org's default (or last-used), invalidates the notes-with-context cache, " +
        "and persists the new tokens when persistence is configured.",
      inputSchema: setActiveOrgInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const result = await client.switchActiveOrg(args.orgId);
        persistIfNeeded(runtime);
        return jsonResult({
          ok: true as const,
          activeOrgId: result.activeOrgId,
          activeTeamId: result.activeTeamId,
        });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_auth_status",
    {
      description:
        "Diagnostics: mode, authenticated, sync API host, persist file presence, JWT claims (unverified_sub / exp), and org list when authenticated — never includes raw tokens.",
      inputSchema: z.object({}),
    },
    async () => {
      const persistPath = runtime.persistPath;
      const persist_file_present =
        persistPath && fs.existsSync(persistPath) ? true : false;
      let sync_base_host = "";
      try {
        sync_base_host = new URL(runtime.baseUrl).host;
      } catch {
        sync_base_host = "";
      }
      const access = runtime.holder.accessToken;
      const jwtInfo = access ? parseJwtUnverified(access) : {};
      let orgs: unknown = undefined;
      let active_org_id: string | null = runtime.holder.activeOrgId;
      const active_team_id: string | null = runtime.holder.activeTeamId;
      if (runtime.holder.hasAccess()) {
        try {
          const r = await client.listMyOrgs();
          orgs = r.orgs;
          if (!active_org_id) {
            active_org_id = r.activeOrgId ?? r.defaultOrgId ?? null;
            if (active_org_id) {
              runtime.holder.setActiveOrg(active_org_id);
            }
          }
        } catch {
          /* org listing is best-effort; older servers may not have /orgs/me */
        }
      }
      return jsonResult({
        mode: runtime.mode,
        cloud_session: runtime.cloudSession,
        authenticated: runtime.holder.hasAccess(),
        sync_base_host,
        persist_file_path: persistPath ?? null,
        persist_file_present,
        active_org_id,
        active_team_id,
        ...(orgs ? { orgs } : {}),
        ...jwtInfo,
      });
    },
  );

  return mcp;
}

export async function runMcpStdioServer(): Promise<void> {
  const runtime = loadMcpAuthRuntime();
  const client = new WpnHttpClient(runtime.baseUrl, runtime.holder, {
    onTokensUpdated: () => persistIfNeeded(runtime),
  });

  const mcp = createArchonMcpServer(runtime, client);
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

/**
 * Create a runtime + client pair for use by HTTP transports.
 * Each Streamable HTTP session needs its own McpServer, so callers
 * use `createArchonMcpServer(runtime, client)` per session.
 */
export function loadMcpRuntimeAndClient(): {
  runtime: McpAuthRuntime;
  client: WpnHttpClient;
} {
  const runtime = loadMcpAuthRuntime();
  const client = new WpnHttpClient(runtime.baseUrl, runtime.holder, {
    onTokensUpdated: () => persistIfNeeded(runtime),
  });
  return { runtime, client };
}
