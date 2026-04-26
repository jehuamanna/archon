import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import archiver from "archiver";
import unzipper from "unzipper";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { requireAuth } from "./auth.js";
import { getDb } from "./pg.js";
import { wpnNotes, wpnProjects, wpnWorkspaces } from "./db/schema.js";
import {
  buildExportManifest,
  clearImageMetadataKeys,
  ExportBytesCapExceededError,
  planImportWorkspaces,
  type AssetStreamPlan,
  type ExportWorkspaceInput,
  type ImportWorkspaceAction,
  type WpnExportMetadata,
  type WpnImportConflictPolicy,
} from "./export-import-helpers.js";
import {
  exportMaxAssetBytes,
  isImageNotesFeatureEnabled,
} from "./server-env.js";
import { getR2Client, type R2ClientLike } from "./r2-client.js";
import { buildImageAssetKey, isAllowedImageMime } from "./image-asset-path.js";
import { rewriteVfsCanonicalLinksInMarkdown } from "./wpn-vfs-rewrite.js";

type WpnImportResult = {
  workspaces: number;
  projects: number;
  notes: number;
};

type NoteRow = typeof wpnNotes.$inferSelect;

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

async function reuploadImageAsset(args: {
  r2: R2ClientLike;
  asset: {
    zipPath: string;
    mimeType: string;
    sizeBytes: number;
    originalFilename?: string;
  };
  assetBytes: Map<string, Buffer>;
  sourceMetadata: Record<string, unknown> | null;
  orgId: string;
  spaceId: string;
  workspaceId: string;
  projectId: string;
  noteId: string;
}): Promise<Record<string, unknown>> {
  const bytes = args.assetBytes.get(args.asset.zipPath);
  if (!bytes) {
    throw new Error(`Asset bytes missing for ${args.asset.zipPath}`);
  }
  if (!isAllowedImageMime(args.asset.mimeType)) {
    throw new Error(`Unsupported asset mime: ${args.asset.mimeType}`);
  }
  const newKey = buildImageAssetKey({
    orgId: args.orgId,
    spaceId: args.spaceId,
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    noteId: args.noteId,
    variant: "original",
  });
  await args.r2.uploadObject({
    key: newKey,
    body: bytes,
    contentType: args.asset.mimeType,
    contentLength: bytes.length,
  });
  const cleared = clearImageMetadataKeys(args.sourceMetadata) ?? {};
  cleared.metadataVersion = 1;
  cleared.r2Key = newKey;
  cleared.mimeType = args.asset.mimeType;
  cleared.sizeBytes = bytes.length;
  if (args.asset.originalFilename && typeof cleared.originalFilename !== "string") {
    cleared.originalFilename = args.asset.originalFilename;
  }
  return cleared;
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

    const body = request.body as { workspaceIds?: string[] } | undefined;
    const filterIds =
      Array.isArray(body?.workspaceIds) && body!.workspaceIds.length > 0
        ? body!.workspaceIds.filter((x): x is string => typeof x === "string")
        : null;

    const wsDocs = await (filterIds
      ? db()
          .select()
          .from(wpnWorkspaces)
          .where(
            and(
              eq(wpnWorkspaces.userId, userId),
              inArray(wpnWorkspaces.id, filterIds),
            ),
          )
          .orderBy(asc(wpnWorkspaces.sort_index), asc(wpnWorkspaces.name))
      : db()
          .select()
          .from(wpnWorkspaces)
          .where(eq(wpnWorkspaces.userId, userId))
          .orderBy(asc(wpnWorkspaces.sort_index), asc(wpnWorkspaces.name)));
    if (wsDocs.length === 0) {
      return sendErr(reply, 404, "No workspaces found to export");
    }

    const wsIds = wsDocs.map((w) => w.id);
    const projDocs = await db()
      .select()
      .from(wpnProjects)
      .where(
        and(
          eq(wpnProjects.userId, userId),
          inArray(wpnProjects.workspace_id, wsIds),
        ),
      )
      .orderBy(asc(wpnProjects.sort_index), asc(wpnProjects.name));
    const projIds = projDocs.map((p) => p.id);
    const noteDocs = projIds.length
      ? await db()
          .select()
          .from(wpnNotes)
          .where(
            and(
              eq(wpnNotes.userId, userId),
              inArray(wpnNotes.project_id, projIds),
              sql`${wpnNotes.deleted} IS NOT TRUE`,
            ),
          )
      : ([] as NoteRow[]);

    const notesByProject = new Map<string, NoteRow[]>();
    for (const n of noteDocs) {
      const arr = notesByProject.get(n.project_id) ?? [];
      arr.push(n);
      notesByProject.set(n.project_id, arr);
    }

    const workspacesInput: ExportWorkspaceInput[] = wsDocs.map((ws) => {
      const wsProjects = projDocs.filter((p) => p.workspace_id === ws.id);
      return {
        id: ws.id,
        name: ws.name,
        sort_index: ws.sort_index,
        color_token: ws.color_token,
        projects: wsProjects.map((proj) => ({
          id: proj.id,
          name: proj.name,
          sort_index: proj.sort_index,
          color_token: proj.color_token,
          notes: (notesByProject.get(proj.id) ?? []).map((n) => ({
            id: n.id,
            parent_id: n.parent_id,
            type: n.type,
            title: n.title,
            sibling_index: n.sibling_index,
            metadata:
              n.metadata && typeof n.metadata === "object" && !Array.isArray(n.metadata)
                ? (n.metadata as Record<string, unknown>)
                : null,
          })),
        })),
      };
    });

    let manifest: { metadata: WpnExportMetadata; assets: AssetStreamPlan[] };
    try {
      manifest = buildExportManifest({
        workspaces: workspacesInput,
        exportedAtMs: nowMs(),
        maxAssetBytes: exportMaxAssetBytes(),
      });
    } catch (e) {
      if (e instanceof ExportBytesCapExceededError) {
        return sendErr(reply, 413, e.message);
      }
      throw e;
    }

    let r2: R2ClientLike | null = null;
    if (manifest.assets.length > 0) {
      if (!isImageNotesFeatureEnabled()) {
        return sendErr(
          reply,
          501,
          "Bundle contains image assets but image-notes feature is disabled on this server.",
        );
      }
      try {
        r2 = opts.r2Client ?? getR2Client();
      } catch (e) {
        return sendErr(
          reply,
          500,
          e instanceof Error ? e.message : "R2 client unavailable",
        );
      }
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
        for (const asset of manifest.assets) {
          if (!r2) {
            throw new Error("R2 client not initialized for asset streaming");
          }
          const bytes = await r2.getObjectBytes({ key: asset.r2Key });
          archive.append(bytes, { name: asset.zipPath });
        }
        await archive.finalize();
      } catch (err) {
        request.log.error(
          { err, assetCount: manifest.assets.length },
          "Export asset streaming failed; aborting archive",
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

    const policy = parseConflictPolicy(
      (request.query as { conflict?: string }).conflict,
    );

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
    const assetBytes = new Map<string, Buffer>();

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
        const buf = await entry.buffer();
        assetBytes.set(entry.path, buf);
      }
    }

    if (!metadataJson) {
      return sendErr(reply, 400, "Missing metadata.json in ZIP");
    }
    if (metadataJson.version !== 1 && metadataJson.version !== 2) {
      return sendErr(
        reply,
        400,
        `Unsupported export bundle version: ${String(metadataJson.version)}`,
      );
    }

    const hasAssetEntries = metadataJson.workspaces.some((ws) =>
      ws.projects.some((proj) =>
        proj.notes.some((note) => (note.assets?.length ?? 0) > 0),
      ),
    );
    let r2: R2ClientLike | null = null;
    if (hasAssetEntries) {
      if (!isImageNotesFeatureEnabled()) {
        return sendErr(
          reply,
          501,
          "Bundle contains image assets but image-notes feature is disabled on this server.",
        );
      }
      try {
        r2 = opts.r2Client ?? getR2Client();
      } catch (e) {
        return sendErr(
          reply,
          500,
          e instanceof Error ? e.message : "R2 client unavailable",
        );
      }
    }

    // Collision scope: caller's workspaces in the destination space (or all
    // legacy/no-space ones) — same as Mongo path.
    const existingWs = await (auth.activeSpaceId
      ? db()
          .select()
          .from(wpnWorkspaces)
          .where(
            and(
              eq(wpnWorkspaces.userId, userId),
              or(
                eq(wpnWorkspaces.spaceId, auth.activeSpaceId),
                isNull(wpnWorkspaces.spaceId),
              ),
            ),
          )
      : db()
          .select()
          .from(wpnWorkspaces)
          .where(eq(wpnWorkspaces.userId, userId)));
    const plan = planImportWorkspaces({
      bundle: metadataJson,
      existingWorkspaces: existingWs.map((w) => ({ id: w.id, name: w.name })),
      policy,
    });

    const lastWsRows = await db()
      .select({ s: wpnWorkspaces.sort_index })
      .from(wpnWorkspaces)
      .where(eq(wpnWorkspaces.userId, userId))
      .orderBy(desc(wpnWorkspaces.sort_index))
      .limit(1);
    let nextWsSortIndex = (lastWsRows[0]?.s ?? -1) + 1;

    const t = nowMs();
    let importedWs = 0;
    let importedProj = 0;
    let importedNotes = 0;

    for (const wsEntry of metadataJson.workspaces) {
      const action = plan.workspaces.find(
        (a): a is ImportWorkspaceAction => a.sourceWorkspaceId === wsEntry.id,
      );
      if (!action || action.kind === "skip") continue;

      let targetWsId: string;
      let targetOrgId: string | undefined;
      let targetSpaceId: string | undefined;

      if (action.kind === "reuse") {
        const existing = existingWs.find(
          (w) => w.id === action.existingWorkspaceId,
        );
        if (!existing) continue;
        targetWsId = existing.id;
        targetOrgId = existing.orgId ?? undefined;
        targetSpaceId = existing.spaceId ?? undefined;
      } else {
        targetWsId = randomUUID();
        targetOrgId = auth.activeOrgId;
        targetSpaceId = auth.activeSpaceId;
        await db().insert(wpnWorkspaces).values({
          id: targetWsId,
          userId,
          orgId: targetOrgId ?? null,
          spaceId: targetSpaceId ?? null,
          name: action.chosenName,
          sort_index: nextWsSortIndex++,
          color_token: wsEntry.color_token ?? null,
          created_at_ms: t,
          updated_at_ms: t,
          settings: {} as unknown,
        });
        importedWs++;
      }

      let nextProjSortIndex =
        action.kind === "reuse"
          ? ((
              await db()
                .select({ s: wpnProjects.sort_index })
                .from(wpnProjects)
                .where(
                  and(
                    eq(wpnProjects.userId, userId),
                    eq(wpnProjects.workspace_id, targetWsId),
                  ),
                )
                .orderBy(desc(wpnProjects.sort_index))
                .limit(1)
            )[0]?.s ?? -1) + 1
          : 0;

      for (const projEntry of wsEntry.projects) {
        const newProjId = randomUUID();
        await db().insert(wpnProjects).values({
          id: newProjId,
          userId,
          orgId: targetOrgId ?? null,
          spaceId: targetSpaceId ?? null,
          workspace_id: targetWsId,
          name: projEntry.name,
          sort_index: nextProjSortIndex++,
          color_token: projEntry.color_token ?? null,
          created_at_ms: t,
          updated_at_ms: t,
          settings: {} as unknown,
        });
        importedProj++;

        const idMap = new Map<string, string>();
        for (const noteEntry of projEntry.notes) {
          idMap.set(noteEntry.id, randomUUID());
        }

        for (const noteEntry of projEntry.notes) {
          const newNoteId = idMap.get(noteEntry.id)!;
          const newParentId =
            noteEntry.parent_id !== null
              ? idMap.get(noteEntry.parent_id) ?? null
              : null;
          let content = noteContents.get(noteEntry.id) ?? "";
          for (const rewrite of plan.canonicalPathRewrites) {
            content = await rewriteVfsCanonicalLinksInMarkdown(
              content,
              rewrite.oldCanonical,
              rewrite.newCanonical,
            );
          }

          let metadata: Record<string, unknown> | null = noteEntry.metadata;
          if (
            noteEntry.type === "image" &&
            (noteEntry.assets?.length ?? 0) > 0 &&
            r2 &&
            targetOrgId &&
            targetSpaceId
          ) {
            try {
              metadata = await reuploadImageAsset({
                r2,
                asset: noteEntry.assets![0]!,
                assetBytes,
                sourceMetadata: noteEntry.metadata,
                orgId: targetOrgId,
                spaceId: targetSpaceId,
                workspaceId: targetWsId,
                projectId: newProjId,
                noteId: newNoteId,
              });
            } catch (err) {
              request.log.error(
                { err, noteId: newNoteId },
                "Import asset re-upload failed; note imported without bytes",
              );
              metadata = clearImageMetadataKeys(noteEntry.metadata);
            }
          } else if (
            noteEntry.type === "image" &&
            (noteEntry.assets?.length ?? 0) > 0
          ) {
            metadata = clearImageMetadataKeys(noteEntry.metadata);
          }

          await db().insert(wpnNotes).values({
            id: newNoteId,
            userId,
            orgId: targetOrgId ?? null,
            spaceId: targetSpaceId ?? null,
            project_id: newProjId,
            parent_id: newParentId,
            type: noteEntry.type,
            title: noteEntry.title,
            content,
            metadata: metadata as unknown,
            sibling_index: noteEntry.sibling_index,
            created_at_ms: t,
            updated_at_ms: t,
          });
          importedNotes++;
        }
      }
    }

    return reply.send({
      imported: {
        workspaces: importedWs,
        projects: importedProj,
        notes: importedNotes,
      } satisfies WpnImportResult,
    });
  });
}
