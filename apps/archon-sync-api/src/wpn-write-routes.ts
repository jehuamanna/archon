/**
 * WPN write routes — project + note CRUD against the post-migration schema.
 *
 * Workspace endpoints / shares / visibility are gone with their tables.
 * Project + note + settings endpoints route through the helpers in
 * `wpn-pg-writes.ts`. Realtime fanout is handled inside those helpers; the
 * route layer is just auth + body validation.
 *
 * Cross-project moves call `pgWpnMoveNoteToProject` with a
 * `targetParentId` (null for root). Title-change preview uses the
 * sync-api-local mirror at `note-vfs-mirror.ts` to avoid a cross-workspace
 * dependency on `src/shared/`.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { resolveActiveOrgId } from "./org-auth.js";
import { getDb } from "./pg.js";
import { notes, projects } from "./db/schema.js";
import {
  assertCanManageProject,
  assertCanReadProject,
  assertCanWriteProject,
  assertCanWriteProjectForNote,
  getEffectiveProjectRoles,
} from "./permission-resolver.js";
import {
  pgWpnCreateNote,
  pgWpnCreateProject,
  pgWpnDeleteNotes,
  pgWpnDeleteProject,
  pgWpnDeleteProjects,
  pgWpnDuplicateProject,
  pgWpnDuplicateSubtree,
  pgWpnGetProjectSettings,
  pgWpnMoveNote,
  pgWpnMoveNoteToProject,
  pgWpnPatchProjectSettings,
  pgWpnSetExplorerExpanded,
  pgWpnUpdateNote,
  pgWpnUpdateProject,
  WpnDuplicateSiblingTitleError,
  WPN_DUPLICATE_NOTE_TITLE_MESSAGE,
} from "./wpn-pg-writes.js";
import { isUuid } from "./db/legacy-id-map.js";
import {
  normalizeVfsSegment,
  rewriteMarkdownForWpnNoteTitleChange,
  vfsCanonicalPathsForTitleChange,
} from "./note-vfs-mirror.js";

const createProjectBody = z.object({
  name: z.string().trim().min(1).max(120),
  teamId: z.string().uuid().optional(),
  teamRole: z.enum(["owner", "contributor", "viewer"]).optional(),
});

const updateProjectBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  sortIndex: z.number().int().optional(),
  colorToken: z.string().trim().max(32).nullable().optional(),
});

const duplicateProjectBody = z.object({
  newName: z.string().trim().min(1).max(120).optional(),
  teamId: z.string().uuid().optional(),
});

const deleteProjectsBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(50),
});

const noteRelationSchema = z.enum(["root", "child", "sibling"]);

const createNoteBody = z.object({
  relation: noteRelationSchema,
  anchorId: z.string().uuid().optional(),
  type: z.string().min(1).max(64),
  title: z.string().max(280).optional(),
  content: z.string().max(2_000_000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateNoteBody = z.object({
  title: z.string().max(280).optional(),
  content: z.string().max(2_000_000).optional(),
  type: z.string().min(1).max(64).optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

const deleteNotesBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});

const moveNoteBody = z.object({
  draggedId: z.string().uuid(),
  targetId: z.string().uuid(),
  placement: z.enum(["before", "after", "into"]),
});

const moveNoteToProjectBody = z.object({
  noteId: z.string().uuid(),
  targetProjectId: z.string().uuid(),
  targetParentId: z.string().uuid().nullable(),
});

const explorerStateBody = z.object({
  expanded_ids: z.array(z.string().uuid()).max(10_000),
});

const projectSettingsPatchBody = z.object({
  settings: z.record(z.unknown()),
});

export function registerWpnWriteRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  /** Create a project (optionally attached to a team via team_projects). */
  app.post("/wpn/projects", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const orgId = resolveActiveOrgId(request, auth);
    if (!orgId) {
      return reply.status(400).send({ error: "Active org required" });
    }
    const parsed = createProjectBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    if (!isUuid(auth.sub)) {
      return reply.status(401).send({ error: "Invalid session" });
    }
    const project = await pgWpnCreateProject(orgId, parsed.data.name, {
      creatorUserId: auth.sub,
      teamId: parsed.data.teamId,
      teamRole: parsed.data.teamRole,
    });
    return reply.send({ project });
  });

  app.patch("/wpn/projects/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    if (!(await assertCanManageProject(reply, auth, id))) return;
    const parsed = updateProjectBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const project = await pgWpnUpdateProject(id, parsed.data);
    if (!project) {
      return reply.status(404).send({ error: "Project not found" });
    }
    return reply.send({ project });
  });

  app.delete("/wpn/projects/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    if (!(await assertCanManageProject(reply, auth, id))) return;
    const ok = await pgWpnDeleteProject(id);
    if (!ok) {
      return reply.status(404).send({ error: "Project not found" });
    }
    return reply.status(204).send();
  });

  app.post("/wpn/projects/delete", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const parsed = deleteProjectsBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    // Per-id manage check; the helper itself does no auth.
    for (const id of parsed.data.ids) {
      if (!(await assertCanManageProject(reply, auth, id))) return;
    }
    const result = await pgWpnDeleteProjects(parsed.data.ids);
    return reply.send(result);
  });

  app.post("/wpn/projects/:id/duplicate", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    if (!(await assertCanReadProject(reply, auth, id))) return;
    const parsed = duplicateProjectBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    if (!isUuid(auth.sub)) {
      return reply.status(401).send({ error: "Invalid session" });
    }
    const result = await pgWpnDuplicateProject(id, {
      newName: parsed.data.newName,
      creatorUserId: auth.sub,
      teamId: parsed.data.teamId,
    });
    return reply.send(result);
  });

  app.get("/wpn/projects/:projectId/settings", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { projectId } = request.params as { projectId: string };
    if (!(await assertCanReadProject(reply, auth, projectId))) return;
    const settings = await pgWpnGetProjectSettings(projectId);
    return reply.send({ settings });
  });

  app.patch("/wpn/projects/:projectId/settings", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { projectId } = request.params as { projectId: string };
    if (!(await assertCanManageProject(reply, auth, projectId))) return;
    const parsed = projectSettingsPatchBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const ok = await pgWpnPatchProjectSettings(projectId, parsed.data.settings);
    if (!ok) {
      return reply.status(404).send({ error: "Project not found" });
    }
    return reply.status(204).send();
  });

  // ---------- notes ----------

  app.post("/wpn/projects/:projectId/notes", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { projectId } = request.params as { projectId: string };
    if (!(await assertCanWriteProject(reply, auth, projectId))) return;
    const parsed = createNoteBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    if (!isUuid(auth.sub)) {
      return reply.status(401).send({ error: "Invalid session" });
    }
    try {
      const result = await pgWpnCreateNote(
        projectId,
        parsed.data,
        { editorUserId: auth.sub },
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof WpnDuplicateSiblingTitleError) {
        return reply
          .status(409)
          .send({ error: WPN_DUPLICATE_NOTE_TITLE_MESSAGE });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  app.patch("/wpn/notes/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    if (!(await assertCanWriteProjectForNote(reply, auth, id))) return;
    const parsed = updateNoteBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    if (!isUuid(auth.sub)) {
      return reply.status(401).send({ error: "Invalid session" });
    }
    try {
      const result = await pgWpnUpdateNote(
        id,
        parsed.data,
        { editorUserId: auth.sub },
      );
      if (!result) {
        return reply.status(404).send({ error: "Note not found" });
      }
      return reply.send({ note: result });
    } catch (err) {
      if (err instanceof WpnDuplicateSiblingTitleError) {
        return reply
          .status(409)
          .send({ error: WPN_DUPLICATE_NOTE_TITLE_MESSAGE });
      }
      throw err;
    }
  });

  /**
   * Title-change preview — used by the editor to show "this title shift will
   * also rewrite N inbound link references" before the user commits. Scans
   * every note the caller can read, runs the rewrite logic in dry-run, and
   * counts notes whose content would change.
   *
   * Scope: notes inside projects the caller has read access to via
   * team_projects. Master/org-admin "see everything" overrides aren't applied
   * here — preview semantics are about the user's own working set, not the
   * full graph.
   */
  app.post("/wpn/notes/:id/preview-title-change", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const { id } = request.params as { id: string };
    if (!isUuid(id)) {
      return reply.status(400).send({ error: "Invalid note id" });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const newTitleRaw = typeof body.title === "string" ? body.title : "";

    // Read-gate: load the note's project, check the caller can read it.
    const noteRows = await getDb()
      .select({
        title: notes.title,
        projectId: notes.projectId,
        deleted: notes.deleted,
      })
      .from(notes)
      .where(eq(notes.id, id))
      .limit(1);
    const note = noteRows[0];
    if (!note || note.deleted) {
      return reply.status(404).send({ error: "Note not found" });
    }
    const projectRow = await assertCanReadProject(reply, auth, note.projectId);
    if (!projectRow) return;

    const nextTitle = newTitleRaw.trim() || note.title;
    const ctx = { project_name: projectRow.name };
    const paths = vfsCanonicalPathsForTitleChange(ctx, note.title, nextTitle);
    if (!paths) {
      return reply.send({ dependentNoteCount: 0, dependentNoteIds: [] });
    }
    const { oldCanonical, newCanonical } = paths;
    const oldSeg = normalizeVfsSegment(note.title, "Untitled");
    const newSeg = normalizeVfsSegment(nextTitle, "Untitled");

    // Limit the scan to projects the caller can read. Pre-migration this
    // walked the user's per-user shadow rows; the post-migration substitute
    // is `team_projects` access — equivalent for "what could the user
    // notice changing in their working set".
    const accessible = await getEffectiveProjectRoles(auth.sub);
    const projectIds = [...accessible.keys()];
    if (projectIds.length === 0) {
      return reply.send({ dependentNoteCount: 0, dependentNoteIds: [] });
    }
    const allNotes = await getDb()
      .select({
        id: notes.id,
        projectId: notes.projectId,
        content: notes.content,
      })
      .from(notes)
      .where(
        and(
          sql`${notes.projectId} = ANY(${projectIds})`,
          sql`${notes.deleted} IS NOT TRUE`,
        ),
      );

    const dependentNoteIds: string[] = [];
    for (const n of allNotes) {
      const c0 = n.content ?? "";
      const c1 = rewriteMarkdownForWpnNoteTitleChange(
        c0,
        n.projectId,
        note.projectId,
        oldCanonical,
        newCanonical,
        oldSeg,
        newSeg,
      );
      if (c1 !== c0) dependentNoteIds.push(n.id);
    }
    return reply.send({
      dependentNoteCount: dependentNoteIds.length,
      dependentNoteIds,
    });
  });

  app.post("/wpn/notes/delete", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const parsed = deleteNotesBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    // Per-note write check.
    for (const id of parsed.data.ids) {
      if (!(await assertCanWriteProjectForNote(reply, auth, id))) return;
    }
    await pgWpnDeleteNotes(parsed.data.ids);
    return reply.status(204).send();
  });

  app.post("/wpn/notes/move", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const parsed = moveNoteBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const project = await assertCanWriteProjectForNote(reply, auth, parsed.data.draggedId);
    if (!project) return;
    if (!isUuid(auth.sub)) {
      return reply.status(401).send({ error: "Invalid session" });
    }
    try {
      await pgWpnMoveNote(
        project.id,
        parsed.data.draggedId,
        parsed.data.targetId,
        parsed.data.placement,
        { editorUserId: auth.sub },
      );
      return reply.status(204).send();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  app.post("/wpn/notes/move-to-project", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const parsed = moveNoteToProjectBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    if (!(await assertCanWriteProjectForNote(reply, auth, parsed.data.noteId))) return;
    if (!(await assertCanWriteProject(reply, auth, parsed.data.targetProjectId))) return;
    if (!isUuid(auth.sub)) {
      return reply.status(401).send({ error: "Invalid session" });
    }
    try {
      await pgWpnMoveNoteToProject(
        parsed.data.noteId,
        parsed.data.targetProjectId,
        parsed.data.targetParentId,
        { editorUserId: auth.sub },
      );
      return reply.status(204).send();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: msg });
    }
  });

  app.post(
    "/wpn/projects/:projectId/notes/:noteId/duplicate",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { projectId, noteId } = request.params as {
        projectId: string;
        noteId: string;
      };
      if (!(await assertCanWriteProject(reply, auth, projectId))) return;
      if (!isUuid(auth.sub)) {
        return reply.status(401).send({ error: "Invalid session" });
      }
      try {
        const result = await pgWpnDuplicateSubtree(projectId, noteId, {
          editorUserId: auth.sub,
        });
        return reply.send(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
    },
  );

  app.patch(
    "/wpn/projects/:projectId/explorer-state",
    async (request, reply) => {
      const auth = await requireAuth(request, reply, jwtSecret);
      if (!auth) return;
      const { projectId } = request.params as { projectId: string };
      if (!(await assertCanReadProject(reply, auth, projectId))) return;
      const parsed = explorerStateBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      if (!isUuid(auth.sub)) {
        return reply.status(401).send({ error: "Invalid session" });
      }
      await pgWpnSetExplorerExpanded(
        auth.sub,
        projectId,
        parsed.data.expanded_ids,
      );
      return reply.status(204).send();
    },
  );
}
