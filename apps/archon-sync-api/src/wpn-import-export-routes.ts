/**
 * Bundle export / import — v3 (post-org/team migration).
 *
 * Export (`POST /wpn/export`):
 *   Body: `{ projectIds?: string[] }`. When omitted, exports every project
 *   the caller has read access to via team_projects (plus org-admin / master
 *   admin overrides handled by the resolver). When provided, every id is
 *   read-checked individually; a single failure 403s the whole request.
 *   Streams a ZIP back: `metadata.json` (project-rooted manifest) plus
 *   `notes/<noteId>.md` per note. Image-asset bytes are deferred — see
 *   below — so v3 bundles produced by this build are text-only.
 *
 * Import (`POST /wpn/import?conflict=<policy>`):
 *   Multipart upload with a single ZIP file part. Body's `teamId` query
 *   param (or form field) is required: imported projects attach to that
 *   team via `team_projects` with role 'owner'. The caller must be a
 *   member of `teamId`. Project-name conflicts inside the team's existing
 *   project set are resolved by the `conflict` policy (default `rename`).
 *
 * Image asset bytes:
 *   The historical v2 path re-uploaded image-note bytes through
 *   `buildImageAssetKey`, which still bakes `spaceId` / `workspaceId` into
 *   the R2 key — that helper hasn't been ported to the new model. While
 *   that gap is open, this route refuses bundles that contain `assets[]`
 *   on import (501) and skips R2 streaming on export. Pre-migration
 *   bundles (v1/v2, both workspace-rooted) are also rejected with a
 *   versioned error.
 */
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import archiver from "archiver";
import unzipper from "unzipper";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { requireAuth } from "./auth.js";
import { getDb } from "./pg.js";
import {
  notes,
  projects,
  teamMemberships,
  teamProjects,
  teams,
} from "./db/schema.js";
import {
  buildExportManifest,
  ExportBytesCapExceededError,
  planImportProjects,
  type AssetStreamPlan,
  type ExportProjectInput,
  type WpnExportMetadata,
  type WpnImportConflictPolicy,
} from "./export-import-helpers.js";
import {
  exportMaxAssetBytes,
  isImageNotesFeatureEnabled,
} from "./server-env.js";
import { getR2Client, type R2ClientLike } from "./r2-client.js";
import { getEffectiveProjectRoles } from "./permission-resolver.js";

type WpnImportResult = {
  projects: number;
  notes: number;
};

type NoteRow = typeof notes.$inferSelect;

function sendErr(reply: FastifyReply, status: number, msg: string) {
  return reply.status(status).send({ error: msg });
}

function nowMs(): number {
  return Date.now();
}

function parseConflictPolicy(raw: unknown): WpnImportConflictPolicy {
  if (raw === "skip" || raw === "overwrite" || raw === "rename") return raw;
  return "rename";
}

export type RegisterWpnImportExportRoutesOptions = {
  jwtSecret: string;
  /** Test injection point. Production uses {@link getR2Client}. */
  r2Client?: R2ClientLike;
};

export async function registerWpnImportExportRoutes(
  app: FastifyInstance,
  opts: RegisterWpnImportExportRoutesOptions,
): Promise<void> {
  const { jwtSecret } = opts;
  const db = (): ReturnType<typeof getDb> => getDb();

  await app.register(import("@fastify/multipart"), {
    limits: { fileSize: 200 * 1024 * 1024 },
  });

  // ── EXPORT ────────────────────────────────────────────────────────────
  app.post("/wpn/export", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const userId = auth.sub;

    const body = request.body as { projectIds?: string[] } | undefined;
    const filterIds =
      Array.isArray(body?.projectIds) && body!.projectIds.length > 0
        ? body!.projectIds.filter((x): x is string => typeof x === "string")
        : null;

    // Resolve "which projects can the caller read". The resolver folds
    // team_projects roles per user; we trust it for the common path. Org-
    // admin / master-admin "read everything" cases would need a second pass
    // — out of scope here, the explorer can enumerate before calling.
    const accessible = await getEffectiveProjectRoles(userId);
    let projectIds: string[];
    if (filterIds) {
      const denied = filterIds.filter((id) => !accessible.has(id));
      if (denied.length > 0) {
        return sendErr(
          reply,
          403,
          `No read access to project(s): ${denied.join(", ")}`,
        );
      }
      projectIds = filterIds;
    } else {
      projectIds = [...accessible.keys()];
      if (projectIds.length === 0) {
        return sendErr(reply, 404, "No projects found to export");
      }
    }

    const projDocs = await db()
      .select()
      .from(projects)
      .where(inArray(projects.id, projectIds))
      .orderBy(asc(projects.sortIndex), asc(projects.name));

    const noteDocs = projectIds.length
      ? await db()
          .select()
          .from(notes)
          .where(
            and(
              inArray(notes.projectId, projectIds),
              sql`${notes.deleted} IS NOT TRUE`,
            ),
          )
      : ([] as NoteRow[]);

    const notesByProject = new Map<string, NoteRow[]>();
    for (const n of noteDocs) {
      const arr = notesByProject.get(n.projectId) ?? [];
      arr.push(n);
      notesByProject.set(n.projectId, arr);
    }

    const projectsInput: ExportProjectInput[] = projDocs.map((proj) => ({
      id: proj.id,
      name: proj.name,
      sort_index: proj.sortIndex,
      color_token: proj.colorToken,
      notes: (notesByProject.get(proj.id) ?? []).map((n) => ({
        id: n.id,
        parent_id: n.parentId,
        type: n.type,
        title: n.title,
        sibling_index: n.siblingIndex,
        metadata:
          n.metadata && typeof n.metadata === "object" && !Array.isArray(n.metadata)
            ? (n.metadata as Record<string, unknown>)
            : null,
      })),
    }));

    let manifest: { metadata: WpnExportMetadata; assets: AssetStreamPlan[] };
    try {
      manifest = buildExportManifest({
        projects: projectsInput,
        exportedAtMs: nowMs(),
        maxAssetBytes: exportMaxAssetBytes(),
      });
    } catch (e) {
      if (e instanceof ExportBytesCapExceededError) {
        return sendErr(reply, 413, e.message);
      }
      throw e;
    }

    // Image-asset streaming is gated on `buildImageAssetKey` being ported
    // to the post-migration shape (no spaceId/workspaceId). Until then the
    // exporter still records `assets[]` entries in the manifest but skips
    // R2 streaming — readers see the metadata reference and treat the note
    // as broken-on-import, matching v1's behavior.
    if (manifest.assets.length > 0) {
      request.log.warn(
        { assetCount: manifest.assets.length },
        "wpn-export: skipping R2 asset streaming (image-asset path scheme not yet ported)",
      );
    }

    const archive = archiver("zip", { zlib: { level: 6 } });
    const passthrough = new PassThrough();
    archive.pipe(passthrough);

    archive.on("error", (err) => {
      request.log.error({ err }, "Export archive error");
      passthrough.destroy(err);
    });

    archive.append(JSON.stringify(manifest.metadata, null, 2), {
      name: "metadata.json",
    });

    for (const n of noteDocs) {
      archive.append(n.content ?? "", { name: `notes/${n.id}.md` });
    }

    reply.raw.setHeader("Content-Type", "application/zip");
    reply.raw.setHeader(
      "Content-Disposition",
      'attachment; filename="archon-export.zip"',
    );

    const response = reply.send(passthrough);

    void (async () => {
      try {
        await archive.finalize();
      } catch (err) {
        request.log.error(
          { err },
          "Export archive finalize failed; aborting",
        );
        archive.abort();
        passthrough.destroy(err as Error);
      }
    })();

    return response;
  });

  // ── IMPORT ────────────────────────────────────────────────────────────
  app.post("/wpn/import", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const userId = auth.sub;

    const query = request.query as {
      conflict?: string;
      teamId?: string;
    };
    const policy = parseConflictPolicy(query.conflict);
    const teamId = typeof query.teamId === "string" ? query.teamId : null;
    if (!teamId) {
      return sendErr(
        reply,
        400,
        "Missing required query param: teamId (target team for imported projects)",
      );
    }

    // Validate the caller is on the target team; the team's org pins the
    // imported projects' org_id (every project has a non-null org).
    const teamRow = await db()
      .select({ id: teams.id, orgId: teams.orgId })
      .from(teams)
      .innerJoin(
        teamMemberships,
        and(
          eq(teamMemberships.teamId, teams.id),
          eq(teamMemberships.userId, userId),
        ),
      )
      .where(eq(teams.id, teamId))
      .limit(1);
    if (teamRow.length === 0) {
      return sendErr(reply, 403, "Not a member of the target team");
    }
    const targetOrgId = teamRow[0]!.orgId;

    let file: Awaited<ReturnType<typeof request.file>>;
    try {
      file = await request.file();
    } catch {
      return sendErr(reply, 400, "Expected multipart file upload");
    }
    if (!file) {
      return sendErr(reply, 400, "No file uploaded");
    }

    let metadataJson: WpnExportMetadata | null = null;
    const noteContents = new Map<string, string>();
    const assetEntryCount = { n: 0 };

    const directory = await unzipper.Open.buffer(await file.toBuffer());
    for (const entry of directory.files) {
      if (entry.path === "metadata.json") {
        const buf = await entry.buffer();
        metadataJson = JSON.parse(buf.toString("utf-8")) as WpnExportMetadata;
      } else if (entry.path.startsWith("notes/") && entry.path.endsWith(".md")) {
        const noteId = entry.path.slice(6, -3);
        const buf = await entry.buffer();
        noteContents.set(noteId, buf.toString("utf-8"));
      } else if (entry.path.startsWith("assets/")) {
        assetEntryCount.n++;
      }
    }

    if (!metadataJson) {
      return sendErr(reply, 400, "Missing metadata.json in ZIP");
    }
    if (metadataJson.version !== 3) {
      return sendErr(
        reply,
        400,
        `Unsupported export bundle version: ${String(metadataJson.version)}. ` +
          `This server accepts v3 (project-rooted) bundles only — pre-migration ` +
          `v1/v2 bundles must be re-exported from a system on the new schema.`,
      );
    }

    // Image-asset bundling is paused while the asset-key path scheme is
    // ported. Reject bundles that ship bytes rather than silently dropping
    // them on the floor.
    const hasAssetEntries =
      assetEntryCount.n > 0 ||
      metadataJson.projects.some((p) =>
        p.notes.some((n) => (n.assets?.length ?? 0) > 0),
      );
    if (hasAssetEntries) {
      if (!isImageNotesFeatureEnabled()) {
        return sendErr(
          reply,
          501,
          "Bundle contains image assets but image-notes feature is disabled on this server.",
        );
      }
      return sendErr(
        reply,
        501,
        "Bundle contains image asset bytes; image-asset re-upload is pending the asset-key path scheme port. Re-export without image bytes or wait for the follow-up.",
      );
    }

    const existingProjs = await db()
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .innerJoin(teamProjects, eq(teamProjects.projectId, projects.id))
      .where(eq(teamProjects.teamId, teamId));

    const plan = planImportProjects({
      bundle: metadataJson,
      existingProjects: existingProjs,
      policy,
    });

    const lastProjRow = await db()
      .select({ s: projects.sortIndex })
      .from(projects)
      .where(eq(projects.orgId, targetOrgId))
      .orderBy(desc(projects.sortIndex))
      .limit(1);
    let nextProjSortIndex = (lastProjRow[0]?.s ?? -1) + 1;

    const t = nowMs();
    const grantedAt = new Date(t);
    let importedProj = 0;
    let importedNotes = 0;

    for (const projEntry of metadataJson.projects) {
      const action = plan.projects.find(
        (a) => a.sourceProjectId === projEntry.id,
      );
      if (!action || action.kind === "skip") continue;

      let targetProjId: string;
      if (action.kind === "reuse") {
        targetProjId = action.existingProjectId;
      } else {
        targetProjId = randomUUID();
        await db().insert(projects).values({
          id: targetProjId,
          orgId: targetOrgId,
          creatorUserId: userId,
          name: action.chosenName,
          sortIndex: nextProjSortIndex++,
          colorToken: projEntry.color_token ?? null,
          createdAtMs: t,
          updatedAtMs: t,
          settings: {} as unknown,
        });
        await db()
          .insert(teamProjects)
          .values({
            teamId,
            projectId: targetProjId,
            role: "owner",
            grantedByUserId: userId,
            grantedAt,
          })
          .onConflictDoNothing({
            target: [teamProjects.teamId, teamProjects.projectId],
          });
        importedProj++;
      }

      const idMap = new Map<string, string>();
      for (const noteEntry of projEntry.notes) {
        idMap.set(noteEntry.id, randomUUID());
      }

      // Find the next sibling_index baseline for the target project so notes
      // appended into a reused project don't collide with existing ones.
      const lastNoteRow = await db()
        .select({ s: notes.siblingIndex })
        .from(notes)
        .where(eq(notes.projectId, targetProjId))
        .orderBy(desc(notes.siblingIndex))
        .limit(1);
      let nextRootSiblingIndex = (lastNoteRow[0]?.s ?? -1) + 1;

      // Sort by parent then by sibling_index so renumbering preserves order.
      const sorted = [...projEntry.notes].sort(
        (a, b) =>
          (a.parent_id ?? "").localeCompare(b.parent_id ?? "") ||
          a.sibling_index - b.sibling_index,
      );

      for (const noteEntry of sorted) {
        const newNoteId = idMap.get(noteEntry.id)!;
        const newParentId =
          noteEntry.parent_id !== null
            ? idMap.get(noteEntry.parent_id) ?? null
            : null;
        const content = noteContents.get(noteEntry.id) ?? "";
        // Root-level notes get appended after any existing siblings; nested
        // notes keep their bundled sibling_index since the parent is new too
        // (or merging into a reused project is best-effort — a sibling clash
        // is recoverable client-side via re-order).
        const siblingIndex =
          newParentId === null ? nextRootSiblingIndex++ : noteEntry.sibling_index;
        await db().insert(notes).values({
          id: newNoteId,
          orgId: targetOrgId,
          projectId: targetProjId,
          parentId: newParentId,
          createdByUserId: userId,
          updatedByUserId: userId,
          type: noteEntry.type,
          title: noteEntry.title,
          content,
          metadata: noteEntry.metadata as unknown,
          siblingIndex,
          createdAtMs: t,
          updatedAtMs: t,
        });
        importedNotes++;
      }
    }

    return reply.send({
      imported: {
        projects: importedProj,
        notes: importedNotes,
      } satisfies WpnImportResult,
    });
  });
}
