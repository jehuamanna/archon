import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import archiver from "archiver";
import unzipper from "unzipper";
import { requireAuth } from "./auth.js";
import {
  getWpnWorkspacesCollection,
  getWpnProjectsCollection,
  getWpnNotesCollection,
} from "./db.js";
import type {
  WpnWorkspaceDoc,
  WpnProjectDoc,
  WpnNoteDoc,
} from "./db.js";
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
import { exportMaxAssetBytes, isImageNotesFeatureEnabled } from "./server-env.js";
import { getR2Client, type R2ClientLike } from "./r2-client.js";
import { buildImageAssetKey, isAllowedImageMime } from "./image-asset-path.js";
import { rewriteVfsCanonicalLinksInMarkdown } from "./wpn-vfs-rewrite.js";

type WpnImportResult = {
  workspaces: number;
  projects: number;
  notes: number;
};

function sendErr(reply: FastifyReply, status: number, msg: string) {
  return reply.status(status).send({ error: msg });
}

function nowMs(): number {
  return Date.now();
}

function parseConflictPolicy(raw: unknown): WpnImportConflictPolicy {
  if (raw === "skip" || raw === "overwrite" || raw === "rename") return raw;
  // Default matches the PLAN-06 design note: never destroy existing data.
  return "rename";
}

async function reuploadImageAsset(args: {
  r2: R2ClientLike;
  asset: { zipPath: string; mimeType: string; sizeBytes: number; originalFilename?: string };
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

    const wsCol = getWpnWorkspacesCollection();
    const projCol = getWpnProjectsCollection();
    const noteCol = getWpnNotesCollection();

    const wsQuery: Record<string, unknown> = { userId };
    if (filterIds) wsQuery.id = { $in: filterIds };

    const wsDocs = await wsCol.find(wsQuery).sort({ sort_index: 1, name: 1 }).toArray();
    if (wsDocs.length === 0) {
      return sendErr(reply, 404, "No workspaces found to export");
    }

    const wsIds = wsDocs.map((w) => w.id);
    const projDocs = await projCol
      .find({ userId, workspace_id: { $in: wsIds } })
      .sort({ sort_index: 1, name: 1 })
      .toArray();
    const projIds = projDocs.map((p) => p.id);
    const noteDocs = await noteCol
      .find({ userId, project_id: { $in: projIds }, deleted: { $ne: true } })
      .toArray();

    const notesByProject = new Map<string, WpnNoteDoc[]>();
    for (const n of noteDocs) {
      const arr = notesByProject.get(n.project_id) ?? [];
      arr.push(n as WpnNoteDoc);
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
            metadata: n.metadata,
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

    // Streaming binaries requires the image-notes feature + R2 creds.
    // When the flag is off, v2 is still emitted but every image note's
    // metadata lacks `r2Key`, so `manifest.assets` is empty and no R2
    // fetches are attempted.
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

    // Kick off the reply before we start fetching R2 bytes so clients see
    // data immediately. Asset streaming fails closed: on any R2 error we
    // destroy both the archive and the passthrough so the client receives
    // a truncated download instead of a silently-incomplete ZIP.
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
    // Assets arrive at `assets/<noteId>/<filename>` (PLAN-06 slice 4b).
    // Key the map by the full zipPath so duplicates are surfaced as later wins,
    // matching Archiver's last-write-wins semantics on the export side.
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

    // Gather any image-asset entries up front so we can fail fast if the
    // feature flag is off (better than silently importing broken image notes).
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

    const wsCol = getWpnWorkspacesCollection();
    const projCol = getWpnProjectsCollection();
    const noteCol = getWpnNotesCollection();

    // Collision scope = workspaces owned by this user in the destination space.
    // Mirrors the stamp logic a few lines down (auth.activeSpaceId), so importing
    // `Foo` into Space B never falsely collides with a `Foo` the user owns in
    // Space A. Legacy workspaces (predating the space rollout, no `spaceId`
    // field) are still included so they continue to participate in the check.
    const wsScopeFilter = auth.activeSpaceId
      ? {
          userId,
          $or: [
            { spaceId: auth.activeSpaceId },
            { spaceId: { $exists: false } },
          ],
        }
      : { userId };
    const existingWs = await wsCol.find(wsScopeFilter).toArray();
    const plan = planImportWorkspaces({
      bundle: metadataJson,
      existingWorkspaces: existingWs.map((w) => ({ id: w.id, name: w.name })),
      policy,
    });

    const lastWs = await wsCol
      .find({ userId })
      .sort({ sort_index: -1 })
      .limit(1)
      .toArray();
    let nextWsSortIndex = (lastWs[0]?.sort_index ?? -1) + 1;

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
        targetOrgId = existing.orgId;
        targetSpaceId = existing.spaceId;
      } else {
        targetWsId = randomUUID();
        targetOrgId = auth.activeOrgId;
        targetSpaceId = auth.activeSpaceId;
        const wsDoc: WpnWorkspaceDoc = {
          id: targetWsId,
          userId,
          ...(targetOrgId ? { orgId: targetOrgId } : {}),
          ...(targetSpaceId ? { spaceId: targetSpaceId } : {}),
          name: action.chosenName,
          sort_index: nextWsSortIndex++,
          color_token: wsEntry.color_token,
          created_at_ms: t,
          updated_at_ms: t,
          settings: {},
        };
        await wsCol.insertOne(wsDoc);
        importedWs++;
      }

      let nextProjSortIndex = action.kind === "reuse"
        ? ((
            await projCol
              .find({ userId, workspace_id: targetWsId })
              .sort({ sort_index: -1 })
              .limit(1)
              .toArray()
          )[0]?.sort_index ?? -1) + 1
        : 0;

      for (const projEntry of wsEntry.projects) {
        const newProjId = randomUUID();
        const projDoc: WpnProjectDoc = {
          id: newProjId,
          userId,
          ...(targetOrgId ? { orgId: targetOrgId } : {}),
          ...(targetSpaceId ? { spaceId: targetSpaceId } : {}),
          workspace_id: targetWsId,
          name: projEntry.name,
          sort_index: nextProjSortIndex++,
          color_token: projEntry.color_token,
          created_at_ms: t,
          updated_at_ms: t,
          settings: {},
        };
        await projCol.insertOne(projDoc);
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
            // v2 bundle but we can't re-upload (missing org/space context).
            // Strip the old R2 keys so the note renders as "empty" not broken.
            metadata = clearImageMetadataKeys(noteEntry.metadata);
          }

          const noteDoc: WpnNoteDoc = {
            id: newNoteId,
            userId,
            ...(targetOrgId ? { orgId: targetOrgId } : {}),
            ...(targetSpaceId ? { spaceId: targetSpaceId } : {}),
            project_id: newProjId,
            parent_id: newParentId,
            type: noteEntry.type,
            title: noteEntry.title,
            content,
            metadata,
            sibling_index: noteEntry.sibling_index,
            created_at_ms: t,
            updated_at_ms: t,
          };
          await noteCol.insertOne(noteDoc);
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
