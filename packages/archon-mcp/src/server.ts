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
  workspaceName: z.string().describe("Workspace name (trimmed, case-insensitive match)"),
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
  workspaceQuery: z
    .string()
    .optional()
    .describe("Optional workspace name or UUID to limit search (required if project name clashes across workspaces)."),
});

const findNotesInput = z.object({
  query: z.string().describe("Note title or note UUID"),
  workspaceQuery: z
    .string()
    .optional()
    .describe("Optional workspace name or UUID to narrow results"),
  projectQuery: z
    .string()
    .optional()
    .describe("Optional project name or UUID to narrow results"),
});

const executeNoteInput = z.object({
  noteQuery: z
    .string()
    .describe("Note title or canonical note UUID (same matching rules as archon_find_notes)."),
  workspaceQuery: z
    .string()
    .optional()
    .describe("Optional workspace name or UUID to narrow results before fetch."),
  projectQuery: z
    .string()
    .optional()
    .describe("Optional project name or UUID to narrow results before fetch."),
});

const listWpnInput = z.object({
  scope: z
    .enum(["workspaces", "projects", "notes", "full_tree"])
    .describe(
      "workspaces: list all workspaces. projects: list projects in a workspace (requires workspaceId). notes: flat note tree of a project (requires projectId). full_tree: all workspaces, projects, and notes in one payload.",
    ),
  workspaceId: z
    .string()
    .optional()
    .describe("Required when scope=projects. Workspace UUID."),
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
  spaceId: z
    .string()
    .optional()
    .describe("Optional: override active space for this single call."),
});

function validateListWpnArgs(
  args: z.infer<typeof listWpnInput>,
): { ok: true } | { ok: false; error: string } {
  if (args.scope === "projects") {
    if (!args.workspaceId || !args.workspaceId.trim()) {
      return { ok: false, error: "scope=projects requires workspaceId." };
    }
  }
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
    .describe("Parent note UUID. When set, workspace/project/path fields are ignored."),
  workspaceName: z
    .string()
    .optional()
    .describe("With projectName + parentPathTitles, names the workspace (trim, case-insensitive)."),
  projectName: z.string().optional().describe("Project name (trim, case-insensitive)."),
  parentPathTitles: z
    .array(z.string())
    .optional()
    .describe("Titles from a project root note down to the parent; each step is among direct children."),
  parentWpnPath: z
    .string()
    .optional()
    .describe('Convenience: "Workspace / Project / Title1 / …" split on ` / ` (space-slash-space).'),
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
  const ws = data.workspaceName?.trim() ?? "";
  const proj = data.projectName?.trim() ?? "";
  const titles = data.parentPathTitles;
  const hasStruct =
    ws.length > 0 && proj.length > 0 && Array.isArray(titles) && titles.length > 0;

  const modes = (hasId ? 1 : 0) + (hasWpnPath ? 1 : 0) + (hasStruct ? 1 : 0);
  if (modes !== 1) {
    return {
      ok: false,
      error:
        "Provide exactly one parent selector: parentNoteId, OR parentWpnPath, OR workspaceName + projectName + parentPathTitles (non-empty array).",
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

const createWorkspaceInput = z.object({
  name: z.string().min(1).describe("Name for the new workspace."),
});

const updateWorkspaceInput = z.object({
  workspaceId: z.string().describe("Workspace UUID."),
  name: z.string().optional().describe("New name for the workspace."),
  sort_index: z.number().optional().describe("Sort order index."),
  color_token: z.string().nullable().optional().describe("Color token string, or null to clear."),
});

const deleteWorkspaceInput = z.object({
  workspaceId: z.string().describe("Workspace UUID to delete. Deletes all contained projects and notes."),
});

const createSpaceInput = z.object({
  name: z.string().min(1).describe("Name for the new space."),
  orgId: z
    .string()
    .optional()
    .describe("Parent org UUID. Defaults to the active org for the current session."),
});

const moveWorkspaceToSpaceInput = z.object({
  workspaceId: z.string().describe("Workspace UUID to move."),
  targetSpaceId: z
    .string()
    .describe("Destination space UUID. Must be in the same org as the workspace."),
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
  spaceName: z
    .string()
    .optional()
    .describe(
      "Space to scan for skills. Default: \"Archon\". Ignored when noteId is given.",
    ),
  workspaceName: z
    .string()
    .optional()
    .describe(
      "Workspace to scan for skills. Default: \"Archon\". Ignored when noteId is given.",
    ),
  projectName: z
    .string()
    .optional()
    .describe(
      "Project to scan for skills. Default: \"Skills\". Ignored when noteId is given.",
    ),
  noteName: z
    .string()
    .optional()
    .describe(
      "Parent note whose direct children are the skill notes. Default: \"SKILLS.md\". Ignored when noteId is given.",
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
  workspaceId: z.string().describe("Parent workspace UUID."),
  name: z.string().min(1).describe("Name for the new project."),
});

const updateProjectInput = z.object({
  projectId: z.string().describe("Project UUID."),
  name: z.string().optional().describe("New name for the project."),
  sort_index: z.number().optional().describe("Sort order index."),
  color_token: z.string().nullable().optional().describe("Color token string, or null to clear."),
  workspace_id: z.string().optional().describe("Move project to a different workspace by id."),
});

const deleteProjectInput = z.object({
  projectId: z.string().describe("Project UUID to delete. Deletes all contained notes."),
});

const deleteNotesInput = z.object({
  ids: z.array(z.string()).min(1).describe("Array of note UUIDs to delete (bulk). Descendants are also removed."),
});

const moveNoteInput = z.object({
  projectId: z.string().describe("Project UUID the note belongs to."),
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
    .enum(["org", "space", "workspace", "project", "note"])
    .describe("What kind of id to resolve."),
  query: z
    .string()
    .min(1)
    .describe("Name (trim + case-insensitive) or UUID. UUIDs pass through as-is."),
  workspaceQuery: z
    .string()
    .optional()
    .describe("Narrow project/note searches to a workspace name or UUID."),
  projectQuery: z
    .string()
    .optional()
    .describe("Narrow note searches to a project name or UUID."),
  orgQuery: z
    .string()
    .optional()
    .describe("Narrow space searches to an org name, slug, or UUID."),
  spaceQuery: z
    .string()
    .optional()
    .describe(
      "Unused today; reserved for future workspace-by-space narrowing. Callers should pass workspaceQuery instead.",
    ),
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

const moveProjectInput = z.object({
  projectId: z.string().describe("Project UUID to move."),
  targetWorkspaceId: z
    .string()
    .describe(
      "Destination workspace UUID. Must be in the same space/org as the source.",
    ),
});

const duplicateProjectInput = z.object({
  projectId: z.string().describe("Project UUID to duplicate."),
  targetWorkspaceId: z
    .string()
    .optional()
    .describe(
      "Destination workspace UUID. Defaults to the source workspace. Must be in the same space/org.",
    ),
  newName: z
    .string()
    .optional()
    .describe("Optional name for the duplicate. Defaults to the source project name."),
});

const duplicateWorkspaceInput = z.object({
  workspaceId: z.string().describe("Workspace UUID to duplicate."),
  newName: z
    .string()
    .optional()
    .describe("Optional name for the duplicate. Defaults to the source workspace name."),
  targetSpaceId: z
    .string()
    .optional()
    .describe(
      "Destination space UUID. Defaults to the source workspace's space. Must be in the same org.",
    ),
});

const exportWorkspacesInput = z.object({
  workspaceIds: z
    .array(z.string())
    .optional()
    .describe("Optional list of workspace UUIDs to export. Omit to export all."),
});

const importWorkspacesInput = z.object({
  zipBase64: z.string().describe("Base64-encoded ZIP file content from a previous export."),
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
 * the active org and/or space to make the note discoverable. Lets the calling
 * agent (and the user) see that session state changed.
 */
type ScopeSwitch = {
  fromOrgId: string | null;
  toOrgId: string | null;
  fromSpaceId: string | null;
  toSpaceId: string | null;
};

/**
 * Ensure the active org/space matches the home of `noteId` before the tool
 * proceeds. Returns the switch record when state changed, or `null` when
 * already in scope (or when noteId is empty / not a UUID — in which case the
 * caller should fall through to its normal lookup logic). Never throws — a
 * scope-resolution error is swallowed and the caller's downstream call is
 * allowed to surface the underlying failure on its own.
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
      fromSpaceId: r.fromSpaceId,
      toSpaceId: r.toSpaceId,
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

/** Compose "Workspace / Project / Title" for an image note, or null when the context catalog misses it. */
async function resolveNotePathForImage(
  client: WpnHttpClient,
  note: WpnNoteDetail,
): Promise<string | null> {
  try {
    const rows = await client.getNotesWithContext();
    const row = rows.find((r) => r.id === note.id);
    if (!row) return null;
    return `${row.workspace_name} / ${row.project_name} / ${row.title}`;
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
  "Archon WPN tools: archon_list_wpn lists workspaces / projects / notes or a full_tree; " +
  "archon_create_workspace / archon_update_workspace / archon_delete_workspace manage workspaces; " +
  "archon_create_project / archon_update_project / archon_delete_project manage projects; " +
  "archon_find_projects / archon_find_notes resolve by name or UUID with path (Workspace / Project / Title) and ambiguity hints; " +
  "archon_resolve_note finds a noteId from workspace+project+title; archon_get_note reads a note (markdown + metadata, never image bytes); " +
  "archon_get_image_note delivers an image-type note's bytes (auto|inline|base64|url|thumbnail), defaulting to a native MCP image block and falling back to a signed URL over the 512 KiB cap — EXIF/text metadata is stripped for JPEG/PNG/WebP in byte-returning modes (url mode streams raw R2 bytes); " +
  "archon_get_note_title returns only { noteId, title } for composing renames; archon_note_rename PATCHes the full title (duplicate sibling title → error); " +
  "archon_execute_note resolves by title or id, returns ambiguity (path + noteId per candidate) for the user to pick, or returns the full note when unique — then the agent follows note.content; " +
  "archon_create_child_note creates a direct child under a parent given by parentNoteId OR by workspace+project+nested title path OR parentWpnPath string; " +
  "archon_write_note patches or creates notes; archon_delete_notes bulk-deletes notes by id; archon_move_note reparents/reorders a note (before/after/into); archon_duplicate_subtree copies a note branch; " +
  "archon_backlinks finds notes referencing a given note id; archon_export_workspaces / archon_import_workspaces handle ZIP-based backup and restore; " +
  "archon_write_back_child creates a child under a task note after completing work scoped to that note. " +
  "Write-back policy: when you finish work that was driven by a specific Archon note, call archon_write_back_child with taskNoteId equal to that note so the outcome is attached as a new direct child (audit trail). " +
  "If that note already has other children, still attach the write-back as a new direct child of the same task note unless the user asked for a different placement. " +
  "Tool overlap is intentional: archon_execute_note equals find_notes then get_note when unique; archon_write_back_child equals get_note then write_note create_child when you only have taskNoteId; archon_create_child_note overlaps write_back when you need path-based parent resolution. " +
  "Auth: use ARCHON_SYNC_API_BASE + ARCHON_ACCESS_TOKEN (cloud), ARCHON_LOCAL_WPN_URL + ARCHON_LOCAL_WPN_TOKEN (Electron loopback), or ARCHON_MCP_CLOUD_SESSION=1 for browser (archon_login_browser_*) or password (archon_login). " +
  "If any tool returns JSON with error \"unauthenticated\" and suggested_tools, call archon_login_browser_start first (preferred), complete the browser step, use archon_login_browser_poll with device_code until authorized, or use archon_login — do not use archon_logout for that case. " +
  "archon_auth_status reports session state without exposing secrets. " +
  "Cross-org: archon_list_orgs lists the user's orgs; archon_set_active_org flips the session to another org (re-issues JWT, resets active space); archon_list_wpn accepts optional orgId/spaceId for a one-shot read against a different org without changing the session. " +
  "Auto scope-switch: tools that take a noteId (get_note, get_image_note, get_note_with_links, get_note_title, note_rename, execute_note (UUID), find_notes (UUID), create_child_note (parentNoteId), write_back_child, write_note (patch_existing or create_child/sibling with anchorId), delete_notes (first id), move_note, move_note_to_project, duplicate_subtree, backlinks) automatically switch the active org/space to the note's home before running, so you don't have to call archon_set_active_org first. When a switch happens, the tool result includes a `scopeSwitched` field with the before/after orgId and spaceId.";

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

  mcp.registerTool(
    "archon_find_projects",
    {
      description:
        "Find project(s) by name or id. Returns status unique | ambiguous | none | workspace_ambiguous; " +
        "each match includes projectId, names, and path \"Workspace / Project\". On clash, all candidates are listed.",
      inputSchema: findProjectsInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) {
        return denied;
      }
      try {
        const result = await findProjectsByQuery(client, args.query, args.workspaceQuery);
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
        "Find note(s) by title or id using GET /wpn/notes-with-context. Optional workspaceQuery / projectQuery narrow scope. " +
        "Returns status unique | ambiguous | none | workspace_ambiguous | project_ambiguous; " +
        "each match includes noteId, title, and path \"Workspace / Project / Title\". " +
        "When query is a UUID, the active org/space is auto-switched to the note's home before searching (response includes scopeSwitched).",
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
          args.workspaceQuery,
          args.projectQuery,
        );
        return jsonResult(withScopeSwitched(result as Record<string, unknown>, switched));
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_list_wpn",
    {
      description:
        "List WPN data: workspaces (GET /wpn/workspaces), projects in a workspace, flat note tree for a project, or full_tree (all nested). " +
        "Optional orgId / spaceId override the active context for this single call only (restored afterwards).",
      inputSchema: listWpnInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) {
        return denied;
      }
      const validation = validateListWpnArgs(args);
      if (!validation.ok) {
        return errorResult(validation.error);
      }
      const orgOverride = args.orgId?.trim() || null;
      const spaceOverride = args.spaceId?.trim() || null;
      const prevOrg = runtime.holder.activeOrgId;
      const prevSpace = runtime.holder.activeSpaceId;
      const restoreHolder = orgOverride !== null || spaceOverride !== null;
      if (restoreHolder) {
        if (orgOverride !== null) runtime.holder.setActiveOrg(orgOverride);
        if (spaceOverride !== null) runtime.holder.setActiveSpace(spaceOverride);
        client.invalidateNotesWithContextCache();
      }
      try {
        if (args.scope === "workspaces") {
          const workspaces = await client.getWorkspaces();
          return jsonResult({ scope: "workspaces", workspaces });
        }
        if (args.scope === "projects") {
          const projects = await client.getProjects(args.workspaceId!);
          return jsonResult({
            scope: "projects",
            workspaceId: args.workspaceId,
            projects,
          });
        }
        if (args.scope === "notes") {
          const notes = await client.getNotesFlat(args.projectId!);
          return jsonResult({ scope: "notes", projectId: args.projectId, notes });
        }
        const workspaces = await client.getWorkspaces();
        type Row = { id: string; name?: string };
        const wsRows = workspaces as Row[];
        const tree: {
          workspace: Row;
          projects: { project: Row; notes: unknown[] }[];
        }[] = [];
        for (const w of wsRows) {
          const projectsRaw = await client.getProjects(w.id);
          const projects = projectsRaw as Row[];
          const projectBlocks: { project: Row; notes: unknown[] }[] = [];
          for (const p of projects) {
            const notes = await client.getNotesFlat(p.id);
            projectBlocks.push({ project: p, notes });
          }
          tree.push({ workspace: w, projects: projectBlocks });
        }
        return jsonResult({ scope: "full_tree", tree });
      } catch (e) {
        return wpnCatch(e, runtime);
      } finally {
        if (restoreHolder) {
          runtime.holder.setActiveOrg(prevOrg);
          runtime.holder.setActiveSpace(prevSpace);
          client.invalidateNotesWithContextCache();
        }
      }
    },
  );

  mcp.registerTool(
    "archon_create_workspace",
    {
      description:
        "Create a new workspace. Returns the workspace id and name.",
      inputSchema: createWorkspaceInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) {
        return denied;
      }
      try {
        const workspace = await client.createWorkspace(args.name);
        return jsonResult({ ok: true as const, workspace });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_update_workspace",
    {
      description: "Update a workspace (rename, reorder, change color). Returns the updated workspace.",
      inputSchema: updateWorkspaceInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const patch: { name?: string; sort_index?: number; color_token?: string | null } = {};
        if (args.name !== undefined) patch.name = args.name;
        if (args.sort_index !== undefined) patch.sort_index = args.sort_index;
        if (args.color_token !== undefined) patch.color_token = args.color_token;
        const workspace = await client.updateWorkspace(args.workspaceId, patch);
        return jsonResult({ ok: true as const, workspace });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_create_space",
    {
      description:
        "Create a new Space inside an Org. If orgId is omitted, uses the active org for this session. Caller becomes the Space owner.",
      inputSchema: createSpaceInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        let orgId = args.orgId?.trim();
        if (!orgId) {
          orgId = runtime.holder.activeOrgId ?? undefined;
        }
        if (!orgId) {
          const r = await client.listMyOrgs();
          orgId = r.activeOrgId ?? r.defaultOrgId ?? undefined;
        }
        if (!orgId) {
          throw new Error(
            "No active org available. Pass orgId explicitly or call archon_set_active_org first.",
          );
        }
        const space = await client.createSpace(orgId, args.name);
        return jsonResult({ ok: true as const, space });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_move_workspace_to_space",
    {
      description:
        "Move a workspace to a different Space within the same Org. Cascades spaceId to every project, note, and explorer row under the workspace. Caller needs manage rights on both the source workspace and the target space.",
      inputSchema: moveWorkspaceToSpaceInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const workspace = await client.moveWorkspaceToSpace(
          args.workspaceId,
          args.targetSpaceId,
        );
        return jsonResult({ ok: true as const, workspace });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_install_skill",
    {
      description:
        "Install skills from Archon into the caller's local repo. Caller must pass `repoPath` (absolute path to their project repo root); the MCP server runs as a long-lived global process and does not know the caller's cwd. IMPORTANT — interactive editor pick: if `providers` is OMITTED on the call, the tool short-circuits and returns `{ ok: false, needsUserInput: true, field: \"providers\", question, options[] }`. When the agent receives that response it MUST present the options to the user in chat (claude / cursor / windsurf / copilot / antigravity / opencode), let them pick one or more, and then re-invoke with `providers: [...]`. The default if the user has no preference is `[\"claude\"]`. Only when `providers` is set does the tool actually install. Default scan path (no scan args): Space \"Archon\" → Workspace \"Archon\" → Project \"Skills\" → Note \"SKILLS.md\" and install every direct child. If that canonical path is missing or empty, the tool returns a guided error telling the user how to populate it (no migration, no fallback). Pass `skillName` to filter to one child by title. Pass `noteId` to install a single specific note (overrides the resolve path). Each install writes the SKILL.md content into each selected provider's dot-directory (`.claude/skills/<name>/SKILL.md`, `.cursor/rules/<name>.mdc`, `.windsurf/rules/<name>.md`, `.github/instructions/<name>.instructions.md`, `.agents/skills/<name>/SKILL.md`, `.opencode/agents/<name>.md`). No canonical `<repo>/skills/` source and no repo-root `AGENTS.md` are written. Returns per-skill write reports; children that do not contain a valid SKILL.md block are reported under `failed` without aborting the run.",
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

        // Branch 2/3: resolve Space → Workspace → Project → Note, install children of that Note.
        // When the caller passes no path overrides (pure defaults), resolution failures are
        // rewritten as a single guided error telling them how to populate the canonical source.
        // When overrides are passed, step-specific diagnostics are preserved.
        const spaceName = args.spaceName ?? "Archon";
        const workspaceName = args.workspaceName ?? "Archon";
        const projectName = args.projectName ?? "Skills";
        const noteName = args.noteName ?? "SKILLS.md";

        const isAllDefaults =
          args.spaceName === undefined &&
          args.workspaceName === undefined &&
          args.projectName === undefined &&
          args.noteName === undefined;

        const canonicalPath = `${spaceName} / ${workspaceName} / ${projectName} / ${noteName}`;
        const guidedError = (reason: string) =>
          new Error(
            `archon_install_skill: no skills found at '${canonicalPath}'.\n\n${reason}\n\nTo populate the canonical source:\n  1. In Archon, navigate to (or create) space '${spaceName}' → workspace '${workspaceName}' → project '${projectName}'.\n  2. Create a root note titled '${noteName}' (markdown).\n  3. Under that note, create one child per skill (markdown). Each child's content is a full SKILL.md — YAML frontmatter (name, description) plus the body the agent will follow.\n  4. Re-run archon_install_skill.\n\nIf your skills live elsewhere, pass spaceName / workspaceName / projectName / noteName overrides, or pass noteId directly.`,
          );

        const { spaces } = await client.listMySpaces();
        const spaceMatches = spaces.filter(
          (s) => s.name.trim().toLowerCase() === spaceName.trim().toLowerCase(),
        );
        if (spaceMatches.length === 0) {
          if (isAllDefaults) {
            throw guidedError(`Space '${spaceName}' does not exist.`);
          }
          throw new Error(
            `archon_install_skill: Space "${spaceName}" not found. Available: ${spaces.map((s) => s.name).join(", ") || "(none)"}`,
          );
        }
        if (spaceMatches.length > 1) {
          throw new Error(
            `archon_install_skill: Space "${spaceName}" is ambiguous (${spaceMatches.length} matches across orgs). Pass a more specific spaceName or use noteId.`,
          );
        }
        const targetSpaceId = spaceMatches[0]!.spaceId;

        const prevOrg = runtime.holder.activeOrgId;
        const prevSpace = runtime.holder.activeSpaceId;
        const spaceOrgId = spaceMatches[0]!.orgId;
        const needsSpaceSwitch =
          targetSpaceId !== prevSpace ||
          (spaceOrgId !== null && spaceOrgId !== prevOrg);
        if (needsSpaceSwitch) {
          if (spaceOrgId !== null) runtime.holder.setActiveOrg(spaceOrgId);
          runtime.holder.setActiveSpace(targetSpaceId);
          client.invalidateNotesWithContextCache();
        }

        try {
          type WsRow = { id: string; name?: string };
          type ProjRow = { id: string; name?: string };
          const workspaces = (await client.getWorkspaces()) as WsRow[];
          const wsMatches = workspaces.filter(
            (w) =>
              (w.name ?? "").trim().toLowerCase() ===
              workspaceName.trim().toLowerCase(),
          );
          if (wsMatches.length === 0) {
            if (isAllDefaults) {
              throw guidedError(`Workspace '${workspaceName}' does not exist in Space '${spaceName}'.`);
            }
            throw new Error(
              `archon_install_skill: Workspace "${workspaceName}" not found in Space "${spaceName}". Available: ${workspaces.map((w) => w.name ?? "").filter(Boolean).join(", ") || "(none)"}`,
            );
          }
          if (wsMatches.length > 1) {
            throw new Error(
              `archon_install_skill: Workspace "${workspaceName}" is ambiguous (${wsMatches.length} matches) in Space "${spaceName}".`,
            );
          }
          const workspaceId = wsMatches[0]!.id;

          const projects = (await client.getProjects(workspaceId)) as ProjRow[];
          const projMatches = projects.filter(
            (p) =>
              (p.name ?? "").trim().toLowerCase() ===
              projectName.trim().toLowerCase(),
          );
          if (projMatches.length === 0) {
            if (isAllDefaults) {
              throw guidedError(`Project '${projectName}' does not exist in Workspace '${workspaceName}'.`);
            }
            throw new Error(
              `archon_install_skill: Project "${projectName}" not found in Workspace "${workspaceName}". Available: ${projects.map((p) => p.name ?? "").filter(Boolean).join(", ") || "(none)"}`,
            );
          }
          if (projMatches.length > 1) {
            throw new Error(
              `archon_install_skill: Project "${projectName}" is ambiguous (${projMatches.length} matches) in Workspace "${workspaceName}".`,
            );
          }
          const projectId = projMatches[0]!.id;

          const flat = await client.getNotesFlat(projectId);
          const parentMatches = flat.filter(
            (n) =>
              n.title.trim().toLowerCase() === noteName.trim().toLowerCase() &&
              n.parent_id === null,
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
                  (c) =>
                    c.title.trim().toLowerCase() ===
                    args.skillName!.trim().toLowerCase(),
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
              spaceName,
              spaceId: targetSpaceId,
              workspaceName,
              workspaceId,
              projectName,
              projectId,
              noteName,
              parentNoteId,
              childCount: children.length,
            },
            installed,
            failed,
          });
        } finally {
          if (needsSpaceSwitch) {
            runtime.holder.setActiveOrg(prevOrg);
            runtime.holder.setActiveSpace(prevSpace);
            client.invalidateNotesWithContextCache();
          }
        }
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_delete_workspace",
    {
      description:
        "Delete a workspace and all its projects and notes. This is irreversible.",
      inputSchema: deleteWorkspaceInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        await client.deleteWorkspace(args.workspaceId);
        return jsonResult({ ok: true as const });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_create_project",
    {
      description:
        "Create a new project inside a workspace. Returns the project id and name.",
      inputSchema: createProjectInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const project = await client.createProject(args.workspaceId, args.name);
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
        "Update a project (rename, reorder, change color, move to different workspace). Returns the updated project.",
      inputSchema: updateProjectInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const patch: { name?: string; sort_index?: number; color_token?: string | null; workspace_id?: string } = {};
        if (args.name !== undefined) patch.name = args.name;
        if (args.sort_index !== undefined) patch.sort_index = args.sort_index;
        if (args.color_token !== undefined) patch.color_token = args.color_token;
        if (args.workspace_id !== undefined) patch.workspace_id = args.workspace_id;
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
        "Active org/space auto-switches to the home of the first id before the call (response includes scopeSwitched when changed).",
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
        "Active org/space auto-switches to the dragged note's home before the call (response includes scopeSwitched when changed).",
      inputSchema: moveNoteInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const switched = await ensureNoteScope(client, args.draggedId);
        await client.moveNote(args.projectId, args.draggedId, args.targetId, args.placement);
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
        "Active org/space auto-switches to the source note's home before the call (response includes scopeSwitched when changed).",
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
        "Resolve a name (or passthrough UUID) to a copy-friendly id for org / space / workspace / project / note. " +
        "Returns { status: 'unique' | 'ambiguous' | 'none', matches: [{ id, name, path }] }. " +
        "UUID queries short-circuit to a single match. Use workspaceQuery / projectQuery / orgQuery to narrow ambiguous name matches. " +
        "Cross-org lookups are not supported; operate within the active org.",
      inputSchema: copyIdInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const q = args.query.trim();
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
        if (args.kind === "space") {
          const r = await client.listMySpaces();
          let rows = r.spaces;
          if (args.orgQuery && args.orgQuery.trim().length > 0) {
            const oq = args.orgQuery.trim();
            if (isLikelyUuid(oq)) {
              rows = rows.filter((s) => s.orgId === oq);
            } else {
              const orgs = (await client.listMyOrgs()).orgs;
              const noq = norm(oq);
              const orgIds = new Set(
                orgs
                  .filter((o) => norm(o.name) === noq || norm(o.slug) === noq)
                  .map((o) => o.orgId),
              );
              rows = rows.filter(
                (s) => s.orgId !== null && orgIds.has(s.orgId),
              );
            }
          }
          if (isLikelyUuid(q)) {
            const hit = rows.find((s) => s.spaceId === q);
            return jsonResult(
              hit
                ? {
                    status: "unique" as const,
                    matches: [
                      { id: hit.spaceId, name: hit.name, path: hit.name },
                    ],
                  }
                : { status: "none" as const, matches: [] },
            );
          }
          const nq = norm(q);
          const hits = rows.filter((s) => norm(s.name) === nq);
          if (hits.length === 0) {
            return jsonResult({ status: "none" as const, matches: [] });
          }
          const matches = hits.map((s) => ({
            id: s.spaceId,
            name: s.name,
            path: s.name,
          }));
          return jsonResult({
            status: (hits.length === 1 ? "unique" : "ambiguous") as
              | "unique"
              | "ambiguous",
            matches,
          });
        }
        if (args.kind === "workspace") {
          type WsRow = { id: string; name?: string };
          const rows = (await client.getWorkspaces()) as WsRow[];
          if (isLikelyUuid(q)) {
            const hit = rows.find((w) => w.id === q);
            return jsonResult(
              hit
                ? {
                    status: "unique" as const,
                    matches: [
                      {
                        id: hit.id,
                        name: hit.name ?? "",
                        path: hit.name ?? "",
                      },
                    ],
                  }
                : { status: "none" as const, matches: [] },
            );
          }
          const nq = norm(q);
          const hits = rows.filter((w) => norm(w.name ?? "") === nq);
          if (hits.length === 0) {
            return jsonResult({ status: "none" as const, matches: [] });
          }
          const matches = hits.map((w) => ({
            id: w.id,
            name: w.name ?? "",
            path: w.name ?? "",
          }));
          return jsonResult({
            status: (hits.length === 1 ? "unique" : "ambiguous") as
              | "unique"
              | "ambiguous",
            matches,
          });
        }
        if (args.kind === "project") {
          const result = await findProjectsByQuery(client, q, args.workspaceQuery);
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
        const result = findNotesByQuery(
          rows,
          q,
          args.workspaceQuery,
          args.projectQuery,
        );
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
        "Caller needs write access on both the source and destination workspaces. Cross-org moves are not supported — use archon_export_workspaces / archon_import_workspaces instead. " +
        "Active org/space auto-switches to the source note's home before the call (response includes scopeSwitched when changed).",
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
    "archon_move_project",
    {
      description:
        "Move a project to a different workspace. Only works within the same space/org — if you need to migrate across spaces, use archon_move_workspace_to_space on the workspace first, then move the project. " +
        "Cross-org moves are not supported — use archon_export_workspaces / archon_import_workspaces for that case.",
      inputSchema: moveProjectInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const project = await client.updateProject(args.projectId, {
          workspace_id: args.targetWorkspaceId,
        });
        return jsonResult({ ok: true as const, project });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_duplicate_project",
    {
      description:
        "Deep-copy a project (every note in the tree gets a fresh id) into the source workspace or into targetWorkspaceId. " +
        "The target workspace must be in the same space/org as the source. Caller needs write on both workspaces. " +
        "Cross-org duplicates are not supported — use archon_export_workspaces / archon_import_workspaces for that case.",
      inputSchema: duplicateProjectInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const result = await client.duplicateProject(args.projectId, {
          ...(args.targetWorkspaceId !== undefined
            ? { targetWorkspaceId: args.targetWorkspaceId }
            : {}),
          ...(args.newName !== undefined ? { newName: args.newName } : {}),
        });
        return jsonResult({ ok: true as const, ...result });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_duplicate_workspace",
    {
      description:
        "Deep-copy a workspace (every project + every note, with fresh ids) into the source space or into targetSpaceId. " +
        "The target space must be in the same org as the source. Caller needs manage rights on the source workspace and on the target space. " +
        "Cross-org duplicates are not supported — use archon_export_workspaces / archon_import_workspaces for that case.",
      inputSchema: duplicateWorkspaceInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const result = await client.duplicateWorkspace(args.workspaceId, {
          ...(args.newName !== undefined ? { newName: args.newName } : {}),
          ...(args.targetSpaceId !== undefined
            ? { targetSpaceId: args.targetSpaceId }
            : {}),
        });
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
        "Active org/space auto-switches to the target note's home before the call (response includes scopeSwitched when changed).",
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
    "archon_export_workspaces",
    {
      description:
        "Export workspaces as a ZIP archive (base64-encoded). Optionally filter by workspace ids. Returns base64 string of the ZIP.",
      inputSchema: exportWorkspacesInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const buf = await client.exportWorkspaces(args.workspaceIds);
        const b64 = Buffer.from(buf).toString("base64");
        return jsonResult({ ok: true as const, zipBase64Length: b64.length, zipBase64: b64 });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.registerTool(
    "archon_import_workspaces",
    {
      description:
        "Import workspaces from a base64-encoded ZIP archive (from a previous archon_export_workspaces). Merges imported data.",
      inputSchema: importWorkspacesInput,
    },
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) return denied;
      try {
        const buf = Buffer.from(args.zipBase64, "base64");
        const result = await client.importWorkspaces(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        return jsonResult({ ok: true as const, result });
      } catch (e) {
        return wpnCatch(e, runtime);
      }
    },
  );

  mcp.tool(
    "archon_resolve_note",
    "Resolve a note to its canonical UUID using workspace name, project name, and note title. " +
      "Matching is trim + case-insensitive. Returns an error if zero or multiple notes match.",
    resolveInput.shape,
    async (args) => {
      const denied = requireCloudAccess(runtime, client);
      if (denied) {
        return denied;
      }
      try {
        const rows = await client.getNotesWithContext();
        const r = resolveNoteFromCatalog(rows, {
          workspaceName: args.workspaceName,
          projectName: args.projectName,
          noteTitle: args.noteTitle,
        });
        if (!r.ok) {
          return errorResult(
            JSON.stringify(
              {
                error:
                  r.reason === "none"
                    ? "No note matched workspace/project/title."
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
          workspaceId: r.workspaceId,
          workspaceName: r.workspaceName,
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
    "Fetch a single note by id (includes content and metadata). Active org/space auto-switches to the note's home before the read (response includes scopeSwitched when changed).",
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
    `Fetch an image-type note's bytes in an MCP-friendly form. Modes: 'auto' (native image block, falls back to signed URL over ${GET_IMAGE_NOTE_DEFAULT_MAX_BYTES} bytes), 'inline' (force native image block), 'base64' (JSON with dataBase64), 'url' (no bytes, just a short-lived signed URL), 'thumbnail' (PLAN-04 WebP thumb). Always returns metadata { noteId, title, path, mimeType, sizeBytes, width, height }. Byte-returning modes strip EXIF / text metadata for JPEG / PNG / WebP (url mode streams raw R2 bytes). Errors on non-image notes; callers should use archon_get_note for markdown. Active org/space auto-switches to the note's home before the read.`,
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
        "Walks both `[label](#/n/<id>)` and `[label](#/w/<vfsPath>)` references breadth-first. VFS paths support canonical (`Workspace/Project/Title`), same-project-relative (`./Title`), and tree-relative (`../sibling`) forms. " +
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
        "Active org/space auto-switches to the note's home before the read.",
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
        "Active org/space auto-switches to the note's home before the call.",
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
        "Resolve a task note by title or UUID (optional workspaceQuery / projectQuery), then fetch it when the match is unique. " +
        "If multiple notes share the title, returns status ambiguous with each candidate's full path and noteId — have the user pick one, then call again with noteQuery set to that UUID (or narrow filters). " +
        "On success, the agent should read note.content and follow those instructions in the session. " +
        "When noteQuery is a UUID, the active org/space is auto-switched to the note's home before searching (response includes scopeSwitched).",
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
          args.workspaceQuery,
          args.projectQuery,
        );
        if (resolved.status !== "unique") {
          return jsonResult(withScopeSwitched(
            {
              stage: "needs_resolution" as const,
              ...resolved,
              nextStep:
                "If ambiguous, show the user each path and noteId from matches; after they choose, call archon_execute_note again with noteQuery equal to the chosen noteId (or narrow workspaceQuery/projectQuery).",
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
        "Create a new note as direct child of a parent resolved by parentNoteId, OR workspaceName+projectName+parentPathTitles (root-to-parent title chain), OR parentWpnPath (\"Workspace / Project / Title / …\"). " +
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

        let workspaceName: string;
        let projectName: string;
        let parentPathTitles: string[];

        const wpnTrim = args.parentWpnPath?.trim() ?? "";
        if (wpnTrim.length > 0) {
          const parsed = parseParentWpnPath(wpnTrim);
          if (!parsed.ok) {
            return errorResult(parsed.error);
          }
          workspaceName = parsed.workspaceName;
          projectName = parsed.projectName;
          parentPathTitles = parsed.parentPathTitles;
        } else {
          workspaceName = args.workspaceName!.trim();
          projectName = args.projectName!.trim();
          parentPathTitles = args.parentPathTitles!;
        }

        const proj = await findProjectsByQuery(client, projectName, workspaceName);
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
        "Active org/space auto-switches to the task note's home before the call.",
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
        "For patch_existing, active org/space auto-switches to the note's home before the patch.",
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
            runtime.mode !== "local" &&
            client.getHolder().activeSpaceId
          ) {
            const wsToken = await client
              .mintSpaceWsToken(client.getHolder().activeSpaceId!)
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
        "List organizations the authenticated user belongs to. Returns { orgs, activeOrgId, defaultOrgId, activeSpaceId }. " +
        "Use archon_set_active_org to switch, or pass orgId on archon_list_wpn for a one-shot read.",
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
          activeSpaceId: runtime.holder.activeSpaceId,
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
        "resets active space to the org's default (or last-used), invalidates the notes-with-context cache, " +
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
          activeSpaceId: result.activeSpaceId,
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
      let spaces: unknown = undefined;
      let active_org_id: string | null = runtime.holder.activeOrgId;
      let active_space_id: string | null = runtime.holder.activeSpaceId;
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
        try {
          const sr = await client.listMySpaces();
          spaces = sr.spaces;
          if (!active_space_id) {
            const candidate =
              sr.spaces.find((s) => s.orgId === active_org_id)?.spaceId ?? null;
            if (candidate) {
              active_space_id = candidate;
              runtime.holder.setActiveSpace(candidate);
            }
          }
        } catch {
          /* space listing is best-effort; pre-Phase-2 servers don't have /spaces/me */
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
        active_space_id,
        ...(orgs ? { orgs } : {}),
        ...(spaces ? { spaces } : {}),
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
